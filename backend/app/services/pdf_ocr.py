"""Bounded local PDF scan recognition using the installed Windows OCR engine.

Native text stays native. Only image/drawing pages with almost no text are
rendered; neither documents nor recognized text are sent to a cloud service.
"""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

import pymupdf

MAX_OCR_PAGES = 50
MAX_IMAGE_DIMENSION = 3200
MAX_CHARS = 200_000
MAX_SECONDS = 480
MIN_NATIVE_CHARS = 30
_HELPER = Path(__file__).resolve().parents[3] / "scripts" / "qstudy_ocr.ps1"
_CONTRAST_LUT = bytes(round(255 * (value / 255) ** 3) for value in range(256))


class PDFOCRError(ValueError):
    """A public extraction error; never includes document text or OS stderr."""


def _printable_count(text: str) -> int:
    return sum(character.isprintable() and not character.isspace() for character in text)


def _enhance_scan(image: pymupdf.Pixmap) -> pymupdf.Pixmap:
    """Darken pale print while preserving white paper and black text.

    A fixed grayscale gamma curve improves faint scanned tables without hard
    thresholding away thin strokes. It uses a bounded byte LUT, not another
    dependency, and does not select recognition results by their length.
    """
    if image.n != 1 or image.alpha:
        raise ValueError("OCR contrast requires an opaque grayscale image")
    return pymupdf.Pixmap(pymupdf.csGRAY, image.width, image.height,
                         image.samples.translate(_CONTRAST_LUT), False)


def _remaining(started: float) -> float:
    remaining = MAX_SECONDS - (time.monotonic() - started)
    if remaining <= 0:
        raise PDFOCRError("Локальное распознавание PDF заняло слишком долго. Разделите документ и повторите попытку")
    return remaining


def _windows_powershell() -> Path:
    if os.name != "nt":
        raise PDFOCRError("Распознавание сканов PDF доступно через локальное OCR Windows 10/11. Добавьте текстовый слой PDF или используйте компьютер с Windows")
    # Obtain the real Windows directory from the OS, never from PATH or a
    # caller-controlled SystemRoot environment variable.
    buffer = ctypes.create_unicode_buffer(32768)
    try:
        size = ctypes.windll.kernel32.GetWindowsDirectoryW(buffer, len(buffer))
    except (AttributeError, OSError):
        size = 0
    if not size or size >= len(buffer):
        raise PDFOCRError("Не удалось найти системный Windows PowerShell для локального OCR")
    executable = Path(buffer.value) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if not executable.is_file():
        raise PDFOCRError("Системный Windows PowerShell 5.1 недоступен. Добавьте текстовый слой PDF и повторите попытку")
    return executable


def _recognize_images(pages: list[dict], directory: Path, started: float) -> dict[int, str]:
    executable = _windows_powershell()
    if not _HELPER.is_file():
        raise PDFOCRError("Локальный модуль OCR не установлен. Скопируйте папку scripts вместе с проектом")
    manifest = directory / "request.json"
    manifest.write_text(json.dumps({"format": 1, "pages": pages,
                                    "timeout_seconds": max(1, int(_remaining(started)))}, ensure_ascii=False), encoding="utf-8")
    os.chmod(manifest, 0o600)
    try:
        result = subprocess.run(
            [str(executable), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", str(_HELPER), "-ManifestPath", str(manifest)],
            shell=False, capture_output=True, text=True, encoding="utf-8", errors="strict",
            timeout=_remaining(started), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        raise PDFOCRError("Локальное распознавание PDF заняло слишком долго. Разделите документ и повторите попытку") from None
    except (OSError, UnicodeError):
        raise PDFOCRError("Не удалось запустить локальное OCR Windows. Проверьте доступность Windows PowerShell 5.1") from None
    try:
        if len(result.stdout) > MAX_CHARS * 8:
            raise ValueError("oversized OCR response")
        response = json.loads(result.stdout.lstrip("\ufeff"))
        if not isinstance(response, dict):
            raise ValueError("invalid OCR response")
    except (TypeError, ValueError):
        raise PDFOCRError("Локальное OCR вернуло некорректный результат. Повторите распознавание PDF") from None
    if result.returncode or response.get("ok") is not True:
        error = response.get("error")
        if error == "missing_russian_language":
            raise PDFOCRError("В Windows не установлен русский язык для OCR. Установите русский пакет распознавания в параметрах языка Windows и повторите попытку")
        if error == "timeout":
            raise PDFOCRError("Локальное распознавание PDF заняло слишком долго. Разделите документ и повторите попытку")
        if error == "text_limit":
            raise PDFOCRError("В PDF слишком много текста для распознавания. Разделите документ на части")
        raise PDFOCRError("Локальное OCR Windows не смогло прочитать PDF. Проверьте качество скана и русский пакет распознавания")
    try:
        if not isinstance(response.get("language"), str) or not response["language"].lower().startswith("ru"):
            raise ValueError("unexpected OCR language")
        expected = {page["index"] for page in pages}
        recognized = {}
        if not isinstance(response.get("pages"), list):
            raise ValueError("missing OCR pages")
        total = 0
        for page in response["pages"]:
            if not isinstance(page, dict) or type(page.get("index")) is not int:
                raise ValueError("invalid OCR page")
            index, lines = page["index"], page.get("lines")
            if index not in expected or index in recognized or not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
                raise ValueError("unexpected OCR page")
            text = "\n".join(line.replace("\x00", "").strip() for line in lines if line.strip()).strip()
            total += len(text)
            if total > MAX_CHARS:
                raise PDFOCRError("В PDF слишком много текста для распознавания. Разделите документ на части")
            recognized[index] = text
        if set(recognized) != expected:
            raise ValueError("incomplete OCR result")
        return recognized
    except (KeyError, TypeError, ValueError) as error:
        if isinstance(error, PDFOCRError):
            raise
        raise PDFOCRError("Локальное OCR вернуло неполный результат. Повторите распознавание PDF") from None


def recognize_pdf(path: Path, page_indices=None) -> tuple[str, list[str]]:
    """Extract selected zero-based pages in document order, with local OCR.

    Russian OCR is required for scans. Empty pages do not produce fabricated
    text or page headings. Image staging is deleted on both success and error.
    """
    started = time.monotonic()
    warnings: list[str] = []
    native: dict[int, str] = {}
    scans: list[dict] = []
    try:
        with pymupdf.open(Path(path)) as document, tempfile.TemporaryDirectory(prefix="qstudy-ocr-") as temporary:
            if document.needs_pass:
                raise PDFOCRError("PDF защищён паролем. Сохраните доступную копию документа и повторите попытку")
            count = len(document)
            if page_indices is None:
                selected = list(range(count))
            else:
                selected = list(page_indices)
                if any(type(index) is not int or index < 0 or index >= count for index in selected):
                    raise PDFOCRError("Некорректный список страниц PDF для распознавания")
                selected = sorted(set(selected))
            directory = Path(temporary)
            os.chmod(directory, 0o700)
            native_total = 0
            for index in selected:
                _remaining(started)
                page = document[index]
                text = page.get_text("text", sort=True).replace("\x00", "").strip()
                native[index] = text
                native_total += len(text)
                if native_total > MAX_CHARS:
                    raise PDFOCRError("В PDF слишком много текста. Разделите документ на части")
                if _printable_count(text) >= MIN_NATIVE_CHARS or not (page.get_images() or page.get_drawings()):
                    continue
                if len(scans) >= MAX_OCR_PAGES:
                    raise PDFOCRError("В PDF больше 50 страниц со сканами. Разделите документ на части")
                long_side = max(page.rect.width, page.rect.height)
                if long_side <= 0:
                    raise PDFOCRError("PDF содержит страницу с некорректным размером")
                scale = (MAX_IMAGE_DIMENSION - 2) / long_side
                image = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csGRAY, alpha=False)
                image = _enhance_scan(image)
                if max(image.width, image.height) > MAX_IMAGE_DIMENSION:
                    raise PDFOCRError("Не удалось подготовить страницу PDF допустимого размера")
                image_path = directory / f"page-{index + 1}.png"
                image.save(image_path)
                os.chmod(image_path, 0o600)
                scans.append({"index": index, "path": str(image_path)})
                del image
            recognized = _recognize_images(scans, directory, started) if scans else {}
            if scans:
                numbers = ", ".join(str(page["index"] + 1) for page in scans)
                warnings.append(f"Применено локальное OCR Windows: страницы {numbers}, усилен контраст сканов. Проверьте названия, числа и таблицы по оригиналу PDF")
            parts = []
            total = 0
            for index in selected:
                text = recognized.get(index, native[index])
                if not _printable_count(text):
                    if index in recognized:
                        warnings.append(f"На странице {index + 1} OCR не обнаружило читаемого текста")
                    continue
                part = f"### Страница {index + 1}" + (" (OCR)" if index in recognized else "") + "\n" + text
                total += len(part) + (2 if parts else 0)
                if total > MAX_CHARS:
                    raise PDFOCRError("В PDF слишком много текста. Разделите документ на части")
                parts.append(part)
            _remaining(started)
            return "\n\n".join(parts), warnings
    except PDFOCRError:
        raise
    except (OSError, TypeError, ValueError, RuntimeError):
        raise PDFOCRError("Не удалось прочитать PDF для локального распознавания. Проверьте, что документ не повреждён") from None
