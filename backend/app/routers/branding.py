"""Public sanitized logos; administrator-only replacement and reset."""
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Path, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.auth import require_admin
from app.database import get_db
from app.models import BrandingAsset
from app.routers.developers import _department, department_public
from app.services.audit import record_audit
from app.services.branding import (IMMUTABLE_CACHE, MAX_LOGO_BYTES, department_asset_key,
                                  director_photo_asset_key, normalize_director_photo, normalize_png,
                                  project_branding, career_branding, tests_branding, message_branding, ecosystem_branding, put_asset)

router = APIRouter(prefix="/branding", tags=["branding"])
AssetKey = Annotated[str, Path(pattern=r"^(?:project|qcareer|qtests|qmessage|qid|qcontrol|qforce|(?:department|director)-[1-9][0-9]{0,18})$")]
Digest = Annotated[str, Path(pattern=r"^[a-f0-9]{64}$")]


async def _upload(file: UploadFile, *, director_photo=False):
    try:
        content = await file.read(MAX_LOGO_BYTES + 1)
    finally:
        await file.close()
    return await run_in_threadpool(normalize_director_photo if director_photo else normalize_png, content)


def _persist(db, admin, key, logo, *, department_id=None):
    try:
        if logo is None:
            asset = db.get(BrandingAsset, key)
            if asset is not None:
                db.delete(asset)
        else:
            put_asset(db, key, logo, admin.id)
        is_photo = key.startswith("director-")
        action = ("branding.director_photo" if is_photo else
                  "branding.department_logo" if department_id is not None else
                  "branding.career_logo" if key == "qcareer" else
                  "branding.identity_logo" if key == "qid" else
                  "branding.force_logo" if key == "qforce" else
                  "branding.control_logo" if key == "qcontrol" else "branding.project_logo")
        if key == "qtests":
            action = "branding.tests_logo"
        elif key == "qmessage":
            action = "branding.message_logo"
        record_audit(db, admin, action + (".reset" if logo is None else ".upload"),
                     "developer_department" if department_id is not None else "branding",
                     department_id if department_id is not None else key,
                     fields=("director_photo" if is_photo else "logo",),
                     metadata={"size_bytes": len(logo.payload)} if logo else {})
        db.commit()
    except Exception:
        db.rollback()
        raise


@router.get("")
def branding(db: Session = Depends(get_db)):
    return project_branding(db)


@router.get("/ecosystem")
def ecosystem(db: Session = Depends(get_db)):
    return ecosystem_branding(db)


@router.get("/tests")
def tests_logo(db: Session = Depends(get_db)):
    return tests_branding(db)


@router.get("/message")
def message_logo(db: Session = Depends(get_db)):
    return message_branding(db)


@router.put("/message-logo")
async def upload_message_logo(file: UploadFile = File(...), db: Session = Depends(get_db), admin=Depends(require_admin)):
    logo = await _upload(file)
    _persist(db, admin, "qmessage", logo)
    return message_branding(db)


@router.delete("/message-logo")
def reset_message_logo(db: Session = Depends(get_db), admin=Depends(require_admin)):
    _persist(db, admin, "qmessage", None)
    return message_branding(db)


@router.put("/force-logo")
async def upload_force_logo(file: UploadFile = File(...), db: Session = Depends(get_db), admin=Depends(require_admin)):
    logo = await _upload(file)
    _persist(db, admin, "qforce", logo)
    return ecosystem_branding(db)


@router.delete("/force-logo")
def reset_force_logo(db: Session = Depends(get_db), admin=Depends(require_admin)):
    _persist(db, admin, "qforce", None)
    return ecosystem_branding(db)


@router.put("/tests-logo")
async def upload_tests_logo(file: UploadFile = File(...), db: Session = Depends(get_db), admin=Depends(require_admin)):
    logo = await _upload(file)
    _persist(db, admin, "qtests", logo)
    return tests_branding(db)


@router.delete("/tests-logo")
def reset_tests_logo(db: Session = Depends(get_db), admin=Depends(require_admin)):
    _persist(db, admin, "qtests", None)
    return tests_branding(db)


@router.put("/identity-logo")
async def upload_identity_logo(file: UploadFile = File(...), db: Session = Depends(get_db), admin=Depends(require_admin)):
    logo = await _upload(file)
    _persist(db, admin, "qid", logo)
    return ecosystem_branding(db)


@router.delete("/identity-logo")
def reset_identity_logo(db: Session = Depends(get_db), admin=Depends(require_admin)):
    _persist(db, admin, "qid", None)
    return ecosystem_branding(db)


@router.put("/control-logo")
async def upload_control_logo(file: UploadFile = File(...), db: Session = Depends(get_db), admin=Depends(require_admin)):
    logo = await _upload(file)
    _persist(db, admin, "qcontrol", logo)
    return ecosystem_branding(db)


@router.delete("/control-logo")
def reset_control_logo(db: Session = Depends(get_db), admin=Depends(require_admin)):
    _persist(db, admin, "qcontrol", None)
    return ecosystem_branding(db)


@router.put("/project-logo")
async def upload_project_logo(file: UploadFile = File(...), db: Session = Depends(get_db), admin=Depends(require_admin)):
    logo = await _upload(file)
    _persist(db, admin, "project", logo)
    return project_branding(db)


@router.put("/career-logo")
async def upload_career_logo(file: UploadFile = File(...), db: Session = Depends(get_db), admin=Depends(require_admin)):
    logo = await _upload(file)
    _persist(db, admin, "qcareer", logo)
    return career_branding(db)


@router.delete("/career-logo")
def reset_career_logo(db: Session = Depends(get_db), admin=Depends(require_admin)):
    _persist(db, admin, "qcareer", None)
    return career_branding(db)


@router.delete("/project-logo")
def reset_project_logo(db: Session = Depends(get_db), admin=Depends(require_admin)):
    _persist(db, admin, "project", None)
    return project_branding(db)


@router.put("/departments/{department_id}/logo")
async def upload_department_logo(department_id: int, file: UploadFile = File(...),
                                 db: Session = Depends(get_db), admin=Depends(require_admin)):
    row = _department(db, department_id)
    logo = await _upload(file)
    _persist(db, admin, department_asset_key(row.id), logo, department_id=row.id)
    return department_public(row, db)


@router.delete("/departments/{department_id}/logo")
def reset_department_logo(department_id: int, db: Session = Depends(get_db), admin=Depends(require_admin)):
    row = _department(db, department_id)
    _persist(db, admin, department_asset_key(row.id), None, department_id=row.id)
    return department_public(row, db)


@router.put("/departments/{department_id}/director-photo")
async def upload_director_photo(department_id: int, file: UploadFile = File(...),
                                db: Session = Depends(get_db), admin=Depends(require_admin)):
    row = _department(db, department_id)
    photo = await _upload(file, director_photo=True)
    _persist(db, admin, director_photo_asset_key(row.id), photo, department_id=row.id)
    return department_public(row, db)


@router.delete("/departments/{department_id}/director-photo")
def reset_director_photo(department_id: int, db: Session = Depends(get_db), admin=Depends(require_admin)):
    row = _department(db, department_id)
    _persist(db, admin, director_photo_asset_key(row.id), None, department_id=row.id)
    return department_public(row, db)


@router.get("/assets/{key}/{digest}.png")
def public_asset(key: AssetKey, digest: Digest, request: Request, db: Session = Depends(get_db)):
    asset = db.get(BrandingAsset, key)
    if asset is None or asset.digest != digest:
        raise HTTPException(404, "Логотип не найден")
    if key.startswith("department-"):
        _department(db, int(key[11:]))
    elif key.startswith("director-"):
        _department(db, int(key[9:]))
    headers = {"Cache-Control": IMMUTABLE_CACHE, "ETag": f'"{digest}"',
               "X-Content-Type-Options": "nosniff"}
    if request.headers.get("if-none-match") in (headers["ETag"], "*"):
        return Response(status_code=304, headers=headers)
    return Response(content=asset.payload, media_type="image/png", headers=headers)
