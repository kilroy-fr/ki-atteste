# CLAUDE.md – KI-Atteste

## Projektüberblick

Flask-basierte Chat-App, die über Ollama (lokal) medizinische Atteste, Gutachten und Berichte erstellt. Läuft als Docker-Container hinter einem Caddy-Reverse-Proxy.

- **URL (intern):** `atteste2.domain.local`
- **Container-Port:** 5000, nach außen via Caddy als 5010 gemappt
- **Docker-Netzwerk:** `caddy-proxy-network` (extern, muss vor dem Start existieren)
- **Ollama-Endpunkt:** `http://host.docker.internal:11434` (läuft auf dem Host)

## Projektstruktur

```
app.py                  Flask-Anwendung (einzige Python-Datei)
prompts/system_prompt.md  System-Prompt für das LLM (zur Laufzeit geladen)
templates/index.html    Frontend (Jinja2-Template)
static/app.js           Chat-Logik (SSE-Streaming)
static/style.css        Styles
static/favicon.svg      Icon
uploads/                Hochgeladene Dateien (nicht in Git, Laufzeit-Volume)
Dockerfile              Python 3.12-slim, libmupdf-dev
docker-compose.yml      Single-Service-Stack
.env / .env.example     Umgebungsvariablen
VERSION                 Semver-Versionsdatei (wird im Frontend angezeigt)
requirements.txt        Python-Abhängigkeiten (Flask, PyMuPDF, python-docx, requests)
```

## Entwicklungsworkflow

```bash
# Container bauen und starten (Hot-Reload aktiv via Volume-Mounts)
docker compose up --build -d

# Logs verfolgen
docker compose logs -f

# Container neu starten (nach Änderungen an requirements.txt oder Dockerfile)
docker compose down && docker compose up --build -d
```

**Hot-Reload:** `app.py`, `templates/` und `static/` sind als Volumes eingebunden – Änderungen sind ohne Rebuild sofort aktiv. Der Flask-Dev-Server läuft mit `use_reloader=True`.

## Wichtige Umgebungsvariablen

| Variable        | Standard                           | Beschreibung                     |
|-----------------|------------------------------------|----------------------------------|
| `SECRET_KEY`    | `change-me-in-production`          | Flask Session Secret             |
| `OLLAMA_URL`    | `http://host.docker.internal:11434`| Ollama API-Endpunkt              |
| `TZ`            | `Europe/Berlin`                    | Zeitzone                         |
| `DOCKER_NETWORK`| `caddy-proxy-network`              | Externes Docker-Netzwerk für Caddy|

## Modelle

- Standard-Modell: `qwen2.5:14b`
- Ausgeschlossene Modelle (zu klein / Embedding-Modelle): `nomic-embed-text`, `llama3.2:1b`, `llama3.2:3b`, `llama3.1:8b`, `deepseek-r1:8b`, `gemma4:e2b`
- Modellauswahl wird per Cookie (`selected_model`) und Flask-Session persistiert

## System-Prompt

Der System-Prompt liegt in `prompts/system_prompt.md` und wird beim Start **zur Laufzeit geladen** (nicht in den Code eingebettet). Änderungen am Prompt erfordern einen Container-Neustart, aber keinen Rebuild.

## Datei-Upload

- Max. 50 MB pro Request
- Unterstützte Formate: PDF (via PyMuPDF), DOCX (via python-docx), TXT
- Dateien werden temporär im Container unter `/app/uploads` abgelegt (Volume: `./uploads`)

## Caddy-Integration

Der Container meldet sich mit `expose: 5000` am `caddy-proxy-network` an. Caddy erkennt ihn über Labels oder manuellen Eintrag. Watchtower ist aktiviert (`com.centurylinklabs.watchtower.enable=true`).

## Coding-Konventionen

- Nur eine Python-Datei (`app.py`) – keine weitere Modularisierung, solange der Scope klein bleibt
- Streaming via SSE (`text/event-stream`), kein WebSocket
- Keine Authentifizierung (internes Netz, Caddy-Zugang)
- Keine Datenbank – zustandslos, History kommt vom Client im Request-Body
- Keine externen AI-Provider; ausschließlich lokales Ollama

## Versionierung

Version steht in `VERSION` (Semver). Die Zahl wird im Frontend über `inject_version()` Context Processor angezeigt.
