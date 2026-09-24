# KI-Atteste

KI-gestützter Assistent für medizinische Fachkräfte zum Erstellen von Attesten, Gutachten und Berichten. Die App nutzt ein lokal laufendes LLM über [Ollama](https://ollama.com) und kommt ohne Cloud-Dienste aus.

**Version:** siehe `VERSION`

---

## Features

- Chat-Interface mit SSE-Streaming (Antworten erscheinen Token für Token)
- **Zwei Modi:** „Medizinisch" für Atteste und Berichte, „Neutral" als allgemeiner Assistent
- **Dokument-Upload:** PDF (inkl. OCR für gescannte Dokumente), DOCX, TXT und JPG – per Auswahl oder Drag & Drop, vollständig im Arbeitsspeicher, keine Dateien auf der Disk
- **Deckblatt-Erkennung:** Fax- und Scan-Deckblätter sowie E-Mail-Header werden automatisch übersprungen
- **Spracheingabe:** Diktat wird über einen lokalen Whisper-Service transkribiert
- **Chat-Historie im Browser** mit automatisch generierten Titeln (localStorage, max. 50 Chats)
- Modellauswahl zur Laufzeit aus einer kuratierten Liste, mit Kurzbeschreibung je Modell
- Vollständig lokal – keine Cloud-Anbindung

---

## Voraussetzungen

- Docker + Docker Compose
- [Ollama](https://ollama.com) läuft auf dem Host (Standard-Port 11434)
- Mindestens ein Modell aus der Whitelist, z. B. das Standardmodell:
  ```bash
  ollama pull gemma4:12b
  # kleines Modell für die automatische Chat-Titelvergabe
  ollama pull llama3.2:3b
  ```
- Externe Docker-Netzwerke:
  ```bash
  docker network create caddy-proxy-network
  docker network create diktat-network
  ```
- Der Whisper-Service `diktat-whisper` am `diktat-network` (nur für die Spracheingabe nötig; ohne ihn funktioniert der Rest normal)

---

## Schnellstart

```bash
# 1. Repository klonen
git clone <repo-url>
cd ki-atteste

# 2. Umgebungsvariablen anpassen
cp .env.example .env
# SECRET_KEY in .env auf einen sicheren Wert setzen!

# 3. Container starten
docker compose up --build -d

# 4. App aufrufen
# lokal auf dem Host: http://localhost:5010
# oder über Caddy:    http://atteste2.domain.local
```

---

## Konfiguration

Alle Einstellungen werden über `.env` gesetzt:

| Variable         | Standard                            | Beschreibung                                          |
|------------------|-------------------------------------|-------------------------------------------------------|
| `SECRET_KEY`     | `change-me-in-production`           | Flask Session Secret (unbedingt ändern!)              |
| `OLLAMA_URL`     | `http://host.docker.internal:11434` | Ollama API-Endpunkt                                   |
| `OLLAMA_NUM_CTX` | `32768`                             | Obergrenze des Kontextfensters (wird je Anfrage nach Textlänge gewählt) |
| `MAX_FILE_CHARS` | `80000`                             | Obergrenze für hochgeladenen Dokumenttext je Anfrage  |
| `WHISPER_HOST`   | `diktat-whisper`                    | Hostname des Whisper-Services                         |
| `WHISPER_PORT`   | `8000`                              | Port des Whisper-Services                             |
| `TITLE_MODEL`    | `llama3.2:3b`                       | Modell für die automatische Chat-Titelvergabe         |
| `TZ`             | `Europe/Berlin`                     | Zeitzone im Container                                 |
| `DOCKER_NETWORK` | `caddy-proxy-network`               | Externes Docker-Netzwerk für Caddy                    |

---

## Verfügbare Modelle

Im Dropdown erscheinen nur Modelle, die in der Whitelist stehen **und** in Ollama installiert sind:

| Modell       | Charakteristik                                        |
|--------------|-------------------------------------------------------|
| `gemma4:12b` | Standard – schnell (5–15 s), ohne Thinking            |
| `gemma4:26b` | Gründlich – denkt vorher nach (meist 20–60 s)         |

Die Liste ist bewusst kurz: In Tests mit echten Arztbriefen haben qwen3, qwen2.5, deepseek-r1, phi4, mistral-nemo, gemma4:e4b und gpt-oss auch mit angepasstem Prompt Befunde, Medikamente oder Funktionseinschränkungen erfunden. Neue Modelle vor der Aufnahme in `ALLOWED_MODELS` mit echten Befunden testen und in `MODEL_DESCRIPTIONS`, `MODEL_OPTIONS` und `MODEL_THINK` eintragen.

---

## Architektur

```
Browser  ── localStorage: Chat-Historie
  │  SSE-Stream (text/event-stream)
  ▼
Flask (app.py, Port 5000)
  ├─ POST /api/chat  ──────▶  Ollama (Host, Port 11434)
  ├─ POST /api/ocr   ──────▶  PyMuPDF + Tesseract (im Container, asynchron)
  └─ POST /api/transcribe ─▶  diktat-whisper (Port 8000)
```

- **Zustandslos:** Die Chathistory wird vollständig vom Browser im Request-Body mitgesendet; der Server hält keinen Gesprächsverlauf.
- **Keine Datenbank:** Chats liegen im localStorage des Browsers. Hochgeladene Dateien werden ausschließlich im Arbeitsspeicher verarbeitet und nie auf die Disk geschrieben.
- **OCR asynchron:** Große Scans blockieren die Oberfläche nicht – der Upload startet einen Job, das Frontend pollt den Status. Die Jobs liegen im Prozessspeicher (TTL 30 Minuten), die App läuft daher bewusst mit einem einzigen Worker.
- **Caddy:** Der Container hängt am `caddy-proxy-network`. Caddy terminiert TLS und leitet auf Port 5000 weiter. Port 5010 ist nur auf `127.0.0.1` gebunden.

---

## System-Prompt anpassen

Die Prompts liegen in `prompts/system_prompt.md` (Modus „Medizinisch") und `prompts/system_prompt_neutral.md` (Modus „Neutral").

Das Verzeichnis ist **nicht** als Volume eingebunden – nach einer Änderung ist ein Rebuild nötig:

```bash
docker compose down && docker compose up --build -d
```

---

## Entwicklung

Hot-Reload ist aktiv: `app.py`, `templates/` und `static/` sind als Volumes eingebunden, Änderungen dort greifen sofort.

```bash
# Logs live verfolgen
docker compose logs -f

# Nach Änderungen an requirements.txt, Dockerfile oder prompts/ neu bauen
docker compose down && docker compose up --build -d
```

Die Python-Abhängigkeiten sind in `requirements.txt` auf feste Versionen gepinnt. Nach einem Upgrade von Pillow oder PyMuPDF sollte der Upload-Pfad geprüft werden (Text-PDF, gescanntes PDF, JPG).

---

## Lizenz

Internes Werkzeug – kein öffentlicher Vertrieb.
