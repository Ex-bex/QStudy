"""Server-side administrator checks for every management and transfer action."""
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, StrictBool
from sqlalchemy.orm import Session
from app.auth import require_admin
from app.database import get_db
from app.services import managed, transfers
from app.services.audit import record_audit

router = APIRouter(prefix="/admin/system", tags=["system"], dependencies=[Depends(require_admin)])


class ImportApply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    include_settings: StrictBool = True


def _error(error, status=409):
    return HTTPException(status, str(error))


def _audit(db, actor, action, object_id=None, fields=()):
    record_audit(db, actor, action, "system", object_id, fields=fields)
    db.commit()


@router.get("/status")
def status():
    return managed.managed_status()


@router.get("/settings")
def read_settings():
    try:
        return managed.settings_public()
    except managed.ManagementError as error:
        raise _error(error)


@router.patch("/settings")
def save_settings(data: dict = Body(...), admin=Depends(require_admin), db: Session = Depends(get_db)):
    try:
        result = managed.update_settings(data)
        _audit(db, admin, "system.settings_update", fields=[key.lower() for key in data])
        return result
    except managed.ManagementError as error:
        raise _error(error, 422)


@router.post("/restart", status_code=202)
def restart(admin=Depends(require_admin), db: Session = Depends(get_db)):
    try:
        actor_id = admin.id
        _audit(db, admin, "system.restart")
        return managed.request_control("restart", actor_id)
    except managed.ManagementError as error:
        raise _error(error)


@router.post("/stop", status_code=202)
def stop(admin=Depends(require_admin), db: Session = Depends(get_db)):
    try:
        actor_id = admin.id
        _audit(db, admin, "system.stop")
        return managed.request_control("stop", actor_id)
    except managed.ManagementError as error:
        raise _error(error)


@router.post("/imports", status_code=201)
async def upload_import(request: Request, admin=Depends(require_admin)):
    if request.headers.get("content-type", "").split(";", 1)[0].lower() not in ("application/zip", "application/octet-stream"):
        raise HTTPException(415, "Загрузите ZIP как application/zip")
    try:
        return await transfers.receive_import(request, admin.id)
    except (transfers.TransferError, managed.ManagementError) as error:
        raise _error(error, 422)


@router.get("/imports/{transfer_id}")
def import_preview(transfer_id: str):
    try:
        return transfers.preview_import(transfer_id)
    except (transfers.TransferError, managed.ManagementError) as error:
        raise _error(error, 404)


@router.post("/imports/{transfer_id}/apply", status_code=202)
def apply_import(transfer_id: str, data: ImportApply, admin=Depends(require_admin), db: Session = Depends(get_db)):
    try:
        actor_id = admin.id
        _audit(db, admin, "system.import_request", transfer_id)
        return transfers.queue_import(transfer_id, actor_id, data.include_settings)
    except (transfers.TransferError, managed.ManagementError) as error:
        raise _error(error)


@router.get("/exports/project/download")
def download_project(admin=Depends(require_admin), db: Session = Depends(get_db)):
    try:
        path = transfers.export_project()
        _audit(db, admin, "system.project_export")
        return FileResponse(path, media_type="application/zip", filename=path.name, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    except (transfers.TransferError, managed.ManagementError) as error:
        raise _error(error)
