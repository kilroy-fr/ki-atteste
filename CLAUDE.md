# CLAUDE.md – KI-Atteste

## Projektüberblick

Flask-basierte Chat-App, die über Ollama (lokal) medizinische Atteste, Gutachten und Berichte erstellt. Läuft als Docker-Container hinter einem Caddy-Reverse-Proxy.

- **URL (intern):** `atteste2.domain.local`
- **Container-Port:** 5000; zusätzlich auf `127.0.0.1:5010` gemappt (nur lokal, nicht von außen erreichbar)
- **Docker-Netzwerke:** `caddy-proxy-network` (Caddy) und `diktat-network` (Whisper) – beide extern, müssen vor dem Start existieren
- **Ollama-Endpunkt:** `http://host.docker.internal:11434` (läuft auf dem Host)
- **Whisper:** externer Service `diktat-whisper:8000` (OpenAI-kompatible API), nicht Teil dieses Stacks

## Projektstruktur

```
app.py                          Flask-Anwendung (einzige Python-Datei)
prompts/system_prompt.md        System-Prompt Modus "medical"
prompts/system_prompt_neutral.md System-Prompt Modus "neutral"
templates/index.html            Frontend (Jinja2-Template)
static/app.js                   Chat-Logik (SSE, OCR-Polling, Aufnahme, Chat-Historie)
static/style.css                Styles
static/favicon.svg              Icon
static/logo.jpg                 Logo
Dockerfile                      Python 3.12-slim, libmupdf-dev, tesseract-ocr(-deu)
docker-compose.yml              Single-Service-Stack, zwei externe Netzwerke
.env / .env.example             Umgebungsvariablen
VERSION                         Semver-Versionsdatei (wird im Frontend angezeigt)
requirements.txt                Python-Abhängigkeiten
testdateien/                    Echte Arztbriefe (Einwilligung liegt vor) – in .gitignore UND .dockerignore
```

**Patientendaten:** `testdateien/` darf weder committet noch ins Image kopiert werden (sonst landet es über `COPY . .` im Container). Inhalte nie an externe Dienste schicken; Tests nur gegen lokales Ollama.

## Entwicklungsworkflow

```bash
# Container bauen und starten (Hot-Reload aktiv via Volume-Mounts)
docker compose up --build -d

# Logs verfolgen
docker compose logs -f

# Neu bauen (nach Änderungen an requirements.txt, Dockerfile oder prompts/)
docker compose down && docker compose up --build -d
```

**Hot-Reload:** Nur `app.py`, `templates/` und `static/` sind als Volumes eingebunden – Änderungen dort sind ohne Rebuild sofort aktiv (Flask-Dev-Server mit `use_reloader=True`).

**Achtung:** `prompts/` ist **nicht** gemountet und landet über `COPY . .` im Image. Prompt-Änderungen brauchen einen **Rebuild**, ein Neustart allein genügt nicht.

## Umgebungsvariablen

| Variable         | Standard                            | Beschreibung                                  |
|------------------|-------------------------------------|-----------------------------------------------|
| `SECRET_KEY`     | `change-me-in-production`           | Flask Session Secret                          |
| `OLLAMA_URL`     | `http://host.docker.internal:11434` | Ollama API-Endpunkt                           |
| `OLLAMA_NUM_CTX` | `32768`                             | **Obergrenze** des Kontextfensters; tatsächlich wird pro Request `_num_ctx()` berechnet |
| `MAX_FILE_CHARS` | `80000`                             | Obergrenze für kombinierten Dateitext je Chat-Request |
| `WHISPER_HOST`   | `diktat-whisper`                    | Hostname des Whisper-Services                 |
| `WHISPER_PORT`   | `8000`                              | Port des Whisper-Services                     |
| `TITLE_MODEL`    | `llama3.2:3b`                       | Kleines Modell für die Chat-Titelgenerierung  |
| `TZ`             | `Europe/Berlin`                     | Zeitzone                                      |
| `DOCKER_NETWORK` | `caddy-proxy-network`               | Externes Docker-Netzwerk für Caddy            |

## Modelle

Die Auswahl ist eine **Whitelist** (`ALLOWED_MODELS` in `app.py`), keine Ausschlussliste. Nur Modelle, die sowohl in der Whitelist stehen als auch in Ollama installiert sind, erscheinen im Dropdown – sortiert nach Größe absteigend.

- Standard-Modell: `gemma4:12b` (ohne Thinking, temperature 0.4, 5–15 s)
- Whitelist: `gemma4:12b`, `gemma4:26b` (mit Thinking, temperature 1.0, meist 20–60 s, Median 40 s)
- Pro Modell: Kurztext in `MODEL_DESCRIPTIONS`, Sampling in `MODEL_OPTIONS`, Thinking in `MODEL_THINK`. **Neue Modelle in alle vier Dicts eintragen** – und vorher mit echten Befunden testen.
- Modellauswahl wird per Cookie (`selected_model`, 1 Jahr) und Flask-Session persistiert

**Warum nur gemma4** (Tests 09/2026 mit echten Arztbriefen, je Aufgabe mehrere Durchläufe): qwen3:8b/14b, qwen2.5:14b, deepseek-r1:14b, phi4, mistral-nemo, gemma4:e4b und gpt-oss:20b haben auch mit angepasstem Prompt Fakten erfunden – Abkürzungen wie pDMS/DS frei „aufgelöst“, Medikamente und Datumsangaben erfunden, als Absender des Fremdbefunds unterschrieben, Funktionseinschränkungen erfunden und Reha-Atteste für eine Bagatellverletzung von 2020 geschrieben. deepseek-r1 mischt zudem Chinesisch/Englisch ein.

**Thinking bei gemma4:** Nur mit temperature 1.0. Bei 0.4 liefen Denkphasen in Schleifen (bis 220 s, danach leere Antwort). Für gemma4:12b bringt Thinking keine bessere Qualität, nur 3–10× mehr Wartezeit. `num_predict` begrenzt ausufernde Denkphasen; kommt dabei keine Antwort zustande, meldet `/chat` einen Fehler statt einer leeren Blase. Während des Denkens sendet `/chat` einmalig `{"thinking": true}`, das Frontend zeigt „denkt nach …“.

**Kontextgröße** (`_num_ctx`): Textlänge × 0,4 (≈ 2,5 Zeichen/Token) + 8192 Reserve, in 8k-Schritten, gedeckelt durch `OLLAMA_NUM_CTX`. Ein fester 32k-Kontext schob 14B-Modelle teilweise auf die CPU (halbe Geschwindigkeit); auf der GPU sind neben Ollama ~4 GB durch andere Dienste belegt.

## System-Prompts und Modi

Zwei Modi, im Frontend über Tabs umschaltbar, per Formularfeld `mode` an `/chat` übergeben:

- `medical` (Standard) → `prompts/system_prompt.md`
- `neutral` → `prompts/system_prompt_neutral.md`

Beide werden beim Import von `app.py` **einmalig** gelesen, nicht pro Request.

**Kernregeln im medizinischen Prompt** (jede davon behebt einen in Tests beobachteten Fehler):
- Hochgeladene Briefe sind Fremdbefunde: nur als Quelle nennen, nie Briefkopf, Unterschrift oder Wir-Form übernehmen. Patient ist, wer hinter „Patient:“/„Betrifft:“/„geb. am“ steht – nicht der Adressat.
- Nichts erfinden; fehlende Angaben als `[Platzhalter]`. Keine ICD-Codes, die nicht im Dokument stehen. Abkürzungen (pDMS, DS, ISG …) unverändert lassen.
- Befund wiedergeben ≠ Attest: Empfehlungen aus dem Dokument getrennt von eigenen Vorschlägen.
- Reha-Attest: zuerst prüfen, ob der Befund es trägt – sonst kein Gefälligkeitsattest, sondern Rückfrage. Alltags-/Berufseinschränkungen nur als Platzhalter, nichts verstärken („massiv“, „erheblich“). Bei bereits abgelehnter Reha mit Bezug auf den Bescheid beginnen.
- Beispiele im Prompt nie aus echten Befunden nehmen: Kleinere Modelle übernahmen ein Beispiel („laut MRT-Befund der Radiologie …“) wörtlich in fremde Atteste.
- Keine Formulierung, die das Modell nachahmen kann („keine Hinweise wie ‚Entwurf, bitte prüfen‘“ führte zu genau diesem Satz).

## Modelle und Prompt testen

Vor jeder Änderung an Whitelist, `MODEL_OPTIONS`/`MODEL_THINK` oder `prompts/system_prompt.md` mit echten Befunden aus `testdateien/` gegen lokales Ollama testen (nie gegen externe Dienste). Bewährte Aufgaben:

1. „Gebe den Inhalt des Befunds wieder und berichte, ob sich daraus Empfehlungen ergeben“
2. „Formuliere ein Attest, das bei diesem Befund eine Rehamaßnahme sinnvoll ist.“
3. „Eine Rehamaßnahme wurde abgelehnt. Formuliere ein Attest, dass bei diesem Befund eine stationäre Rehamaßnahme nötig und sinnvoll ist.“

Worauf achten: Absage bei Bagatellbefund (Prellung von 2020 → kein Reha-Attest), keine erfundenen Abkürzungsauflösungen/Medikamente/Daten/Einschränkungen, keine fremde Unterschrift, Bescheid-Bezug beim Widerspruch, Antwortzeit. Jede Aufgabe mehrfach laufen lassen – Ausreißer zeigen sich oft erst in der zweiten oder dritten Wiederholung. Die Nachricht so aufbauen wie `/chat` (System-Prompt + „Heutiges Datum“, Dateitext, `\n\n---\nAufgabe: …`), den Dateitext vorher über `_extract_pdf_text` im Container erzeugen (PDF per stdin, `docker exec -i`).

## Datei-Upload und OCR

- Max. 50 MB pro Request (`MAX_CONTENT_LENGTH`)
- Formate: PDF (PyMuPDF, mit OCR-Fallback), DOCX (python-docx), TXT, JPG/JPEG (pytesseract)
- Dateien werden **ausschließlich im Arbeitsspeicher** verarbeitet – nichts wird auf die Disk geschrieben

**PDF-Extraktion** (`_extract_pdf_text`): Die Entscheidung fällt **pro Seite**: Hat eine Seite weniger als `_MIN_PAGE_CHARS` (200) Zeichen eingebetteten Text, wird sie als Graustufen-Pixmap mit 300 dpi (`_OCR_DPI`) und 3×3-Median-Filter an Tesseract (`lang="deu"`, Standard-Layout `--psm 3`) gegeben. Median-Filter und 300 dpi wurden an blassen Faxkopien ermittelt: Bei 144 dpi fehlten Wörter, ohne Filter schnitt Tesseract Zeilenanfänge ab („enlefaxin“), `--psm 4` vermischt mehrspaltige Briefköpfe mit dem Text. So werden auch gemischte PDFs (digitales Deckblatt + Scans) vollständig erkannt. Anschließend greift die **Deckblatt-Erkennung**: Bei mehrseitigen Dokumenten wird Seite 1 verworfen, wenn sie kurz ist (< `_COVER_MAX_CHARS`) und ein Fax-/Scan-Stichwort enthält, oder wenn mindestens drei E-Mail-Header (`Von:`, `An:`, `Betreff:`, `Gesendet:`) am Zeilenanfang stehen. Die Längengrenze ist nötig, weil fast jeder Briefkopf „Fax:" enthält.

**OCR läuft asynchron:** `POST /api/ocr` nimmt die Datei an, startet einen Thread und liefert sofort eine `job_id`. Das Frontend pollt `GET /api/ocr/<job_id>` bis `status == "done"` und schickt den Text danach als `pre_extracted_texts` an `/chat`. Beim Senden wartet das Frontend auf noch laufende OCR-Jobs. Jobs liegen im Prozessspeicher (`_ocr_jobs`, TTL 30 Minuten) – sie überleben keinen Reload und funktionieren nur mit einem einzelnen Worker.

**SSE-Events von `/chat`:** `user_content` (einmalig zuerst), `thinking` (einmalig, sobald das Modell denkt – Frontend zeigt „denkt nach …“), `token`, `done`, `error` (auch bei Ollama-Fehler mitten im Stream, Abbruch ohne `done` oder leerer Antwort).

**Dokumente in Folgefragen:** `/chat` sendet als erstes SSE-Event `{"user_content": …}` mit der vollständigen User-Nachricht inkl. Dateitext. Das Frontend legt sie in die Historie, damit Folgefragen die Dokumente noch sehen. Im localStorage wird nur der getippte Text gespeichert (Datenschutz + Speicherlimit). Ein neu geladener alter Chat kennt die Dokumente daher nicht mehr.

Überschreitet der kombinierte Dateitext `MAX_FILE_CHARS`, wird er hart abgeschnitten und ein Hinweis an den Prompt gehängt.

## API-Endpunkte

| Route                  | Methode | Zweck                                              |
|------------------------|---------|----------------------------------------------------|
| `/`                    | GET     | Frontend                                            |
| `/api/models`          | GET     | Gefilterte Modellliste + Beschreibungen             |
| `/api/set_model`       | POST    | Modellwahl in Session und Cookie speichern          |
| `/api/title`           | POST    | Chat-Titel via `TITLE_MODEL` generieren             |
| `/api/transcribe`      | POST    | Audio an diktat-whisper weiterreichen               |
| `/api/ocr`             | POST    | OCR-Job starten, gibt `job_id` zurück               |
| `/api/ocr/<job_id>`    | GET     | OCR-Job-Status abfragen                             |
| `/chat`                | POST    | Chat-Anfrage, Antwort als SSE-Stream                |

## Frontend

- Chat-Historie liegt im **localStorage** des Browsers (`ki_atteste_chats`, max. 50 Chats) – Server bleibt zustandslos
- Titel werden nach dem ersten Austausch automatisch über `/api/title` nachgeladen
- Drag & Drop für Dateien
- Spracheingabe über `MediaRecorder` (webm/opus) → `/api/transcribe`

## Coding-Konventionen

- Nur eine Python-Datei (`app.py`) – keine weitere Modularisierung, solange der Scope klein bleibt
- Streaming via SSE (`text/event-stream`), kein WebSocket
- Keine Authentifizierung (internes Netz, Caddy-Zugang)
- Keine Datenbank – Server zustandslos, History kommt vom Client im Request-Body
- Keine externen AI-Provider; ausschließlich lokales Ollama und der lokale Whisper-Service

## Caddy-Integration

Der Container meldet sich mit `expose: 5000` am `caddy-proxy-network` an. Caddy erkennt ihn über Labels oder manuellen Eintrag. Watchtower ist aktiviert (`com.centurylinklabs.watchtower.enable=true`).

## Versionierung

Version steht in `VERSION` (Semver). Die Zahl wird im Frontend über den `inject_version()` Context Processor angezeigt.

## Abhängigkeiten

Alle Versionen sind in `requirements.txt` gepinnt. Beim Anheben von Pillow oder PyMuPDF den Upload-Pfad testen (Text-PDF, Bild-PDF, JPG), da beide direkt in der OCR-Kette hängen. `import pymupdf as fitz` – nicht `import fitz`, das ist seit PyMuPDF 1.28 der Legacy-Alias und erzeugt eine Warnung.
