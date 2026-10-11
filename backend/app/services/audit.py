"""Small explicit, transaction-bound audit API; never captures request bodies."""
import json
import re
from sqlalchemy import text
from app.operational_models import AuditLog

_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_.:-]{0,99}$")
_FIELD = re.compile(r"^[a-z][a-z0-9_]{0,59}$")
_PRIVATE_FIELDS = {"password", "hashed_password", "token", "token_version", "secret_key", "content", "extracted_text", "source_raw", "feedback", "answer", "question"}
_NUMBER_METADATA = {"course_id", "group_id", "week_id", "work_id", "syllabus_id", "job_id", "count", "weeks_created", "works_created", "users_created", "size_bytes"}
_ENUM_METADATA = {
    "source": {"manual", "syllabus", "startup", "scheduled", "upgrade"},
    "status": {"draft", "published", "submitted", "graded", "completed", "failed", "pending", "running", "ready"},
    "role": {"admin", "student"},
}


def initialize_operations(engine):
    AuditLog.__table__.create(bind=engine, checkfirst=True)
    if engine.dialect.name == "sqlite":
        with engine.begin() as connection:
            for operation in ("UPDATE", "DELETE"):
                connection.execute(text(f"""CREATE TRIGGER IF NOT EXISTS audit_logs_no_{operation.lower()}
                    BEFORE {operation} ON audit_logs BEGIN
                    SELECT RAISE(ABORT, 'audit logs are immutable'); END"""))


def record_audit(db, actor, action: str, object_type: str, object_id=None, *, fields=(), metadata=None):
    """Add one event to the caller's transaction. A rollback removes the event too.

    Store changed field *names*, IDs, counts and predefined enums, never the
    user's document, password, token, old/new field contents or full payload.
    """
    if not _IDENTIFIER.fullmatch(action) or not _IDENTIFIER.fullmatch(object_type):
        raise ValueError("Invalid audit action or object type")
    if isinstance(actor, int):
        from app.models import User
        actor = db.get(User, actor)
    clean_fields = sorted({name for name in fields if isinstance(name, str) and _FIELD.fullmatch(name) and name not in _PRIVATE_FIELDS})
    clean_metadata = {}
    for key, value in (metadata or {}).items():
        if key in _NUMBER_METADATA and isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            clean_metadata[key] = value
        elif key in _ENUM_METADATA and isinstance(value, str) and value in _ENUM_METADATA[key]:
            clean_metadata[key] = value
        elif key == "is_active" and isinstance(value, bool):
            clean_metadata[key] = value
    row = AuditLog(
        actor_id=getattr(actor, "id", None), actor_label=str(getattr(actor, "email", None) or "Система")[:200],
        action=action, object_type=object_type, object_id=str(object_id)[:100] if object_id is not None else None,
        fields_json=json.dumps(clean_fields, ensure_ascii=False), metadata_json=json.dumps(clean_metadata, ensure_ascii=False),
    )
    db.add(row)
    return row


def audit_public(row: AuditLog):
    return {
        "id": row.id, "created_at": row.created_at.isoformat() + "Z", "actor_id": row.actor_id,
        "actor_label": row.actor_label, "action": row.action, "object_type": row.object_type,
        "object_id": row.object_id, "fields": json.loads(row.fields_json), "metadata": json.loads(row.metadata_json),
    }
