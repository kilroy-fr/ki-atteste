import io
import os
import json
import time
import uuid
import threading
import requests
from pathlib import Path
from flask import Flask, render_template, request, jsonify, Response, session
import pymupdf as fitz
import pytesseract
from PIL import Image
from docx import Document

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "change-me-in-production")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB

OLLAMA_BASE_URL = os.environ.get("OLLAMA_URL", "http://host.docker.internal:11434")
OLLAMA_NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "32768"))
MAX_FILE_CHARS = int(os.environ.get("MAX_FILE_CHARS", "80000"))

WHISPER_HOST = os.environ.get("WHISPER_HOST", "diktat-whisper")
WHISPER_PORT = os.environ.get("WHISPER_PORT", "8000")


ALLOWED_MODELS = {
    "qwen2.5:14b",
    "qwen3:14b",
    "qwen3:8b",
    "deepseek-r1:14b",
    "gemma4:12b",
    "gemma4:26b",
    "gemma4:e4b",
    "phi4:latest",
    "mistral-nemo:latest",
    "gpt-oss:20b",
}

MODEL_DESCRIPTIONS: dict[str, str] = {
    "qwen2.5:14b":         "Bewährt, stabil – Vorgängergeneration",
    "qwen3:14b":           "Empfohlen – aktuell, gutes Deutsch (Thinking)",
    "qwen3:8b":            "Schneller, leicht geringere Qualität",
    "deepseek-r1:14b":     "Sehr präzise, aber langsam (Reasoning)",
    "gemma4:12b":          "Ausgewogen – gutes Deutsch, moderate Ressourcen",
    "gemma4:26b":          "Sehr stark, aber ressourcenintensiv",
    "gemma4:e4b":          "Kompakt & effizient (Gemma 4)",
    "phi4:latest":         "Präzise Struktur, kompakter Speicherbedarf",
    "mistral-nemo:latest": "Schnell, gut für einfache Texte",
    "gpt-oss:20b":         "Experimentell – GPT-ähnlich",
}

DEFAULT_MODEL = "gemma4:12b"
TITLE_MODEL = os.environ.get("TITLE_MODEL", "llama3.2:3b")

_PROMPT_FILE = Path(__file__).parent / "prompts" / "system_prompt.md"
SYSTEM_PROMPT = _PROMPT_FILE.read_text(encoding="utf-8").strip()

_PROMPT_NEUTRAL_FILE = Path(__file__).parent / "prompts" / "system_prompt_neutral.md"
SYSTEM_PROMPT_NEUTRAL = _PROMPT_NEUTRAL_FILE.read_text(encoding="utf-8").strip()

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


def _extract_pdf_text(data: bytes) -> str:
    doc = fitz.open(stream=data, filetype="pdf")
    num_pages = len(doc)
    if num_pages == 0:
        doc.close()
        return ""
    total_chars = sum(len((p.get_text() or "").strip()) for p in doc)
    if total_chars >= 100:
        page_texts = [(p.get_text() or "").strip() for p in doc]
    else:
        page_texts = []
        for p in doc:
            pix = p.get_pixmap(matrix=fitz.Matrix(2, 2))
            img = Image.open(io.BytesIO(pix.tobytes("png")))
            page_texts.append(pytesseract.image_to_string(img, lang="deu"))
    doc.close()
    start = 1 if num_pages > 1 and _is_cover_page(page_texts[0]) else 0
    return "\n\n".join(page_texts[start:]).strip()


# ---- OCR-Jobs (In-Memory) ----
# {job_id: {"status": "pending"|"done"|"error", "text": str, "created_at": float}}
_ocr_jobs: dict = {}
_ocr_lock = threading.Lock()
_OCR_JOB_TTL = 1800  # 30 Minuten


def _cleanup_ocr_jobs() -> None:
    cutoff = time.time() - _OCR_JOB_TTL
    expired = [jid for jid, j in _ocr_jobs.items() if j["status"] in ("done", "error") and j.get("created_at", 0) < cutoff]
    for jid in expired:
        del _ocr_jobs[jid]


def _ocr_run(job_id: str, data: bytes, filename: str) -> None:
    fn = filename.lower()
    try:
        if fn.endswith((".jpg", ".jpeg")):
            img = Image.open(io.BytesIO(data))
            text = pytesseract.image_to_string(img, lang="deu").strip()
        elif fn.endswith(".pdf"):
            text = _extract_pdf_text(data)
        else:
            text = ""
        with _ocr_lock:
            _ocr_jobs[job_id] = {"status": "done", "text": text, "created_at": _ocr_jobs[job_id].get("created_at", time.time())}
    except Exception as e:
        with _ocr_lock:
            _ocr_jobs[job_id] = {"status": "error", "text": f"[OCR-Fehler: {e}]", "created_at": _ocr_jobs[job_id].get("created_at", time.time())}


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
        filtered = sorted(
            [m for m in all_models if m["name"] in ALLOWED_MODELS],
            key=lambda m: m.get("size", 0),
            reverse=True,
        )
        filtered_names = [m["name"] for m in filtered]
        current = session.get("selected_model", DEFAULT_MODEL)
        if current not in filtered_names and filtered_names:
            current = filtered_names[0]
        descriptions = {m: MODEL_DESCRIPTIONS[m] for m in filtered_names if m in MODEL_DESCRIPTIONS}
        return jsonify({"models": filtered_names, "selected": current, "descriptions": descriptions})
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


@app.route("/api/title", methods=["POST"])
def api_title():
    data = request.get_json() or {}
    message = (data.get("message") or "").strip()[:600]
    response = (data.get("response") or "").strip()[:800]
    model = TITLE_MODEL

    if not message and not response:
        return jsonify({"title": None}), 400

    prompt = (
        "Erstelle einen kurzen, prägnanten Titel (maximal 6 Wörter) auf Deutsch für dieses Gespräch. "
        "Antworte NUR mit dem Titel, ohne Anführungszeichen, ohne Erklärungen, ohne Satzzeichen am Ende.\n\n"
        f"Benutzer: {message}\n"
        f"Assistent: {response}"
    )

    try:
        resp = requests.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False, "options": {"temperature": 0.3, "num_predict": 25}},
            timeout=30,
        )
        resp.raise_for_status()
        title = resp.json().get("message", {}).get("content", "").strip().strip('"\'').strip()
        # strip common model prefixes like "Titel: " or "Title: "
        for prefix in ("titel:", "title:"):
            if title.lower().startswith(prefix):
                title = title[len(prefix):].strip().strip('"\'').strip()
                break
        if not title:
            return jsonify({"title": None})
        if len(title) > 60:
            title = title[:60].rsplit(" ", 1)[0] + "…"
        return jsonify({"title": title})
    except Exception as e:
        return jsonify({"title": None, "error": str(e)})


# ---- Sprach-Transkription (via diktat-whisper HTTP-API) ----
@app.route("/api/transcribe", methods=["POST"])
def api_transcribe():
    audio_file = request.files.get("audio")
    if not audio_file:
        return jsonify({"error": "Keine Audio-Datei"}), 400
    audio_data = audio_file.read()
    if not audio_data:
        return jsonify({"error": "Leere Audio-Datei"}), 400

    try:
        resp = requests.post(
            f"http://{WHISPER_HOST}:{WHISPER_PORT}/v1/audio/transcriptions",
            files={"file": ("audio.webm", audio_data, "audio/webm")},
            data={"model": "whisper-1", "language": "de", "response_format": "json"},
            timeout=120,
        )
        resp.raise_for_status()
        return jsonify({"text": resp.json().get("text", "")})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---- OCR-Endpoint: Datei hochladen, Job starten ----
@app.route("/api/ocr", methods=["POST"])
def api_ocr_start():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "Keine Datei"}), 400

    data = f.read()
    job_id = str(uuid.uuid4())

    with _ocr_lock:
        _cleanup_ocr_jobs()
        _ocr_jobs[job_id] = {"status": "pending", "text": "", "created_at": time.time()}

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
            return _extract_pdf_text(file_storage.read())
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
        combined_files = "\n\n".join(file_texts)
        if len(combined_files) > MAX_FILE_CHARS:
            combined_files = combined_files[:MAX_FILE_CHARS]
            truncation_note = (
                f"\n\n[HINWEIS: Die hochgeladenen Dokumente wurden auf {MAX_FILE_CHARS // 1000} k Zeichen "
                f"gekürzt. Spätere Dokumente oder Seitenenden können fehlen.]"
            )
        else:
            truncation_note = ""
        full_content = (
            combined_files
            + truncation_note
            + "\n\n---\nAufgabe: " + user_message
            + "\n\n[Antworte AUSSCHLIESSLICH auf Deutsch und verzichte auf Disclaimer.]"
        )
    else:
        full_content = user_message

    if not full_content:
        return jsonify({"error": "Keine Nachricht eingegeben"}), 400

    mode = request.form.get("mode", "medical")
    active_prompt = SYSTEM_PROMPT_NEUTRAL if mode == "neutral" else SYSTEM_PROMPT
    messages = [{"role": "system", "content": active_prompt}]
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
                json={"model": model, "messages": messages, "stream": True, "options": {"num_ctx": OLLAMA_NUM_CTX}},
                stream=True,
                timeout=300,
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
