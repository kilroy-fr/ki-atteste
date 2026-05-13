# KI-Atteste

KI-gestützter Assistent für medizinische Fachkräfte zum Erstellen von Attesten, Gutachten und Berichten. Die App nutzt ein lokal laufendes LLM über [Ollama](https://ollama.com) und läuft vollständig offline ohne externe Dienste.

**Version:** 0.1.1

---

## Features

- Chat-Interface mit SSE-Streaming (Antworten erscheinen Token für Token)
- Dokument-Upload: PDF, DOCX und TXT werden automatisch extrahiert und in den Kontext eingebettet
- Modellauswahl zur Laufzeit aus allen verfügbaren Ollama-Modellen
- System-Prompt speziell für deutschsprachige medizinische Atteste
- Persistente Modellwahl per Cookie
- Vollständig offline – keine Cloud-Anbindung

---

## Voraussetzungen

- Docker + Docker Compose
- [Ollama](https://ollama.com) läuft auf dem Host (Standard-Port 11434)
- Mindestens ein geeignetes Sprachmodell, z. B. `qwen2.5:14b`:
  ```bash
  ollama pull qwen2.5:14b
  ```
- Externes Docker-Netzwerk `caddy-proxy-network` (für Caddy-Integration):
  ```bash
  docker network create caddy-proxy-network
  ```

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
# direkt: http://localhost:5010
# oder über Caddy: http://atteste2.domain.local
```

---

## Konfiguration

Alle Einstellungen werden über `.env` gesetzt:

| Variable         | Standard                            | Beschreibung                      |
|------------------|-------------------------------------|-----------------------------------|
| `SECRET_KEY`     | `change-me-in-production`           | Flask Session Secret (unbedingt ändern!) |
| `OLLAMA_URL`     | `http://host.docker.internal:11434` | Ollama API-Endpunkt               |
| `TZ`             | `Europe/Berlin`                     | Zeitzone im Container             |
| `DOCKER_NETWORK` | `caddy-proxy-network`               | Externes Docker-Netzwerk          |

---

## Architektur

```
Browser
  │  SSE-Stream (text/event-stream)
  ▼
Flask (app.py, Port 5000)
  │  REST POST /api/chat
  ▼
Ollama (Host, Port 11434)
  └─ LLM (z. B. qwen2.5:14b)
```

- **Zustandslos:** Die Chathistory wird vollständig vom Browser im Request-Body mitgesendet; der Server hält keinen Session-State.
- **Keine Datenbank:** Alle Daten liegen im Browser oder in hochgeladenen Dateien (temporär im Volume `./uploads`).
- **Caddy:** Der Container hängt am `caddy-proxy-network`. Caddy terminiert TLS und leitet auf Port 5000 weiter.

---

## System-Prompt anpassen

Der System-Prompt liegt in `prompts/system_prompt.md` und kann ohne Rebuild geändert werden. Nach einer Änderung Container neu starten:

```bash
docker compose restart ki-atteste-web
```

---

## Entwicklung

Hot-Reload ist aktiv: `app.py`, `templates/` und `static/` sind als Volumes eingebunden.

```bash
# Logs live verfolgen
docker compose logs -f

# Nach Änderungen an requirements.txt oder Dockerfile neu bauen
docker compose down && docker compose up --build -d
```

---

## Lizenz

Internes Werkzeug – kein öffentlicher Vertrieb.
