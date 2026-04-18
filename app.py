"""
LeafScan — Plant Disease Detection + AI Recommendations + Auth + Chat
======================================================================
Flask backend that:
  - Serves the frontend (templates/index.html + static/)
  - POST /analyze        → MobileNetV2 prediction + Groq recommendations
  - POST /predict        → prediction only (fast)
  - GET  /health         → health check
  - GET  /classes        → all disease classes

  [NEW] POST /auth/register   → register user (MongoDB)
  [NEW] POST /auth/login      → login, returns JWT
  [NEW] POST /auth/google     → Google OAuth token verify + login/register
  [NEW] GET  /auth/me         → return current user info
  [NEW] POST /history/save    → save analysis to MongoDB
  [NEW] GET  /history/list    → get user's history from MongoDB
  [NEW] DELETE /history/<id>  → delete a history record
  [NEW] POST /chat            → AI chatbot via Groq

Environment variables required:
  GROQ_API_KEY          — https://console.groq.com
  MONGO_URI             — MongoDB connection string (e.g. mongodb://localhost:27017)
  JWT_SECRET            — secret key for signing JWTs
  GOOGLE_CLIENT_ID      — Google OAuth2 Client ID (optional, for Google login)

Files required alongside this app:
  plant_disease_model.h5
  class_labels.json
"""

import os
import re
import json
import io
import logging
import hashlib
import hmac
import base64
import time
from datetime import datetime, timezone
from functools import wraps

from dotenv import load_dotenv
load_dotenv()

import numpy as np
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from werkzeug.utils import secure_filename
from PIL import Image
import tensorflow as tf
import requests

# ── Optional MongoDB ────────────────────────────────────────────────────────────
try:
    from pymongo import MongoClient
    from bson import ObjectId
    MONGO_AVAILABLE = True
except ImportError:
    MONGO_AVAILABLE = False

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"

# ── Config ─────────────────────────────────────────────────────────────────────
BASE_DIR          = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH        = os.path.join(BASE_DIR, "plant_disease_model.h5")
LABELS_PATH       = os.path.join(BASE_DIR, "class_labels.json")
IMG_SIZE          = (224, 224)
GROQ_API_KEY      = os.environ.get("GROQ_API_KEY")
GROQ_API_URL      = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL        = "llama-3.3-70b-versatile"
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}
MONGO_URI         = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
JWT_SECRET        = os.environ.get("JWT_SECRET", "leafscan_secret_change_in_production")
GOOGLE_CLIENT_ID  = os.environ.get("GOOGLE_CLIENT_ID", "")

# ── Load model ─────────────────────────────────────────────────────────────────
log.info("Loading model …")
model = tf.keras.models.load_model(MODEL_PATH)
log.info("Model loaded.")

with open(LABELS_PATH) as f:
    _indices = json.load(f)
CLASS_LABELS = {int(v): k for k, v in _indices.items()}
log.info("Labels loaded — %d classes.", len(CLASS_LABELS))

# ── MongoDB ────────────────────────────────────────────────────────────────────
db = None
if MONGO_AVAILABLE:
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        client.server_info()
        db = client["leafscan"]
        db["users"].create_index("email", unique=True)
        log.info("MongoDB connected.")
    except Exception as e:
        log.warning("MongoDB not available: %s — auth will be unavailable.", e)
        db = None

# ── Flask ──────────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10 MB


# ══════════════════════════════════════════════════════════════════════════════
#  LABEL PARSING  (unchanged from original)
# ══════════════════════════════════════════════════════════════════════════════

def _clean(text: str) -> str:
    text = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)
    text = re.sub(r'_+', ' ', text).strip()
    text = re.sub(r' +', ' ', text)
    return text.title()


def parse_label(raw: str) -> dict:
    if "___" in raw:
        plant_raw, disease_raw = raw.split("___", 1)
        plant   = _clean(plant_raw)
        disease = _clean(disease_raw) if disease_raw.strip("_") else "Healthy"
    elif "__" in raw:
        plant_raw, disease_raw = raw.split("__", 1)
        plant = _clean(plant_raw)
        plant_prefix = plant_raw.rstrip("_") + "_"
        if disease_raw.startswith(plant_prefix):
            disease_raw = disease_raw[len(plant_prefix):]
        disease_raw = re.sub(r'__+', '_', disease_raw)
        disease = _clean(disease_raw) if disease_raw.strip("_") else "Healthy"
    else:
        tokens  = raw.split("_")
        plant   = tokens[0].strip().title()
        disease = _clean("_".join(tokens[1:])) if len(tokens) > 1 else "Healthy"

    if not disease or not disease.strip():
        disease = "Healthy"
    is_healthy = "healthy" in disease.lower()
    return {"plant": plant, "disease": disease, "is_healthy": is_healthy}


def _self_test_parse_label():
    cases = {
        "Pepper__bell___Bacterial_spot":          ("Pepper Bell",  "Bacterial Spot",                       False),
        "Pepper__bell___healthy":                 ("Pepper Bell",  "Healthy",                              True),
        "Potato___Early_blight":                  ("Potato",       "Early Blight",                         False),
        "Tomato__Target_Spot":                    ("Tomato",       "Target Spot",                          False),
        "Tomato__Tomato_YellowLeaf__Curl_Virus":  ("Tomato",       "Yellow Leaf Curl Virus",               False),
        "Tomato__Tomato_mosaic_virus":            ("Tomato",       "Tomato Mosaic Virus",                  False),
        "Tomato_healthy":                         ("Tomato",       "Healthy",                              True),
    }
    all_ok = True
    for raw, (_, _, exp_healthy) in cases.items():
        result = parse_label(raw)
        ok = result["is_healthy"] == exp_healthy
        if not ok:
            all_ok = False
            log.warning("[parse_label test] FAIL %s", repr(raw))
    if all_ok:
        log.info("parse_label self-test: ALL PASSED ✓")

_self_test_parse_label()


# ══════════════════════════════════════════════════════════════════════════════
#  JWT UTILITIES  (simple HS256 without PyJWT dependency)
# ══════════════════════════════════════════════════════════════════════════════

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()

def _b64url_decode(s: str) -> bytes:
    pad = 4 - len(s) % 4
    return base64.urlsafe_b64decode(s + '=' * (pad % 4))

def create_jwt(payload: dict, expires_in: int = 86400) -> str:
    header  = _b64url_encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = dict(payload)
    payload["exp"] = int(time.time()) + expires_in
    payload["iat"] = int(time.time())
    body    = _b64url_encode(json.dumps(payload).encode())
    sig_input = f"{header}.{body}".encode()
    sig = _b64url_encode(hmac.new(JWT_SECRET.encode(), sig_input, hashlib.sha256).digest())
    return f"{header}.{body}.{sig}"

def verify_jwt(token: str) -> dict | None:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        header, body, sig = parts
        sig_input = f"{header}.{body}".encode()
        expected_sig = _b64url_encode(hmac.new(JWT_SECRET.encode(), sig_input, hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected_sig):
            return None
        payload = json.loads(_b64url_decode(body))
        if payload.get("exp", 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None

def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        token = None
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
        if not token:
            token = request.cookies.get("leafscan_token")
        if not token:
            return jsonify({"error": "Unauthorized"}), 401
        payload = verify_jwt(token)
        if not payload:
            return jsonify({"error": "Invalid or expired token"}), 401
        request.user_id    = payload.get("sub")
        request.user_email = payload.get("email")
        request.user_name  = payload.get("name")
        return f(*args, **kwargs)
    return wrapper


# ══════════════════════════════════════════════════════════════════════════════
#  PASSWORD HASHING
# ══════════════════════════════════════════════════════════════════════════════

def hash_password(password: str) -> str:
    salt = os.urandom(16).hex()
    h    = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 260000).hex()
    return f"{salt}:{h}"

def verify_password(password: str, stored: str) -> bool:
    try:
        salt, h = stored.split(":", 1)
        return hmac.compare_digest(
            hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 260000).hex(), h
        )
    except Exception:
        return False


# ══════════════════════════════════════════════════════════════════════════════
#  ANALYSIS HELPERS  (unchanged from original)
# ══════════════════════════════════════════════════════════════════════════════

def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

def preprocess(file_bytes: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
    img = img.resize(IMG_SIZE, Image.LANCZOS)
    arr = np.array(img, dtype=np.float32) / 255.0
    return np.expand_dims(arr, 0)

def get_recommendations(plant: str, disease: str, is_healthy: bool, lang: str = "en") -> dict:
    if not GROQ_API_KEY:
        return {"error": "GROQ_API_KEY not configured."}

    lang_instruction = ""
    if lang and lang != "en":
        lang_names = {
            "hi": "Hindi", "bn": "Bengali", "ta": "Tamil", "te": "Telugu",
            "es": "Spanish", "fr": "French", "ar": "Arabic",
        }
        lang_name = lang_names.get(lang, "English")
        lang_instruction = f"\nIMPORTANT: Respond entirely in {lang_name}."

    if is_healthy:
        prompt = f"""
The plant "{plant}" appears healthy.
Provide general preventive care recommendations.
Respond ONLY with a valid JSON object — no markdown, no extra text.{lang_instruction}
Use this exact structure:
{{
  "treatment": "General preventive care advice",
  "pesticides": ["list of preventive pesticides or 'None required'"],
  "fertilizers": ["list of recommended fertilizers with usage tips"],
  "care_tips": ["list of 3-5 care tips to maintain plant health"]
}}
"""
    else:
        prompt = f"""
A plant disease has been detected:
  Plant  : {plant}
  Disease: {disease}

Provide detailed agricultural recommendations.
Respond ONLY with a valid JSON object — no markdown, no extra text.{lang_instruction}
Use this exact structure:
{{
  "treatment": "Step-by-step treatment instructions",
  "pesticides": ["pesticide 1 with dosage", "pesticide 2 with dosage"],
  "fertilizers": ["fertilizer 1 with usage", "fertilizer 2 with usage"],
  "care_tips": ["tip 1", "tip 2", "tip 3"]
}}
"""

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type":  "application/json",
    }
    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an expert agricultural scientist. "
                    "Give precise, practical recommendations for plant disease management. "
                    "Always respond with valid JSON only — no explanation, no markdown fences."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
        "max_tokens":  800,
    }

    try:
        resp = requests.post(GROQ_API_URL, headers=headers, json=payload, timeout=30)
        resp.raise_for_status()
        raw_text = resp.json()["choices"][0]["message"]["content"].strip()
        if raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1]
            if raw_text.startswith("json"):
                raw_text = raw_text[4:]
        return json.loads(raw_text.strip())
    except requests.exceptions.Timeout:
        return {"error": "Groq API timed out."}
    except requests.exceptions.HTTPError as e:
        return {"error": f"Groq API error: {e.response.status_code}"}
    except json.JSONDecodeError:
        return {"error": "Could not parse Groq response."}
    except Exception as e:
        return {"error": f"Unexpected error: {str(e)}"}


def run_inference(file_bytes: bytes, top_k: int) -> list:
    img_array   = preprocess(file_bytes)
    preds       = model.predict(img_array, verbose=0)[0]
    top_indices = np.argsort(preds)[::-1][:top_k]
    results = []
    for i in top_indices:
        raw_label = CLASS_LABELS[int(i)]
        parsed    = parse_label(raw_label)
        results.append({
            "confidence":     round(float(preds[i]), 6),
            "confidence_pct": f"{preds[i] * 100:.1f}%",
            **parsed,
            "raw_label": raw_label,
        })
    return results


def validate_image(request_):
    if "image" not in request_.files:
        return None, jsonify({"error": "No 'image' field in request."}), 400
    file = request_.files["image"]
    if not file.filename:
        return None, jsonify({"error": "Empty filename."}), 400
    if not allowed_file(file.filename):
        return None, jsonify({"error": f"Unsupported file type. Allowed: {ALLOWED_EXTENSIONS}"}), 415
    return file.read(), None, None


# ══════════════════════════════════════════════════════════════════════════════
#  EXISTING ROUTES  (completely unchanged)
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/", methods=["GET"])
def index():
    return render_template("index.html")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status":       "ok",
        "num_classes":  len(CLASS_LABELS),
        "groq_api_set": bool(GROQ_API_KEY),
        "groq_model":   GROQ_MODEL,
        "mongodb":      db is not None,
    }), 200


@app.route("/classes", methods=["GET"])
def classes():
    return jsonify({
        "num_classes": len(CLASS_LABELS),
        "classes": [{"raw": label, **parse_label(label)} for label in CLASS_LABELS.values()],
    })


@app.route("/predict", methods=["POST"])
def predict():
    file_bytes, err, status = validate_image(request)
    if err:
        return err, status
    top_k = min(int(request.args.get("top_k", 3)), 10)
    try:
        results = run_inference(file_bytes, top_k)
    except Exception as e:
        log.error("Inference error: %s", e)
        return jsonify({"error": f"Inference failed: {e}"}), 422
    return jsonify({
        "filename":   secure_filename(request.files["image"].filename),
        "prediction": results[0],
        "top_k":      results,
    })


@app.route("/analyze", methods=["POST"])
def analyze():
    file_bytes, err, status = validate_image(request)
    if err:
        return err, status
    top_k = min(int(request.args.get("top_k", 3)), 10)
    lang  = request.args.get("lang", "en")
    try:
        results = run_inference(file_bytes, top_k)
    except Exception as e:
        log.error("Inference error: %s", e)
        return jsonify({"error": f"Inference failed: {e}"}), 422
    top  = results[0]
    recs = get_recommendations(top["plant"], top["disease"], top["is_healthy"], lang=lang)
    return jsonify({
        "filename":        secure_filename(request.files["image"].filename),
        "prediction":      top,
        "top_k":           results,
        "recommendations": recs,
    })


# ══════════════════════════════════════════════════════════════════════════════
#  [NEW] AUTH ROUTES
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/auth/register", methods=["POST"])
def auth_register():
    if db is None:
        return jsonify({"error": "Database not available."}), 503
    data = request.get_json(silent=True) or {}
    name  = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    pw    = data.get("password") or ""

    if not name or not email or not pw:
        return jsonify({"error": "Name, email, and password are required."}), 400
    if not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', email):
        return jsonify({"error": "Invalid email address."}), 400
    if len(pw) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400

    if db["users"].find_one({"email": email}):
        return jsonify({"error": "Email already registered."}), 409

    user_doc = {
        "name":       name,
        "email":      email,
        "password":   hash_password(pw),
        "provider":   "email",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "picture":    None,
    }
    result = db["users"].insert_one(user_doc)
    user_id = str(result.inserted_id)

    token = create_jwt({"sub": user_id, "email": email, "name": name})
    return jsonify({
        "token": token,
        "user":  {"id": user_id, "name": name, "email": email, "picture": None},
    }), 201


@app.route("/auth/login", methods=["POST"])
def auth_login():
    if db is None:
        return jsonify({"error": "Database not available."}), 503
    data  = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    pw    = data.get("password") or ""

    if not email or not pw:
        return jsonify({"error": "Email and password are required."}), 400

    user = db["users"].find_one({"email": email})
    if not user:
        return jsonify({"error": "Invalid email or password."}), 401
    if user.get("provider") == "google":
        return jsonify({"error": "This account uses Google Sign-In. Please login with Google."}), 401
    if not verify_password(pw, user.get("password", "")):
        return jsonify({"error": "Invalid email or password."}), 401

    user_id = str(user["_id"])
    token   = create_jwt({"sub": user_id, "email": email, "name": user.get("name", "")})
    return jsonify({
        "token": token,
        "user":  {"id": user_id, "name": user.get("name"), "email": email, "picture": user.get("picture")},
    })


@app.route("/auth/google", methods=["POST"])
def auth_google():
    """Verify Google ID token, create/login user in MongoDB."""
    if db is None:
        return jsonify({"error": "Database not available."}), 503

    data       = request.get_json(silent=True) or {}
    id_token   = data.get("credential") or data.get("id_token") or ""
    if not id_token:
        return jsonify({"error": "No Google credential provided."}), 400

    # Verify token with Google's tokeninfo endpoint
    try:
        verify_resp = requests.get(
            f"https://oauth2.googleapis.com/tokeninfo?id_token={id_token}",
            timeout=10
        )
        verify_resp.raise_for_status()
        google_payload = verify_resp.json()
    except Exception as e:
        log.error("Google token verification failed: %s", e)
        return jsonify({"error": "Could not verify Google token."}), 401

    # Validate audience if GOOGLE_CLIENT_ID is configured
    if GOOGLE_CLIENT_ID and google_payload.get("aud") != GOOGLE_CLIENT_ID:
        return jsonify({"error": "Token audience mismatch."}), 401

    g_email   = (google_payload.get("email") or "").lower()
    g_name    = google_payload.get("name") or g_email.split("@")[0]
    g_picture = google_payload.get("picture") or None

    if not g_email:
        return jsonify({"error": "Could not extract email from Google token."}), 400

    # Upsert user
    existing = db["users"].find_one({"email": g_email})
    if existing:
        user_id = str(existing["_id"])
        # Update name/picture if changed
        db["users"].update_one({"_id": existing["_id"]}, {"$set": {"name": g_name, "picture": g_picture}})
    else:
        doc = {
            "name":       g_name,
            "email":      g_email,
            "password":   None,
            "provider":   "google",
            "picture":    g_picture,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        result  = db["users"].insert_one(doc)
        user_id = str(result.inserted_id)

    token = create_jwt({"sub": user_id, "email": g_email, "name": g_name})
    return jsonify({
        "token": token,
        "user":  {"id": user_id, "name": g_name, "email": g_email, "picture": g_picture},
    })


@app.route("/auth/me", methods=["GET"])
@require_auth
def auth_me():
    if db is None:
        return jsonify({"error": "Database not available."}), 503
    try:
        user = db["users"].find_one({"_id": ObjectId(request.user_id)})
    except Exception:
        return jsonify({"error": "User not found."}), 404
    if not user:
        return jsonify({"error": "User not found."}), 404
    return jsonify({
        "id":      str(user["_id"]),
        "name":    user.get("name"),
        "email":   user.get("email"),
        "picture": user.get("picture"),
        "created_at": user.get("created_at"),
    })


# ══════════════════════════════════════════════════════════════════════════════
#  [NEW] HISTORY ROUTES  (MongoDB-backed)
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/history/save", methods=["POST"])
@require_auth
def history_save():
    if db is None:
        return jsonify({"error": "Database not available."}), 503
    data = request.get_json(silent=True) or {}
    record = {
        "user_id":      request.user_id,
        "disease_name": data.get("diseaseName", ""),
        "plant":        data.get("plant", ""),
        "disease":      data.get("disease", ""),
        "confidence":   data.get("confidence", 0),
        "status":       data.get("status", ""),
        "severity":     data.get("severity", 0),
        "timestamp":    data.get("timestamp", int(time.time() * 1000)),
        "image_data":   data.get("imageDataURL", ""),
        "recommendations": data.get("recommendations", {}),
        "created_at":   datetime.now(timezone.utc).isoformat(),
    }
    result = db["history"].insert_one(record)
    return jsonify({"id": str(result.inserted_id)}), 201


@app.route("/history/list", methods=["GET"])
@require_auth
def history_list():
    if db is None:
        return jsonify({"history": []}), 200
    records = list(db["history"].find(
        {"user_id": request.user_id},
        sort=[("timestamp", -1)],
        limit=100,
    ))
    for r in records:
        r["id"] = str(r.pop("_id"))
    return jsonify({"history": records})


@app.route("/history/<record_id>", methods=["DELETE"])
@require_auth
def history_delete(record_id):
    if db is None:
        return jsonify({"error": "Database not available."}), 503
    try:
        result = db["history"].delete_one({"_id": ObjectId(record_id), "user_id": request.user_id})
    except Exception:
        return jsonify({"error": "Invalid record ID."}), 400
    if result.deleted_count == 0:
        return jsonify({"error": "Record not found or not authorized."}), 404
    return jsonify({"deleted": True})


# ══════════════════════════════════════════════════════════════════════════════
#  [NEW] CHATBOT ROUTE
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/chat", methods=["POST"])
def chat():
    if not GROQ_API_KEY:
        return jsonify({"reply": "Chatbot is not configured (GROQ_API_KEY missing)."}), 200

    data     = request.get_json(silent=True) or {}
    messages = data.get("messages", [])  # [{role, content}, ...]
    lang     = data.get("lang", "en")
    context  = data.get("context")       # {plant, disease, isHealthy, confidence}

    lang_names = {
        "hi": "Hindi", "bn": "Bengali", "ta": "Tamil", "te": "Telugu",
        "es": "Spanish", "fr": "French", "ar": "Arabic",
    }
    lang_instruction = ""
    if lang and lang != "en":
        lang_instruction = f" Always respond in {lang_names.get(lang, 'English')}."

    context_str = ""
    if context:
        plant    = context.get("plant", "")
        disease  = context.get("disease", "")
        healthy  = context.get("isHealthy", False)
        conf     = context.get("confidence", 0)
        if healthy:
            context_str = f"\nCurrent scan context: The user's {plant} plant appears HEALTHY with {conf}% confidence."
        else:
            context_str = f"\nCurrent scan context: The user's {plant} plant has been diagnosed with {disease} at {conf}% confidence."

    system_prompt = (
        "You are LeafScan's expert AI plant health assistant. "
        "You help farmers and gardeners with plant disease diagnosis, treatment, prevention, and care. "
        "Keep answers concise, practical, and friendly. "
        "If asked about the current scan result, use the context provided."
        f"{context_str}{lang_instruction}"
    )

    # Limit conversation history to last 10 messages to avoid token overflow
    trimmed = messages[-10:] if len(messages) > 10 else messages

    groq_messages = [{"role": "system", "content": system_prompt}] + trimmed

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type":  "application/json",
    }
    payload = {
        "model":       GROQ_MODEL,
        "messages":    groq_messages,
        "temperature": 0.6,
        "max_tokens":  500,
    }

    try:
        resp = requests.post(GROQ_API_URL, headers=headers, json=payload, timeout=30)
        resp.raise_for_status()
        reply = resp.json()["choices"][0]["message"]["content"].strip()
        return jsonify({"reply": reply})
    except requests.exceptions.Timeout:
        return jsonify({"reply": "Sorry, the response timed out. Please try again."}), 200
    except Exception as e:
        log.error("Chat error: %s", e)
        return jsonify({"reply": "Sorry, I encountered an error. Please try again."}), 200


# ── Error handlers ────────────────────────────────────────────────────────────
@app.errorhandler(413)
def too_large(e):
    return jsonify({"error": "File too large. Max 10 MB."}), 413

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Endpoint not found."}), 404

@app.errorhandler(405)
def method_not_allowed(e):
    return jsonify({"error": "Method not allowed."}), 405


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port  = int(os.environ.get("PORT", 7860))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)