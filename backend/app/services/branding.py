"""Strict PNG normalization and public, content-addressed logo URLs."""
import hashlib
import io
import warnings
from dataclasses import dataclass

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import load_only

from app.models import BrandingAsset

MAX_LOGO_BYTES = 2 * 1024 * 1024
MIN_SIDE = 32
MAX_SIDE = 4096
MAX_PIXELS = 4 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DEFAULT_PROJECT_LOGO = "/brand/qforce_logo_main.png"
DEFAULT_CAREER_LOGO = "/brand/qcareer-placeholder.svg"
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"


@dataclass(frozen=True)
class NormalizedLogo:
    payload: bytes
    digest: str
    width: int
    height: int


def normalize_png(content: bytes) -> NormalizedLogo:
    """Decode pixels and re-encode without names, metadata or trailing content."""
    if len(content) > MAX_LOGO_BYTES:
        raise HTTPException(413, "PNG должен занимать не более 2 МБ")
    if not content.startswith(PNG_SIGNATURE):
        raise HTTPException(422, "Загрузите PNG с прозрачным фоном")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as image:
                if image.format != "PNG":
                    raise HTTPException(422, "Загрузите PNG с прозрачным фоном")
                width, height = image.size
                if not (MIN_SIDE <= width <= MAX_SIDE and MIN_SIDE <= height <= MAX_SIDE) or width * height > MAX_PIXELS:
                    raise HTTPException(422, "Размер PNG: от 32 до 4096 пикселей по каждой стороне, до 4 мегапикселей")
                if getattr(image, "is_animated", False) or getattr(image, "n_frames", 1) != 1:
                    raise HTTPException(422, "Анимированные PNG не поддерживаются")
                image.verify()
            with Image.open(io.BytesIO(content)) as image:
                image.load()
                rgba = image.convert("RGBA")
                minimum, maximum = rgba.getchannel("A").getextrema()
                if minimum == 255:
                    raise HTTPException(422, "У PNG должен быть прозрачный фон")
                if maximum == 0:
                    raise HTTPException(422, "PNG полностью прозрачный: логотип не виден")
                # A fresh image has no EXIF, text chunks, ICC profile or input info.
                normalized = Image.new("RGBA", (width, height))
                normalized.paste(rgba)
                output = io.BytesIO()
                normalized.save(output, format="PNG", compress_level=6)
                payload = output.getvalue()
        if len(payload) > MAX_LOGO_BYTES:
            raise HTTPException(413, "После обработки PNG превышает 2 МБ; уменьшите размер изображения")
        return NormalizedLogo(payload, hashlib.sha256(payload).hexdigest(), width, height)
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning) as error:
        raise HTTPException(422, "PNG повреждён или имеет неподдерживаемый формат") from error


def asset_url(asset: BrandingAsset) -> str:
    return f"/api/branding/assets/{asset.key}/{asset.digest}.png"


def project_branding(db) -> dict:
    asset = db.get(BrandingAsset, "project", options=(load_only(BrandingAsset.key, BrandingAsset.digest),))
    return {"project_logo_url": asset_url(asset) if asset else DEFAULT_PROJECT_LOGO,
            "project_logo_custom": asset is not None}


def career_branding(db) -> dict:
    asset = db.get(BrandingAsset, "qcareer", options=(load_only(BrandingAsset.key, BrandingAsset.digest),))
    return {"logo_url": asset_url(asset) if asset else DEFAULT_CAREER_LOGO,
            "logo_custom": asset is not None}


def department_asset_key(department_id: int) -> str:
    return f"department-{department_id}"


def put_asset(db, key: str, logo: NormalizedLogo, admin_id: int):
    asset = db.get(BrandingAsset, key)
    if asset is None:
        asset = BrandingAsset(key=key, department_id=int(key[11:]) if key.startswith("department-") else None)
        db.add(asset)
    asset.digest, asset.payload = logo.digest, logo.payload
    asset.width, asset.height = logo.width, logo.height
    asset.uploaded_by = admin_id
    return asset
