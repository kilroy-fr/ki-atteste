FROM python:3.12-slim

WORKDIR /app

# System-Abhängigkeiten
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmupdf-dev \
    tesseract-ocr \
    tesseract-ocr-deu \
    && rm -rf /var/lib/apt/lists/*

# Python-Abhängigkeiten
COPY requirements.txt requirements-nodeps.txt ./
# pip des Basis-Images hinkt hinterher (25.0.1 mit bekannten Lücken)
ENV PIP_ROOT_USER_ACTION=ignore
RUN pip install --no-cache-dir pip==26.3 \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps -r requirements-nodeps.txt \
    && python -W error -c "import pymupdf, PIL, docx, pytesseract, flask, requests"

# App-Code
COPY . .

RUN mkdir -p /app/uploads

EXPOSE 5000

CMD ["python", "app.py"]
