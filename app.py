"""
LeafScan — Plant Disease Detection + AI Recommendations
=========================================================
Flask backend that:
  - Serves the frontend (templates/index.html + static/)
  - POST /analyze  → MobileNetV2 prediction + Groq recommendations
  - POST /predict  → prediction only (fast)
  - GET  /health   → health check
  - GET  /classes  → all disease classes

Environment variable required:
  GROQ_API_KEY  — https://console.groq.com

Files required alongside this app:
  plant_disease_model.h5
  class_labels.json
"""

import os
import re
import json
import io
import logging
from dotenv import load_dotenv
load_dotenv()

import numpy as np
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from werkzeug.utils import secure_filename
from PIL import Image
import tensorflow as tf
import requests

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"

# ── Config ────────────────────────────────────────────────────────────────────
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH   = os.path.join(BASE_DIR, "plant_disease_model.h5")
LABELS_PATH  = os.path.join(BASE_DIR, "class_labels.json")
IMG_SIZE     = (224, 224)
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL   = "llama-3.3-70b-versatile"
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}

# ── Load model at startup ─────────────────────────────────────────────────────
log.info("Loading model …")
model = tf.keras.models.load_model(MODEL_PATH)
log.info("Model loaded.")

with open(LABELS_PATH) as f:
    _indices = json.load(f)                            # {"Tomato_Late_blight": 7, …}
CLASS_LABELS = {int(v): k for k, v in _indices.items()}
log.info("Labels loaded — %d classes.", len(CLASS_LABELS))

# ── Flask ─────────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024   # 10 MB


# ══════════════════════════════════════════════════════════════════════════════
#  LABEL PARSING
#
#  The class_labels.json uses THREE different underscore formats:
#
#  Format A  ─ triple underscore separator (PlantVillage standard):
#    "Pepper__bell___Bacterial_spot"        → plant="Pepper Bell"   disease="Bacterial Spot"
#    "Pepper__bell___healthy"               → plant="Pepper Bell"   disease="Healthy"
#    "Potato___Early_blight"                → plant="Potato"        disease="Early Blight"
#
#  Format B  ─ double underscore prefix, disease follows plant name:
#    "Tomato__Target_Spot"                  → plant="Tomato"        disease="Target Spot"
#    "Tomato__Tomato_YellowLeaf__Curl_Virus"→ plant="Tomato"        disease="Yellow Leaf Curl Virus"
#    "Tomato__Tomato_mosaic_virus"          → plant="Tomato"        disease="Tomato Mosaic Virus"
#
#  Format C  ─ plain single underscore, first token = plant:
#    "Tomato_Bacterial_spot"                → plant="Tomato"        disease="Bacterial Spot"
#    "Tomato_Early_blight"                  → plant="Tomato"        disease="Early Blight"
#    "Tomato_Leaf_Mold"                     → plant="Tomato"        disease="Leaf Mold"
#    "Tomato_Septoria_leaf_spot"            → plant="Tomato"        disease="Septoria Leaf Spot"
#    "Tomato_Spider_mites_Two_spotted_spider_mite" → plant="Tomato" disease="Spider Mites Two Spotted Spider Mite"
#    "Tomato_healthy"                       → plant="Tomato"        disease="Healthy"
#    "Potato___healthy"                     → plant="Potato"        disease="Healthy"
#
# ══════════════════════════════════════════════════════════════════════════════

def _clean(text: str) -> str:
    """Split CamelCase, replace underscores with spaces, collapse whitespace, title-case."""
    # Split CamelCase: "YellowLeaf" → "Yellow Leaf"
    text = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)
    text = re.sub(r'_+', ' ', text).strip()
    text = re.sub(r' +', ' ', text)
    return text.title()


def parse_label(raw: str) -> dict:
    """
    Parse any label format present in the provided class_labels.json.

    Returns dict with keys: plant (str), disease (str), is_healthy (bool).
    """

    # ── Format A: triple underscore "___" ─────────────────────────────────────
    if "___" in raw:
        plant_raw, disease_raw = raw.split("___", 1)
        plant   = _clean(plant_raw)
        disease = _clean(disease_raw) if disease_raw.strip("_") else "Healthy"

    # ── Format B: double underscore "__" (but no triple) ──────────────────────
    elif "__" in raw:
        # Split on first "__"
        plant_raw, disease_raw = raw.split("__", 1)
        plant = _clean(plant_raw)

        # Strip any leading duplicate of the plant name from the disease part
        # e.g. "Tomato__Tomato_mosaic_virus" → disease_raw="Tomato_mosaic_virus"
        #      strip leading "Tomato_"       → "mosaic_virus" → "Mosaic Virus"
        # e.g. "Tomato__Tomato_YellowLeaf__Curl_Virus"
        #      disease_raw = "Tomato_YellowLeaf__Curl_Virus"
        #      strip leading "Tomato_"       → "YellowLeaf__Curl_Virus"
        #      replace remaining "__"        → "YellowLeaf Curl Virus"
        plant_prefix = plant_raw.rstrip("_") + "_"
        if disease_raw.startswith(plant_prefix):
            disease_raw = disease_raw[len(plant_prefix):]

        # Flatten any remaining double underscores before cleaning
        disease_raw = re.sub(r'__+', '_', disease_raw)
        disease = _clean(disease_raw) if disease_raw.strip("_") else "Healthy"

    # ── Format C: plain single underscore — first token is plant ──────────────
    else:
        tokens  = raw.split("_")
        plant   = tokens[0].strip().title()
        disease = _clean("_".join(tokens[1:])) if len(tokens) > 1 else "Healthy"

    # Guard: empty disease → Healthy
    if not disease or not disease.strip():
        disease = "Healthy"

    is_healthy = "healthy" in disease.lower()

    log.info("parse_label | %-50s → plant=%-15s disease=%-35s healthy=%s",
             repr(raw), repr(plant), repr(disease), is_healthy)

    return {"plant": plant, "disease": disease, "is_healthy": is_healthy}


# ── Quick self-test on startup ─────────────────────────────────────────────────
def _self_test_parse_label():
    cases = {
        "Pepper__bell___Bacterial_spot":          ("Pepper  Bell",  "Bacterial Spot",              False),
        "Pepper__bell___healthy":                 ("Pepper  Bell",  "Healthy",                     True),
        "Potato___Early_blight":                  ("Potato",        "Early Blight",                False),
        "Potato___Late_blight":                   ("Potato",        "Late Blight",                 False),
        "Potato___healthy":                       ("Potato",        "Healthy",                     True),
        "Tomato_Bacterial_spot":                  ("Tomato",        "Bacterial Spot",              False),
        "Tomato_Early_blight":                    ("Tomato",        "Early Blight",                False),
        "Tomato_Late_blight":                     ("Tomato",        "Late Blight",                 False),
        "Tomato_Leaf_Mold":                       ("Tomato",        "Leaf Mold",                   False),
        "Tomato_Septoria_leaf_spot":              ("Tomato",        "Septoria Leaf Spot",          False),
        "Tomato_Spider_mites_Two_spotted_spider_mite": ("Tomato",  "Spider Mites Two Spotted Spider Mite", False),
        "Tomato__Target_Spot":                    ("Tomato",        "Target Spot",                 False),
        "Tomato__Tomato_YellowLeaf__Curl_Virus":  ("Tomato",        "Yellow Leaf Curl Virus",      False),
        "Tomato__Tomato_mosaic_virus":            ("Tomato",        "Tomato Mosaic Virus",         False),
        "Tomato_healthy":                         ("Tomato",        "Healthy",                     True),
    }
    all_ok = True
    for raw, (exp_plant, exp_disease, exp_healthy) in cases.items():
        result = parse_label(raw)
        ok = result["is_healthy"] == exp_healthy
        status = "OK " if ok else "ERR"
        if not ok:
            all_ok = False
        log.info("[parse_label test] %s  %-50s → plant=%s  disease=%s",
                 status, repr(raw), result["plant"], result["disease"])
    if all_ok:
        log.info("parse_label self-test: ALL PASSED ✓")
    else:
        log.warning("parse_label self-test: some cases FAILED — check logs above")

_self_test_parse_label()


# ══════════════════════════════════════════════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def preprocess(file_bytes: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
    img = img.resize(IMG_SIZE, Image.LANCZOS)
    arr = np.array(img, dtype=np.float32) / 255.0
    return np.expand_dims(arr, axis=0)


def get_recommendations(plant: str, disease: str, is_healthy: bool) -> dict:
    if not GROQ_API_KEY:
        return {"error": "GROQ_API_KEY not set. Add it to your environment variables."}

    if is_healthy:
        prompt = f"""
The plant "{plant}" appears healthy. Provide advice to keep it that way.
Respond ONLY with a valid JSON object — no markdown, no extra text.
Use this exact structure:
{{
  "treatment": "No treatment needed.",
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
Respond ONLY with a valid JSON object — no markdown, no extra text.
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
        "max_tokens": 800,
    }

    try:
        resp = requests.post(GROQ_API_URL, headers=headers, json=payload, timeout=30)
        resp.raise_for_status()
        raw_text = resp.json()["choices"][0]["message"]["content"].strip()

        if raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1]
            if raw_text.startswith("json"):
                raw_text = raw_text[4:]
        raw_text = raw_text.strip()

        return json.loads(raw_text)

    except requests.exceptions.Timeout:
        return {"error": "Groq API timed out. Please try again."}
    except requests.exceptions.HTTPError as e:
        status_code = e.response.status_code
        try:
            detail = e.response.json()
        except Exception:
            detail = e.response.text
        log.error("Groq HTTP %s: %s", status_code, detail)
        return {"error": f"Groq API error: {status_code} — {detail}"}
    except json.JSONDecodeError as e:
        log.error("Groq JSON decode error: %s | raw_text=%r", e, raw_text)
        return {"error": "Could not parse Groq response as JSON."}
    except Exception as e:
        log.error("Unexpected Groq error: %s", e)
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
    """Returns (file_bytes, error_response, status_code)."""
    if "image" not in request_.files:
        return None, jsonify({"error": "No 'image' field in request."}), 400
    file = request_.files["image"]
    if not file.filename:
        return None, jsonify({"error": "Empty filename."}), 400
    if not allowed_file(file.filename):
        return None, jsonify({"error": f"Unsupported file type. Allowed: {ALLOWED_EXTENSIONS}"}), 415
    return file.read(), None, None


# ══════════════════════════════════════════════════════════════════════════════
#  ROUTES
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
    }), 200


@app.route("/classes", methods=["GET"])
def classes():
    return jsonify({
        "num_classes": len(CLASS_LABELS),
        "classes": [{"raw": label, **parse_label(label)} for label in CLASS_LABELS.values()],
    })


@app.route("/predict", methods=["POST"])
def predict():
    """Fast prediction only — no recommendations."""
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
    """Full analysis: prediction + Groq AI recommendations."""
    file_bytes, err, status = validate_image(request)
    if err:
        return err, status

    top_k = min(int(request.args.get("top_k", 3)), 10)

    try:
        results = run_inference(file_bytes, top_k)
    except Exception as e:
        log.error("Inference error: %s", e)
        return jsonify({"error": f"Inference failed: {e}"}), 422

    top  = results[0]
    recs = get_recommendations(top["plant"], top["disease"], top["is_healthy"])

    return jsonify({
        "filename":        secure_filename(request.files["image"].filename),
        "prediction":      top,
        "top_k":           results,
        "recommendations": recs,
    })


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