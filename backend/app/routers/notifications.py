from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.auth import get_current_user
from app.database import get_db
from app.job_models import AIJob
from app.services.background import claim_notifications, job_public

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
def get_notifications(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return claim_notifications(user.id, db)


@router.post("/{job_id}/ack")
def acknowledge_notification(job_id: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    job = db.query(AIJob).filter(AIJob.id == job_id, AIJob.user_id == user.id,
        AIJob.status.in_(("done", "error"))).first()
    if not job:
        raise HTTPException(404, "Уведомление не найдено")
    job.acknowledged_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@router.get("/jobs")
def list_jobs(db: Session = Depends(get_db), user=Depends(get_current_user)):
    rows = db.query(AIJob).filter(AIJob.user_id == user.id).order_by(AIJob.created_at.desc()).limit(100).all()
    return [job_public(job) for job in rows]


@router.get("/jobs/{job_id}")
def get_job(job_id: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    job = db.query(AIJob).filter(AIJob.id == job_id, AIJob.user_id == user.id).first()
    if not job:
        raise HTTPException(404, "Задача не найдена")
    return job_public(job)
