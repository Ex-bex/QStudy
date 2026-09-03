from fastapi import APIRouter, Depends
from app.auth import get_current_user
from app.services.background import claim_notifications

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
def get_notifications(user=Depends(get_current_user)):
    return claim_notifications(user.id)