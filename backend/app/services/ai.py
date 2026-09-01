import os
import asyncio
import base64
import httpx
from app.config import settings

GEMINI_BASE = "https://generativelanguage.googleapis.com"
GEMINI_URL = GEMINI_BASE + "/v1beta/models/{model}:generateContent"

RETRYABLE = {429, 500, 502, 503}


class AIError(Exception):
    pass


def _extract_text(data: dict) -> str:
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise AIError("Gemini вернул пустой ответ")


async def _post_gemini(payload: dict, timeout: int = 120) -> dict:
    """POST к Gemini с авто-повторами при перегрузке (429/5xx)."""
    if not settings.GEMINI_API_KEY:
        raise AIError("GEMINI_API_KEY не задан — добавь ключ в backend/.env")

    last_err = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    GEMINI_URL.format(model=settings.GEMINI_MODEL),
                    headers={"x-goog-api-key": settings.GEMINI_API_KEY},
                    json=payload,
                )
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code in RETRYABLE:
                last_err = AIError("overloaded")
                await asyncio.sleep(4 * (attempt + 1))  # ждём 4с, 8с, 12с
                continue
            raise AIError(f"Ошибка Gemini {resp.status_code}: {resp.text[:300]}")
        except httpx.TimeoutException:
            last_err = AIError("Gemini не ответил вовремя — попробуй ещё раз")
            await asyncio.sleep(2)

    if last_err and str(last_err) == "overloaded":
        raise AIError("Gemini сейчас перегружен (3 попытки не прошли). Подожди пару минут и попробуй снова")
    raise last_err


async def generate_content(prompt: str, json_mode: bool = False) -> str:
    """Текстовый вызов Gemini (тренажёр, экзаменатор, карточки, итоги)."""
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    if json_mode:
        payload["generationConfig"] = {"responseMimeType": "application/json"}
    return _extract_text(await _post_gemini(payload))


async def chat_completion(system: str, contents: list) -> str:
    """Вызов с системной инструкцией и историей диалога (чат)."""
    payload = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": contents,
    }
    return _extract_text(await _post_gemini(payload))


AUDIO_MIME = {"webm": "audio/webm", "ogg": "audio/ogg", "mp3": "audio/mpeg",
              "wav": "audio/wav", "m4a": "audio/mp4"}


async def transcribe_audio(filepath: str) -> str:
    """Расшифровка короткого аудио (голосовые) — inline, без Files API."""
    ext = filepath.rsplit(".", 1)[-1].lower()
    mime = AUDIO_MIME.get(ext, "audio/webm")
    with open(filepath, "rb") as f:
        data = base64.b64encode(f.read()).decode()

    payload = {"contents": [{"parts": [
        {"text": "Расшифруй речь дословно. Верни только текст расшифровки, без комментариев."},
        {"inline_data": {"mime_type": mime, "data": data}},
    ]}]}
    return _extract_text(await _post_gemini(payload))


async def _upload_media(filepath: str, mime_type: str) -> dict:
    """Загрузка медиафайла в Gemini Files API и ожидание готовности."""
    size = os.path.getsize(filepath)
    name = os.path.basename(filepath)

    async with httpx.AsyncClient(timeout=600) as client:
        r = await client.post(
            f"{GEMINI_BASE}/upload/v1beta/files",
            headers={
                "x-goog-api-key": settings.GEMINI_API_KEY,
                "X-Goog-Upload-Protocol": "resumable",
                "X-Goog-Upload-Command": "start",
                "X-Goog-Upload-Header-Content-Length": str(size),
                "X-Goog-Upload-Header-Content-Type": mime_type,
                "Content-Type": "application/json",
            },
            json={"file": {"display_name": name}},
        )
        if r.status_code != 200:
            raise AIError(f"Ошибка загрузки в Gemini: {r.status_code} {r.text[:200]}")

        upload_url = r.headers.get("X-Goog-Upload-URL")
        if not upload_url:
            raise AIError("Gemini не вернул URL загрузки")

        with open(filepath, "rb") as f:
            content = f.read()
        r2 = await client.post(
            upload_url,
            headers={
                "Content-Length": str(size),
                "X-Goog-Upload-Command": "upload, finalize",
                "X-Goog-Upload-Offset": "0",
            },
            content=content,
        )
        if r2.status_code != 200:
            raise AIError(f"Ошибка передачи файла: {r2.status_code}")

        file_info = r2.json().get("file", {})
        uri = file_info.get("uri")
        if not uri:
            raise AIError("Gemini не вернул uri файла")

        for _ in range(45):
            state = file_info.get("state")
            if state == "ACTIVE":
                return {"uri": uri, "mime_type": file_info.get("mimeType", mime_type)}
            if state == "FAILED":
                raise AIError("Gemini не смог обработать медиафайл")
            await asyncio.sleep(2)
            gr = await client.get(uri, headers={"x-goog-api-key": settings.GEMINI_API_KEY})
            file_info = gr.json()

        raise AIError("Файл слишком долго обрабатывается в Gemini")


async def analyze_media(prompt: str, filepath: str, mime_candidates: list) -> str:
    """Мультимодальный анализ фото/аудио/видео."""
    media = await _upload_media(filepath, mime_candidates[0])

    last_err = None
    for mime in mime_candidates:
        payload = {"contents": [{"parts": [
            {"text": prompt},
            {"file_data": {"mime_type": mime, "file_uri": media["uri"]}},
        ]}]}
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                GEMINI_URL.format(model=settings.GEMINI_MODEL),
                headers={"x-goog-api-key": settings.GEMINI_API_KEY},
                json=payload,
            )
        if resp.status_code == 200:
            return _extract_text(resp.json())
        last_err = f"Ошибка Gemini {resp.status_code}: {resp.text[:300]}"
        if resp.status_code == 400:
            continue
        break

    raise AIError(last_err or "Gemini не смог обработать файл")