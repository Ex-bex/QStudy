FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TESSERACT_EXECUTABLE=/usr/bin/tesseract

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng tesseract-ocr-kaz \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 qstudy \
    && useradd --uid 10001 --gid qstudy --create-home qstudy

WORKDIR /app
COPY backend/requirements.txt backend/requirements.lock.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt -c requirements.lock.txt
COPY --chown=10001:10001 backend/app ./app
COPY --chown=10001:10001 scripts/production/runtime.py ./production_runtime.py
COPY --chown=10001:10001 scripts/check_mail.py ./check_mail.py

USER 10001:10001
EXPOSE 8000
CMD ["python", "production_runtime.py", "serve"]
