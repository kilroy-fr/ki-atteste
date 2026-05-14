FROM python:3.12-slim

WORKDIR /app

# System-Abhängigkeiten
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmupdf-dev \
    tesseract-ocr \
    tesseract-ocr-deu \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# CUDA-Laufzeitbibliotheken für ctranslate2/faster-whisper (via PyPI)
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib:${LD_LIBRARY_PATH}

# Python-Abhängigkeiten
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App-Code
COPY . .

RUN mkdir -p /app/uploads /app/models/whisper

EXPOSE 5000

CMD ["python", "app.py"]
