from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.services.learning_context import learning_options

router = APIRouter(prefix="/learning", tags=["learning"])


@router.get("/options")
def options(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return learning_options(db, user)
