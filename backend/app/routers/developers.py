"""Public developer directory with administrator-only, audited editing."""
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy.orm import Session, load_only

from app.auth import require_admin
from app.database import get_db
from app.models import BrandingAsset, DeveloperDepartment
from app.services.audit import record_audit
from app.services.branding import asset_url, department_asset_key
from app.services.web_research import safe_source_url

router = APIRouter(prefix="/developers", tags=["developers"])
Logo = Literal["main", "coding", "tech", "press", "business"]
_TELEGRAM = re.compile(r"^(?:@|https://t\.me/)?([A-Za-z][A-Za-z0-9_]{4,31})$")


class DepartmentInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=120)
    director: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=4000)
    email: EmailStr | Literal[""] = ""
    telegram: str = Field(default="", max_length=100)
    website: str = Field(default="", max_length=2048)
    logo: Logo = "main"
    display_order: int = Field(default=0, ge=0, le=10000, strict=True)

    @field_validator("website")
    @classmethod
    def public_website(cls, value):
        if not value:
            return ""
        safe = safe_source_url(value)
        if safe is None:
            raise ValueError("Укажите публичный HTTP(S) сайт без паролей и служебных адресов")
        return safe

    @field_validator("telegram")
    @classmethod
    def public_telegram(cls, value):
        if not value:
            return ""
        match = _TELEGRAM.fullmatch(value)
        if match is None:
            raise ValueError("Telegram: @username или https://t.me/username, от 5 до 32 символов")
        return "https://t.me/" + match.group(1)


class DepartmentUpdate(DepartmentInput):
    # Omitted fields stay unchanged; explicit null is rejected for every field.
    name: str = Field(default="", min_length=1, max_length=120)


def department_public(row: DeveloperDepartment, db: Session, *, assets=None) -> dict:
    logo_extension = "png" if row.logo == "main" else "jpeg"
    key = department_asset_key(row.id)
    asset = assets.get(key) if assets is not None else db.get(
        BrandingAsset, key, options=(load_only(BrandingAsset.key, BrandingAsset.digest),))
    return {"id": row.id, "name": row.name, "director": row.director,
            "description": row.description, "email": row.email,
            "telegram": row.telegram, "website": row.website, "logo": row.logo,
            "logo_url": asset_url(asset) if asset else f"/brand/qforce_logo_{row.logo}.{logo_extension}",
            "logo_custom": asset is not None, "display_order": row.display_order}


def _department(db, department_id):
    row = db.get(DeveloperDepartment, department_id)
    if row is None:
        raise HTTPException(404, "Подразделение не найдено")
    return row


@router.get("")
def list_developers(db: Session = Depends(get_db)):
    rows = db.query(DeveloperDepartment).order_by(DeveloperDepartment.display_order, DeveloperDepartment.id).all()
    assets = {asset.key: asset for asset in db.query(BrandingAsset).options(
        load_only(BrandingAsset.key, BrandingAsset.digest)).filter(
            BrandingAsset.department_id.in_([row.id for row in rows])).all()}
    return {"departments": [department_public(row, db, assets=assets) for row in rows]}


@router.post("/departments", status_code=201)
def create_department(data: DepartmentInput, db: Session = Depends(get_db), admin=Depends(require_admin)):
    row = DeveloperDepartment(**data.model_dump())
    db.add(row)
    db.flush()
    record_audit(db, admin, "developer_department.create", "developer_department", row.id,
                 fields=data.model_fields_set)
    db.commit()
    db.refresh(row)
    return department_public(row, db)


@router.patch("/departments/{department_id}")
def update_department(department_id: int, data: DepartmentUpdate,
                      db: Session = Depends(get_db), admin=Depends(require_admin)):
    row = _department(db, department_id)
    changes = data.model_dump(exclude_unset=True)
    for name, value in changes.items():
        setattr(row, name, value)
    if changes:
        record_audit(db, admin, "developer_department.update", "developer_department", row.id,
                     fields=changes.keys())
    db.commit()
    db.refresh(row)
    return department_public(row, db)


@router.delete("/departments/{department_id}")
def delete_department(department_id: int, db: Session = Depends(get_db), admin=Depends(require_admin)):
    row = _department(db, department_id)
    record_audit(db, admin, "developer_department.delete", "developer_department", row.id)
    asset = db.get(BrandingAsset, department_asset_key(row.id))
    if asset is not None:
        db.delete(asset)
    db.delete(row)
    db.commit()
    return {"ok": True}
