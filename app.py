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
import json
import io
import logging

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
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL   = "llama3-8b-8192"
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}

# ── Load model at startup ─────────────────────────────────────────────────────
log.info("Loading model …")
model = tf.keras.models.load_model(MODEL_PATH)
log.info("Model loaded.")

with open(LABELS_PATH) as f:
    _indices = json.load(f)                            # {"Apple___Apple_scab": 0, …}
CLASS_LABELS = {int(v): k for k, v in _indices.items()}
log.info("Labels loaded — %d classes.", len(CLASS_LABELS))

# ── Flask ─────────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024   # 10 MB

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


def parse_label(raw: str) -> dict:
    parts   = raw.split("___", 1)
    plant   = parts[0].replace("_", " ")
    disease = (parts[1] if len(parts) > 1 else "Unknown").replace("_", " ")
    return {"plant": plant, "disease": disease, "is_healthy": "healthy" in disease.lower()}


def get_recommendations(plant: str, disease: str, is_healthy: bool) -> dict:
    if not GROQ_API_KEY:
        return {"error": "GROQ_API_KEY not set. Add it to your environment variables."}

    if is_healthy:
        prompt = f"""
The plant "{plant}" is healthy. Provide advice to keep it that way.
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

        return json.loads(raw_text)

    except requests.exceptions.Timeout:
        return {"error": "Groq API timed out. Please try again."}
    except requests.exceptions.HTTPError as e:
        return {"error": f"Groq API error: {e.response.status_code}"}
    except json.JSONDecodeError:
        return {"error": "Could not parse Groq response as JSON."}
    except Exception as e:
        return {"error": f"Unexpected error: {str(e)}"}


def run_inference(file_bytes: bytes, top_k: int) -> list:
    img_array   = preprocess(file_bytes)
    preds       = model.predict(img_array, verbose=0)[0]
    top_indices = np.argsort(preds)[::-1][:top_k]
    return [
        {
            "confidence":     round(float(preds[i]), 6),
            "confidence_pct": f"{preds[i] * 100:.1f}%",
            **parse_label(CLASS_LABELS[int(i)]),
            "raw_label": CLASS_LABELS[int(i)],
        }
        for i in top_indices
    ]


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
    """Serve the frontend."""
    return render_template("index.html")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status":       "ok",
        "num_classes":  len(CLASS_LABELS),
        "groq_api_set": bool(GROQ_API_KEY),
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