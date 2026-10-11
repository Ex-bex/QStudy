"""One-time import of the supplied, reviewed 2026 introduction syllabus.

The mapping in app/data was extracted from source tables 5 and 6. No dates,
rooms, teacher office hours, or inferred weekly study hours become timetable
records. This migration never rewrites records an administrator has edited.
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import settings
from app.models import AcademicSetting, Course, CurriculumWeek, ModuleWork, StudentGroup, SyllabusDocument
from app.services.syllabus import ACCESS_DATA_WARNING, SyllabusDraft, extract_syllabus_bytes
from app.storage import relative_upload_path

REFERENCE_KEY = "reference_intro_2026_v1"
REFERENCE_DATA = Path(__file__).resolve().parents[1] / "data" / "introduction_2026.json"


def seed_sourced_curriculum(db: Session, source_path: Path | None = None, upload_dir: str | None = None) -> dict:
    if db.get(AcademicSetting, REFERENCE_KEY):
        return {"imported": False, "reason": "already_imported"}
    mapping = json.loads(REFERENCE_DATA.read_text(encoding="utf-8"))
    project_root = Path(__file__).resolve().parents[3]
    source = source_path or (project_root / "local-documents" / mapping["source_filename"])
    if source_path is None and not source.is_file():
        source = project_root / mapping["source_filename"]
    if not source.is_file():
        return {"imported": False, "reason": "source_missing"}
    content = source.read_bytes()
    if hashlib.sha256(content).hexdigest() != mapping["source_sha256"]:
        return {"imported": False, "reason": "source_changed"}
    group = db.query(StudentGroup).filter_by(name=mapping["group_name"]).first()
    if group is None:
        return {"imported": False, "reason": "group_missing"}
    if db.query(Course).filter_by(group_id=group.id, title=mapping["course"]["title"]).first():
        db.add(AcademicSetting(key=REFERENCE_KEY, value="existing_course_preserved"))
        db.commit()
        return {"imported": False, "reason": "existing_course_preserved"}
    draft = SyllabusDraft.model_validate(mapping["draft"])
    extracted, warnings = extract_syllabus_bytes(content, ".docx")
    directory = (Path(upload_dir or settings.UPLOAD_DIR) / "syllabi").resolve()
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (uuid.uuid4().hex + ".docx")
    destination.write_bytes(content)
    try:
        course = Course(group_id=group.id, **mapping["course"])
        db.add(course)
        db.flush()
        syllabus = SyllabusDocument(course_id=course.id, title=draft.title, filename=mapping["source_filename"],
                                     filepath=relative_upload_path(destination, upload_dir or settings.UPLOAD_DIR), size=len(content), source_sha256=mapping["source_sha256"],
                                     source_restricted=ACCESS_DATA_WARNING in warnings, extracted_text=extracted,
                                     summary=draft.summary, status="published", draft_json=draft.model_dump_json(),
                                     warnings_json=json.dumps(mapping["warnings"] + warnings, ensure_ascii=False),
                                     published_at=datetime.now(timezone.utc).replace(tzinfo=None))
        db.add(syllabus)
        db.flush()
        for week in draft.weeks:
            db.add(CurriculumWeek(course_id=course.id, source_syllabus_id=syllabus.id, **week.model_dump()))
        for work in draft.works:
            db.add(ModuleWork(course_id=course.id, source_syllabus_id=syllabus.id, **work.model_dump()))
        db.add(AcademicSetting(key=REFERENCE_KEY, value=json.dumps({"course_id": course.id, "syllabus_id": syllabus.id})))
        db.commit()
    except Exception:
        db.rollback()
        destination.unlink(missing_ok=True)
        raise
    return {"imported": True, "course_id": course.id, "weeks": len(draft.weeks), "works": len(draft.works)}
