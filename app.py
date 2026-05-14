import io
import os
import json
import time
import uuid
import threading
import requests
from pathlib import Path
from flask import Flask, render_template, request, jsonify, Response, session
import fitz  # PyMuPDF
import pytesseract
from PIL import Image
from docx import Document

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "change-me-in-production")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB

OLLAMA_BASE_URL = os.environ.get("OLLAMA_URL", "http://host.docker.internal:11434")
UPLOAD_FOLDER = "/app/uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

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

_PROMPT_FILE = Path(__file__).parent / "prompts" / "system_prompt.md"
SYSTEM_PROMPT = _PROMPT_FILE.read_text(encoding="utf-8").strip()

# ---- Deckblatt-Erkennung (wie im ocr-service) ----
_COVER_KEYWORDS = [
    "fax", "deckblatt", "faxnummer", "telefax", "fax-deckblatt", "faxseiten", "faxgerät",
    "scandatei", "iq4docs", "notificationservice", "followme.print",
    "automatisch generiert", "automatisch von", "scandatei von",
]
_EMAIL_HEADERS = ["von:", "an:", "betreff:", "gesendet:"]

def _is_cover_page(text: str) -> bool:
    lower = text.lower()
    if any(kw in lower for kw in _COVER_KEYWORDS):
        return True
    return sum(1 for h in _EMAIL_HEADERS if h in lower) >= 3

# ---- OCR-Jobs (In-Memory) ----
# {job_id: {"status": "pending"|"done"|"error", "text": str}}
_ocr_jobs: dict = {}
_ocr_lock = threading.Lock()


def _ocr_run(job_id: str, data: bytes, filename: str) -> None:
    fn = filename.lower()
    try:
        if fn.endswith((".jpg", ".jpeg")):
            img = Image.open(io.BytesIO(data))
            text = pytesseract.image_to_string(img, lang="deu").strip()

        elif fn.endswith(".pdf"):
            doc = fitz.open(stream=data, filetype="pdf")
            num_pages = len(doc)
            if num_pages == 0:
                doc.close()
                with _ocr_lock:
                    _ocr_jobs[job_id] = {"status": "done", "text": ""}
                return

            # Entscheide: Textbasiert oder bildbasiert?
            total_chars = sum(len((p.get_text() or "").strip()) for p in doc)
            if total_chars >= 100:
                page_texts = [(p.get_text() or "").strip() for p in doc]
            else:
                # Bildbasiertes PDF: Seiten rendern und OCR
                page_texts = []
                for p in doc:
                    mat = fitz.Matrix(2, 2)
                    pix = p.get_pixmap(matrix=mat)
                    img = Image.open(io.BytesIO(pix.tobytes("png")))
                    page_texts.append(pytesseract.image_to_string(img, lang="deu"))

            doc.close()

            # Deckblatt überspringen
            start = 0
            if num_pages > 1 and _is_cover_page(page_texts[0]):
                start = 1
            text = "\n\n".join(page_texts[start:]).strip()

        else:
            text = ""

        with _ocr_lock:
            _ocr_jobs[job_id] = {"status": "done", "text": text}

    except Exception as e:
        with _ocr_lock:
            _ocr_jobs[job_id] = {"status": "error", "text": f"[OCR-Fehler: {e}]"}


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


# ---- OCR-Endpoint: Datei hochladen, Job starten ----
@app.route("/api/ocr", methods=["POST"])
def api_ocr_start():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "Keine Datei"}), 400

    data = f.read()
    job_id = str(uuid.uuid4())

    with _ocr_lock:
        _ocr_jobs[job_id] = {"status": "pending", "text": ""}

    t = threading.Thread(target=_ocr_run, args=(job_id, data, f.filename), daemon=True)
    t.start()

    return jsonify({"job_id": job_id})


# ---- OCR-Status pollen ----
@app.route("/api/ocr/<job_id>")
def api_ocr_status(job_id):
    with _ocr_lock:
        job = _ocr_jobs.get(job_id)
    if not job:
        return jsonify({"status": "not_found"}), 404
    return jsonify(job)


def extract_text_from_file(file_storage):
    filename = file_storage.filename.lower()
    try:
        if filename.endswith(".pdf"):
            data = file_storage.read()
            doc = fitz.open(stream=data, filetype="pdf")
            num_pages = len(doc)
            if num_pages == 0:
                doc.close()
                return ""
            page_texts = [(p.get_text() or "").strip() for p in doc]
            doc.close()
            start = 0
            if num_pages > 1 and _is_cover_page(page_texts[0]):
                start = 1
            return "\n\n".join(page_texts[start:]).strip()
        elif filename.endswith(".docx"):
            data = file_storage.read()
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
    model = request.form.get("model") or session.get("selected_model", DEFAULT_MODEL)

    try:
        history = json.loads(request.form.get("history", "[]"))
    except (ValueError, TypeError):
        history = []
    user_message = request.form.get("message", "").strip()

    # Vom Frontend vorextrahierte OCR-Texte (Dateiname → Text)
    try:
        pre_extracted = json.loads(request.form.get("pre_extracted_texts", "{}"))
    except (ValueError, TypeError):
        pre_extracted = {}

    file_texts = []

    # Vorextrahierte Texte zuerst einbauen
    for fname, text in pre_extracted.items():
        if text:
            file_texts.append(f"--- Datei: {fname} ---\n{text}")

    # Direkt übermittelte Dateien (DOCX, TXT, Fallback)
    for f in request.files.getlist("files"):
        if f and f.filename:
            text = extract_text_from_file(f)
            file_texts.append(f"--- Datei: {f.filename} ---\n{text}")

    if file_texts:
        full_content = "\n\n".join(file_texts) + "\n\n---\nAufgabe: " + user_message
    else:
        full_content = user_message

    if not full_content:
        return jsonify({"error": "Keine Nachricht eingegeben"}), 400

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
