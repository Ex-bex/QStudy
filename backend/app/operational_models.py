"""Operational records kept separately from student learning content."""
from datetime import datetime, timezone
from sqlalchemy import Column, DateTime, Integer, String, Text, event
from app.database import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), index=True)
    # An immutable snapshot deliberately has no user FK: deleting an account must
    # preserve the historical actor and cannot mutate old audit records.
    actor_id = Column(Integer, nullable=True, index=True)
    actor_label = Column(String(200), nullable=False, default="Система")
    action = Column(String(100), nullable=False, index=True)
    object_type = Column(String(60), nullable=False, index=True)
    object_id = Column(String(100), nullable=True)
    fields_json = Column(Text, nullable=False, default="[]")
    metadata_json = Column(Text, nullable=False, default="{}")


@event.listens_for(AuditLog, "before_update")
@event.listens_for(AuditLog, "before_delete")
def _immutable_audit(mapper, connection, target):
    raise ValueError("Записи журнала управления нельзя изменять или удалять")
