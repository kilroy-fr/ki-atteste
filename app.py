import os
import json
import time
import threading
import requests
from pathlib import Path
from flask import Flask, render_template, request, jsonify, Response, session
import fitz  # PyMuPDF
from docx import Document

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "change-me-in-production")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB

OLLAMA_BASE_URL = os.environ.get("OLLAMA_URL", "http://host.docker.internal:11434")
UPLOAD_FOLDER = "/app/uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Models excluded from the medical attestation tool
EXCLUDED_MODELS = {
    "nomic-embed-text:latest",
    "nomic-embed-text",
    "llama3.2:1b",
    "llama3.2:3b",
    "llama3.1:8b",
    "deepseek-r1:8b",
    "gemma4:e2b",
}

DEFAULT_MODEL = "qwen2.5:14b"

SYSTEM_PROMPT = """Du bist ein KI-Assistent für medizinische Fachkräfte. Du hilfst beim Erstellen von medizinischen Attesten, Zeugnissen, Gutachten und Berichten.

Antworte auf Deutsch, professionell und medizinisch korrekt.
Formatiere Atteste strukturiert mit den notwendigen Standardangaben (Patient, Datum, Diagnose, Befund, Empfehlung).
Beachte die deutschen medizinischen Konventionen und verwende korrekte Fachsprache.
Wenn Dokumente hochgeladen wurden, analysiere deren Inhalt und beziehe ihn in deine Antwort ein.
Weise darauf hin, wenn du dir bei medizinischen Sachverhalten unsicher bist."""


def _get_version():
    version_file = Path(__file__).parent / "VERSION"
    if version_file.exists():
        return version_file.read_text(encoding="utf-8").strip()
    return "0.1.0"


@app.context_processor
def inject_version():
    return {"version": _get_version()}


@app.before_request
def load_session_model():
    if "selected_model" not in session:
        cookie_model = request.cookies.get("selected_model")
        session["selected_model"] = cookie_model if cookie_model else DEFAULT_MODEL


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/models")
def api_models():
    try:
        resp = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
        resp.raise_for_status()
        all_models = resp.json().get("models", [])
        filtered = [
            m["name"]
            for m in all_models
            if m["name"] not in EXCLUDED_MODELS
            and not any(m["name"].startswith(ex.split(":")[0] + ":") and m["name"] in EXCLUDED_MODELS for ex in EXCLUDED_MODELS)
        ]
        current = session.get("selected_model", DEFAULT_MODEL)
        if current not in filtered and filtered:
            current = filtered[0]
        return jsonify({"models": filtered, "selected": current})
    except Exception as e:
        return jsonify({"models": [], "selected": DEFAULT_MODEL, "error": str(e)})


@app.route("/api/set_model", methods=["POST"])
def set_model():
    data = request.get_json() or {}
    model = data.get("model", DEFAULT_MODEL)
    session["selected_model"] = model
    resp = jsonify({"ok": True, "model": model})
    resp.set_cookie("selected_model", model, max_age=60 * 60 * 24 * 365)
    return resp


def extract_text_from_file(file_storage):
    filename = file_storage.filename.lower()
    try:
        if filename.endswith(".pdf"):
            data = file_storage.read()
            doc = fitz.open(stream=data, filetype="pdf")
            text = "\n\n".join(page.get_text() for page in doc)
            doc.close()
            return text.strip()
        elif filename.endswith(".docx"):
            data = file_storage.read()
            import io
            doc = Document(io.BytesIO(data))
            return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
        elif filename.endswith(".txt"):
            data = file_storage.read()
            return data.decode("utf-8", errors="replace").strip()
        else:
            return f"[Datei {file_storage.filename} – kein Text extrahierbar]"
    except Exception as e:
        return f"[Fehler beim Lesen von {file_storage.filename}: {e}]"


@app.route("/chat", methods=["POST"])
def chat():
    model = session.get("selected_model", DEFAULT_MODEL)

    # Parse incoming data from multipart form
    try:
        history = json.loads(request.form.get("history", "[]"))
    except (ValueError, TypeError):
        history = []
    user_message = request.form.get("message", "").strip()

    # Extract text from uploaded files
    file_texts = []
    for f in request.files.getlist("files"):
        if f and f.filename:
            text = extract_text_from_file(f)
            file_texts.append(f"--- Datei: {f.filename} ---\n{text}")

    # Build the user content: message + file contents
    full_content = user_message
    if file_texts:
        full_content += "\n\n" + "\n\n".join(file_texts)

    if not full_content:
        return jsonify({"error": "Keine Nachricht eingegeben"}), 400

    # Build messages list for Ollama
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in history:
        role = turn.get("role", "user")
        content = turn.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": full_content})

    def generate():
        try:
            resp = requests.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json={"model": model, "messages": messages, "stream": True},
                stream=True,
                timeout=120,
            )
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                    token = chunk.get("message", {}).get("content", "")
                    if token:
                        yield f"data: {json.dumps({'token': token})}\n\n"
                    if chunk.get("done"):
                        yield f"data: {json.dumps({'done': True})}\n\n"
                        return
                except (ValueError, KeyError):
                    continue
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(generate(), mimetype="text/event-stream",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True, use_reloader=True)
