"""Shared curriculum is administrator-owned; student work is scoped to its owner."""
import json
import hashlib
import re
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import Field, model_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.auth import get_current_user, require_admin
from app.config import settings
from app.database import get_db
from app.job_models import AIJob
from app.models import (Course, CurriculumWeek, ModuleWork, ScheduleEntry, StudentGroup,
                        SyllabusDocument, User, WeekProgress, WorkSubmission)
from app.storage import relative_upload_path
from app.services import background
from app.services.audit import record_audit
from app.services.syllabus_import import KIND as SYLLABUS_JOB_KIND, queue_import, resource_key
from app.services.syllabus import (ACCESS_DATA_WARNING, MAX_SYLLABUS_BYTES, CourseFacts, DraftWork, StrictInput, SyllabusDraft,
                                   WeekInput, extract_syllabus_bytes, fill_missing_course_facts,
                                   safe_syllabus_path)

router = APIRouter(tags=["academic"])


class GroupInput(StrictInput):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=10000)
    academic_year: str = Field(default="", max_length=100)
    curator: str = Field(default="", max_length=200)
    program: str = Field(default="", max_length=300)
    study_year: int | None = Field(default=None, ge=1, le=8)
    semester: int | None = Field(default=None, ge=1, le=16)


class CourseInput(StrictInput):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=20000)
    teacher: str = Field(default="", max_length=200)
    credits: float = Field(default=0, ge=0, le=100, allow_inf_nan=False)
    color: str = Field(default="#4f46e5", pattern=r"^#[0-9a-fA-F]{6}$")


class ScheduleInput(StrictInput):
    course_id: int = Field(gt=0)
    day_of_week: int = Field(ge=1, le=7)
    start_time: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    end_time: str | None = Field(default=None, pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    start_times: list[str] = Field(default_factory=list, max_length=12)
    room: str = Field(default="", max_length=100)
    lesson_type: str = Field(default="Практика", min_length=1, max_length=100)
    week_pattern: Literal["every", "odd", "even", "unspecified"] = "every"
    teacher: str = Field(default="", max_length=200)
    notes: str = Field(default="", max_length=10000)

    @model_validator(mode="after")
    def valid_interval(self):
        if any(not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value) for value in self.start_times):
            raise ValueError("Время начала указывается в формате ЧЧ:ММ")
        self.start_times = sorted(set(self.start_times or [self.start_time]))
        if self.start_times[0] != self.start_time:
            raise ValueError("start_time должен совпадать с первым временем start_times")
        if self.end_time is not None and self.end_time <= self.start_times[-1]:
            raise ValueError("Время окончания должно быть позже начала")
        return self


class WorkInput(DraftWork):
    due_date: datetime | None = None

    @model_validator(mode="after")
    def normalize_due_date(self):
        if self.due_date is not None and self.due_date.tzinfo is not None:
            self.due_date = self.due_date.astimezone(timezone.utc).replace(tzinfo=None)
        return self


class SubmissionInput(StrictInput):
    content: str = Field(default="", max_length=100000)
    status: Literal["draft", "submitted"] = "draft"

    @model_validator(mode="after")
    def submitted_has_content(self):
        if self.status == "submitted" and not self.content.strip():
            raise ValueError("Добавьте ответ перед отправкой работы")
        return self


class GradeInput(StrictInput):
    grade: float | None = Field(default=None, ge=0, le=10000, allow_inf_nan=False)
    feedback: str = Field(default="", max_length=20000)


class ProgressInput(StrictInput):
    completed: bool = False
    note: str = Field(default="", max_length=10000)


class SyllabusInput(StrictInput):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    summary: str | None = Field(default=None, max_length=20000)
    draft: SyllabusDraft | None = None


class PublishInput(StrictInput):
    replace_existing: bool = False


def _get(db, model, identity, label="Запись"):
    record = db.get(model, identity)
    if record is None:
        raise HTTPException(404, f"{label} не найдена")
    return record


def _commit(db, actor=None, action=None, object_type=None, record=None, fields=None, metadata=None):
    try:
        if action:
            db.flush()
            record_audit(db, actor, action, object_type, getattr(record, "id", record), fields=fields or [], metadata=metadata or {})
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Такая запись уже существует или связана с другими данными")


def _update(record, payload):
    for key, value in payload.model_dump().items():
        setattr(record, key, value)


def _data(record, exclude=()):
    values = {column.name: getattr(record, column.name) for column in record.__table__.columns if column.name not in exclude}
    for name, value in values.items():
        if isinstance(value, datetime):
            # SQLite stores UTC without tzinfo; always make its meaning explicit on the wire.
            values[name] = value.replace(tzinfo=timezone.utc).isoformat() if value.tzinfo is None else value.astimezone(timezone.utc).isoformat()
    return values


def _group_data(db, group):
    return {**_data(group, ("warnings_json",)), "warnings": json.loads(group.warnings_json or "[]"),
            "student_count": db.query(User).filter(User.group_id == group.id, User.role == "student").count(),
            "course_count": db.query(Course).filter(Course.group_id == group.id).count()}


def _require_membership(db, user, course_id):
    course = _get(db, Course, course_id, "Дисциплина")
    if user.role != "admin" and user.group_id != course.group_id:
        raise HTTPException(403, "Личная работа доступна только в вашей группе. Обратитесь к администратору для назначения группы.")
    return course


def _work_data(db, work, user):
    course = db.get(Course, work.course_id)
    group = db.get(StudentGroup, course.group_id)
    submission = db.query(WorkSubmission).filter_by(work_id=work.id, user_id=user.id).first()
    return {**_data(work), "course_title": course.title, "group_id": group.id, "group_name": group.name,
            "my_submission": _data(submission) if submission else None,
            "submission_count": db.query(WorkSubmission).filter_by(work_id=work.id, status="submitted").count() if user.role == "admin" else None}


def _schedule_data(db, entry):
    course = db.get(Course, entry.course_id)
    return {**_data(entry, ("start_times_json", "warnings_json")), "course_title": course.title,
            "start_times": json.loads(entry.start_times_json or "[]") or [entry.start_time],
            "end_time": entry.end_time or None, "teacher": entry.teacher or course.teacher,
            "source_name": entry.source_file, "warnings": json.loads(entry.warnings_json or "[]"),
            "color": course.color, "group_id": course.group_id}


def _schedule_values(payload):
    values = payload.model_dump(exclude={"start_times"})
    values["start_times_json"] = json.dumps(payload.start_times)
    values["end_time"] = payload.end_time or ""
    return values


def _syllabus_data(db, document, include_text=False, admin=False):
    # Historical uploads may contain {} or malformed JSON. Normalize only the
    # response: publication still validates the untouched stored draft strictly.
    repaired = False
    try:
        stored = json.loads(document.draft_json or "{}")
    except (ValueError, TypeError):
        stored = {}
        repaired = True
    if not isinstance(stored, dict):
        stored = {}
        repaired = True
    if set(stored) - {"title", "summary", "weeks", "works", "course_facts"}:
        repaired = True

    def text_field(key, fallback, limit):
        nonlocal repaired
        value = stored.get(key, fallback)
        if not isinstance(value, str):
            repaired = True
            value = fallback
        if len(value) > limit:
            repaired = True
        return value[:limit]

    def rows(key, schema, limit):
        nonlocal repaired
        value = stored.get(key, [])
        if not isinstance(value, list):
            repaired = True
            return []
        if len(value) > limit:
            repaired = True
        result = []
        for item in value[:limit]:
            if not isinstance(item, dict):
                repaired = True
                continue
            candidate = {key: value for key, value in item.items() if key in schema.model_fields}
            if len(candidate) != len(item):
                repaired = True
            try:
                parsed = schema.model_validate(candidate).model_dump()
            except (ValueError, TypeError):
                repaired = True
                continue
            # Keep valid existing strings exactly as stored, including spacing,
            # while supplying missing field defaults and canonical numeric types.
            for key, normalized in parsed.items():
                original = item.get(key)
                if isinstance(original, str) and isinstance(normalized, str):
                    maximum = next((constraint.max_length for constraint in schema.model_fields[key].metadata
                                    if getattr(constraint, "max_length", None) is not None), len(original))
                    if len(original) <= maximum:
                        parsed[key] = original
                    else:
                        repaired = True
            result.append(parsed)
        return result

    facts = None
    stored_facts = stored.get("course_facts")
    if stored_facts is not None:
        if isinstance(stored_facts, dict):
            candidate = {key: value for key, value in stored_facts.items() if key in CourseFacts.model_fields}
            if len(candidate) != len(stored_facts):
                repaired = True
            try:
                facts = CourseFacts.model_validate(candidate).model_dump()
            except (ValueError, TypeError):
                repaired = True
        else:
            repaired = True
    draft = {"title": text_field("title", document.title or "", 200),
             "summary": text_field("summary", document.summary or "", 20000),
             "weeks": rows("weeks", WeekInput, 52), "works": rows("works", DraftWork, 200),
             "course_facts": facts}
    try:
        SyllabusDraft.model_validate(draft)
    except (ValueError, TypeError):
        repaired = True
    try:
        stored_warnings = json.loads(document.warnings_json or "[]")
    except (ValueError, TypeError):
        stored_warnings = []
        repaired = True
    if not isinstance(stored_warnings, list):
        stored_warnings = []
        repaired = True
    warnings = []
    for item in stored_warnings[:20]:
        if isinstance(item, str):
            warnings.append(item[:1000])
        else:
            repaired = True
    if len(stored_warnings) > 20 or any(isinstance(item, str) and len(item) > 1000 for item in stored_warnings[:20]):
        repaired = True
    if repaired:
        warnings = warnings[:19] + ["Черновик содержит некорректные поля: отображены только доступные данные. Исходный черновик сохранён; проверьте его перед публикацией."]
    course = db.get(Course, document.course_id)
    group = course.group if course is not None else None
    data = {**_data(document, ("filepath", "draft_json", "warnings_json", "extracted_text")),
            "course_title": course.title if course is not None else "",
            "group_id": course.group_id if course is not None else None,
            "group_name": group.name if group is not None else "",
            "warnings": warnings, "weeks": draft["weeks"], "course_facts": facts}
    if include_text:
        data["extracted_text"] = document.extracted_text
        data["draft"] = draft if admin else None
    if admin:
        job = db.query(AIJob).filter_by(kind=SYLLABUS_JOB_KIND, resource_key=resource_key(document)).order_by(AIJob.created_at.desc()).first()
        if job is not None:
            data["import_job"] = {"id": job.id, "status": job.status, "error": job.error or ""}
            if document.published_at is None and document.status == "queued":
                if job.status in ("queued", "running"):
                    data["status"] = job.status
                elif job.status in ("error", "cancelled"):
                    data["status"] = "import_error"
                    data["warnings"] = list(dict.fromkeys(data["warnings"][:19] + [(job.error or "Автоматический импорт не завершён. Повторите попытку.")[:1000]]))
    return data


def _remove_documents(documents):
    for document in documents:
        try:
            safe_syllabus_path(document.filepath, settings.UPLOAD_DIR).unlink(missing_ok=True)
        except (ValueError, OSError):
            # The database is authoritative; do not follow an unsafe historical path.
            pass


@router.get("/groups")
def groups(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return [_group_data(db, group) for group in db.query(StudentGroup).order_by(StudentGroup.name).all()]


@router.get("/academic/timetable-source")
def timetable_source(db: Session = Depends(get_db), user=Depends(get_current_user)):
    from app.services.reference_timetable import timetable_source_data
    return timetable_source_data(db)


@router.post("/groups", status_code=201)
def create_group(payload: GroupInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    group = StudentGroup(**payload.model_dump())
    db.add(group)
    _commit(db, user, "group.create", "group", group, fields=list(payload.model_fields_set))
    return _group_data(db, group)


@router.get("/groups/{group_id}")
def group_detail(group_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    group = _get(db, StudentGroup, group_id, "Группа")
    courses = db.query(Course).filter_by(group_id=group.id).order_by(Course.title).all()
    schedule = db.query(ScheduleEntry).join(Course).filter(Course.group_id == group.id).order_by(ScheduleEntry.day_of_week, ScheduleEntry.start_time).all()
    return {**_group_data(db, group), "courses": [_data(course) for course in courses], "schedule": [_schedule_data(db, entry) for entry in schedule]}


@router.put("/groups/{group_id}")
def update_group(group_id: int, payload: GroupInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    group = _get(db, StudentGroup, group_id, "Группа")
    _update(group, payload)
    _commit(db, user, "group.update", "group", group, fields=list(payload.model_fields_set))
    return _group_data(db, group)


@router.delete("/groups/{group_id}")
def delete_group(group_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    group = _get(db, StudentGroup, group_id, "Группа")
    documents = db.query(SyllabusDocument).join(Course).filter(Course.group_id == group.id).all()
    db.query(User).filter(User.group_id == group.id).update({User.group_id: None})
    db.delete(group)
    _commit(db, user, "group.delete", "group", group)
    _remove_documents(documents)
    return {"ok": True}


@router.post("/groups/{group_id}/courses", status_code=201)
def create_course(group_id: int, payload: CourseInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    _get(db, StudentGroup, group_id, "Группа")
    course = Course(group_id=group_id, **payload.model_dump())
    db.add(course)
    _commit(db, user, "course.create", "course", course, fields=list(payload.model_fields_set), metadata={"group_id": group_id})
    return _data(course)


@router.get("/courses/{course_id}")
def course_detail(course_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    course = _get(db, Course, course_id, "Дисциплина")
    weeks = db.query(CurriculumWeek).filter_by(course_id=course_id).order_by(CurriculumWeek.week_number).all()
    progress = {item.week_id: _data(item) for item in db.query(WeekProgress).join(CurriculumWeek).filter(CurriculumWeek.course_id == course_id, WeekProgress.user_id == user.id).all()}
    documents = db.query(SyllabusDocument).filter_by(course_id=course_id)
    if user.role != "admin":
        documents = documents.filter_by(status="published")
    return {**_data(course), "group_name": course.group.name,
            "weeks": [{**_data(week), "my_progress": progress.get(week.id)} for week in weeks],
            "works": [_work_data(db, work, user) for work in db.query(ModuleWork).filter_by(course_id=course_id).order_by(ModuleWork.week_number, ModuleWork.id).all()],
            "syllabi": [_syllabus_data(db, document, admin=user.role == "admin") for document in documents.order_by(SyllabusDocument.created_at.desc()).all()]}


@router.put("/courses/{course_id}")
def update_course(course_id: int, payload: CourseInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    course = _get(db, Course, course_id, "Дисциплина")
    _update(course, payload)
    _commit(db, user, "course.update", "course", course, fields=list(payload.model_fields_set))
    return _data(course)


@router.delete("/courses/{course_id}")
def delete_course(course_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    course = _get(db, Course, course_id, "Дисциплина")
    documents = list(course.syllabi)
    db.delete(course)
    _commit(db, user, "course.delete", "course", course)
    _remove_documents(documents)
    return {"ok": True}


def _validate_schedule(db, group_id, payload, excluding_id=None):
    course = _get(db, Course, payload.course_id, "Дисциплина")
    if course.group_id != group_id:
        raise HTTPException(422, "Дисциплина должна относиться к выбранной группе")
    # Imported snapshots can contain shared/subgroup lessons. Changing descriptive
    # fields must remain possible without rewriting those source clock slots.
    if excluding_id is not None:
        existing = db.get(ScheduleEntry, excluding_id)
        if existing is not None and all(getattr(existing, key) == value for key, value in _schedule_values(payload).items()
                                        if key in {"course_id", "day_of_week", "start_time", "end_time", "start_times_json", "week_pattern"}):
            return
    query = db.query(ScheduleEntry).join(Course).filter(Course.group_id == group_id, ScheduleEntry.day_of_week == payload.day_of_week)
    if excluding_id is not None:
        query = query.filter(ScheduleEntry.id != excluding_id)
    for entry in query.all():
        if {payload.week_pattern, entry.week_pattern} == {"odd", "even"}:
            continue
        starts = json.loads(entry.start_times_json or "[]") or [entry.start_time]
        overlaps = bool(set(starts) & set(payload.start_times))
        if entry.end_time:
            overlaps |= any(entry.start_time <= clock < entry.end_time for clock in payload.start_times)
        if payload.end_time:
            overlaps |= any(payload.start_time <= clock < payload.end_time for clock in starts)
        if overlaps:
            raise HTTPException(409, "В расписании группы уже есть занятие в это время")


@router.post("/groups/{group_id}/schedule", status_code=201)
def create_schedule(group_id: int, payload: ScheduleInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    _get(db, StudentGroup, group_id, "Группа")
    _validate_schedule(db, group_id, payload)
    entry = ScheduleEntry(**_schedule_values(payload))
    db.add(entry)
    _commit(db, user, "schedule.create", "schedule", entry, fields=list(payload.model_fields_set), metadata={"group_id": group_id})
    return _schedule_data(db, entry)


@router.get("/groups/{group_id}/schedule")
def group_schedule(group_id: int, on: date | None = Query(default=None), db: Session = Depends(get_db), user=Depends(get_current_user)):
    """`on` uses the caller's local calendar date and ISO Monday-based week parity."""
    _get(db, StudentGroup, group_id, "Группа")
    query = db.query(ScheduleEntry).join(Course).filter(Course.group_id == group_id)
    if on is not None:
        parity = "odd" if on.isocalendar().week % 2 else "even"
        query = query.filter(ScheduleEntry.day_of_week == on.isoweekday(), ScheduleEntry.week_pattern.in_(("every", parity, "unspecified")))
    return [_schedule_data(db, entry) for entry in query.order_by(ScheduleEntry.day_of_week, ScheduleEntry.start_time).all()]


@router.put("/schedule/{entry_id}")
def update_schedule(entry_id: int, payload: ScheduleInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    entry = _get(db, ScheduleEntry, entry_id, "Занятие")
    group_id = _get(db, Course, entry.course_id, "Дисциплина").group_id
    _validate_schedule(db, group_id, payload, entry.id)
    for key, value in _schedule_values(payload).items():
        setattr(entry, key, value)
    _commit(db, user, "schedule.update", "schedule", entry, fields=list(payload.model_fields_set))
    return _schedule_data(db, entry)


@router.delete("/schedule/{entry_id}")
def delete_schedule(entry_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    entry = _get(db, ScheduleEntry, entry_id, "Занятие")
    db.delete(entry)
    _commit(db, user, "schedule.delete", "schedule", entry)
    return {"ok": True}


@router.post("/courses/{course_id}/weeks", status_code=201)
def create_week(course_id: int, payload: WeekInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    _get(db, Course, course_id, "Дисциплина")
    week = CurriculumWeek(course_id=course_id, **payload.model_dump())
    db.add(week)
    _commit(db, user, "week.create", "week", week, fields=list(payload.model_fields_set), metadata={"course_id": course_id})
    return _data(week)


@router.put("/weeks/{week_id}")
def update_week(week_id: int, payload: WeekInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    week = _get(db, CurriculumWeek, week_id, "Неделя")
    _update(week, payload)
    _commit(db, user, "week.update", "week", week, fields=list(payload.model_fields_set))
    return _data(week)


@router.delete("/weeks/{week_id}")
def delete_week(week_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    week = _get(db, CurriculumWeek, week_id, "Неделя")
    db.delete(week)
    _commit(db, user, "week.delete", "week", week)
    return {"ok": True}


@router.put("/weeks/{week_id}/progress")
def update_progress(week_id: int, payload: ProgressInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    week = _get(db, CurriculumWeek, week_id, "Неделя")
    _require_membership(db, user, week.course_id)
    progress = db.query(WeekProgress).filter_by(week_id=week_id, user_id=user.id).first()
    if progress is None:
        progress = WeekProgress(week_id=week_id, user_id=user.id)
        db.add(progress)
    _update(progress, payload)
    _commit(db)
    return _data(progress)


@router.delete("/weeks/{week_id}/progress")
def delete_progress(week_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    progress = db.query(WeekProgress).filter_by(week_id=week_id, user_id=user.id).first()
    if progress:
        db.delete(progress)
        _commit(db)
    return {"ok": True}


@router.get("/works")
def list_works(group_id: int | None = Query(default=None, gt=0), course_id: int | None = Query(default=None, gt=0),
               db: Session = Depends(get_db), user=Depends(get_current_user)):
    query = db.query(ModuleWork).join(Course)
    if group_id is not None:
        query = query.filter(Course.group_id == group_id)
    if course_id is not None:
        query = query.filter(ModuleWork.course_id == course_id)
    return [_work_data(db, work, user) for work in query.order_by(ModuleWork.due_date, ModuleWork.week_number, ModuleWork.id).all()]


@router.get("/works/{work_id}")
def work_detail(work_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    return _work_data(db, _get(db, ModuleWork, work_id, "Работа"), user)


@router.post("/courses/{course_id}/works", status_code=201)
def create_work(course_id: int, payload: WorkInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    _get(db, Course, course_id, "Дисциплина")
    work = ModuleWork(course_id=course_id, **payload.model_dump())
    db.add(work)
    _commit(db, user, "work.create", "work", work, fields=list(payload.model_fields_set), metadata={"course_id": course_id})
    return _work_data(db, work, user)


@router.put("/works/{work_id}")
def update_work(work_id: int, payload: WorkInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    work = _get(db, ModuleWork, work_id, "Работа")
    if db.query(WorkSubmission).filter(WorkSubmission.work_id == work_id, WorkSubmission.grade > payload.max_score).first():
        raise HTTPException(409, "Максимальный балл не может быть меньше уже выставленной оценки")
    _update(work, payload)
    _commit(db, user, "work.update", "work", work, fields=list(payload.model_fields_set))
    return _work_data(db, work, user)


@router.delete("/works/{work_id}")
def delete_work(work_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    work = _get(db, ModuleWork, work_id, "Работа")
    db.delete(work)
    _commit(db, user, "work.delete", "work", work)
    return {"ok": True}


@router.put("/works/{work_id}/submission")
def save_submission(work_id: int, payload: SubmissionInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    work = _get(db, ModuleWork, work_id, "Работа")
    _require_membership(db, user, work.course_id)
    submission = db.query(WorkSubmission).filter_by(work_id=work_id, user_id=user.id).first()
    if submission is not None and submission.grade is not None:
        raise HTTPException(409, "Работа уже оценена. Администратор должен снять оценку перед изменением.")
    if submission is None:
        submission = WorkSubmission(work_id=work_id, user_id=user.id)
        db.add(submission)
    _update(submission, payload)
    _commit(db)
    return _data(submission)


@router.delete("/works/{work_id}/submission")
def delete_submission(work_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    submission = db.query(WorkSubmission).filter_by(work_id=work_id, user_id=user.id).first()
    if submission is not None:
        if submission.grade is not None:
            raise HTTPException(409, "Нельзя удалить оценённую работу; обратитесь к администратору")
        db.delete(submission)
        _commit(db)
    return {"ok": True}


@router.get("/works/{work_id}/submissions")
def submissions(work_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    _get(db, ModuleWork, work_id, "Работа")
    rows = db.query(WorkSubmission, User).join(User, WorkSubmission.user_id == User.id).filter(WorkSubmission.work_id == work_id, WorkSubmission.status == "submitted").all()
    return [{**_data(submission), "student_name": student.name, "student_email": student.email} for submission, student in rows]


@router.put("/submissions/{submission_id}/grade")
def grade_submission(submission_id: int, payload: GradeInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    submission = _get(db, WorkSubmission, submission_id, "Работа студента")
    work = _get(db, ModuleWork, submission.work_id, "Работа")
    if submission.status != "submitted":
        raise HTTPException(409, "Студент ещё не отправил работу")
    if payload.grade is not None and payload.grade > work.max_score:
        raise HTTPException(422, "Оценка превышает максимальный балл работы")
    _update(submission, payload)
    _commit(db, user, "submission.grade", "submission", submission, fields=list(payload.model_fields_set), metadata={"work_id": work.id})
    return _data(submission)


@router.get("/syllabi")
def syllabi(course_id: int | None = Query(default=None, gt=0), group_id: int | None = Query(default=None, gt=0),
            db: Session = Depends(get_db), user=Depends(get_current_user)):
    query = db.query(SyllabusDocument)
    if group_id is not None:
        query = query.join(Course, SyllabusDocument.course_id == Course.id).filter(Course.group_id == group_id)
    if course_id is not None:
        query = query.filter(SyllabusDocument.course_id == course_id)
    if user.role != "admin":
        query = query.filter(SyllabusDocument.status == "published")
    return [_syllabus_data(db, document, admin=user.role == "admin") for document in query.order_by(SyllabusDocument.created_at.desc()).all()]


@router.post("/syllabi/upload", status_code=201)
async def upload_syllabus(file: UploadFile = File(...), course_id: int = Form(...), title: str = Form(default=""),
                          db: Session = Depends(get_db), user=Depends(require_admin)):
    course = _get(db, Course, course_id, "Дисциплина")
    filename = re.split(r"[/\\]", file.filename or "")[-1]
    filename = "".join(character for character in filename if ord(character) >= 32)[:240]
    extension = Path(filename).suffix.lower()
    if extension not in (".pdf", ".docx"):
        raise HTTPException(415, "Загрузите силабус в формате PDF или DOCX")
    if len(title.strip()) > 200:
        raise HTTPException(422, "Название не должно превышать 200 символов")
    chunks, size = [], 0
    while chunk := await file.read(1024 * 1024):
        size += len(chunk)
        if size > MAX_SYLLABUS_BYTES:
            raise HTTPException(413, "Максимальный размер силабуса — 20 МБ")
        chunks.append(chunk)
    data = b"".join(chunks)
    try:
        extracted, warnings = await run_in_threadpool(extract_syllabus_bytes, data, extension)
    except ValueError as error:
        raise HTTPException(422, str(error))
    source_sha256 = hashlib.sha256(data).hexdigest()
    existing = db.query(SyllabusDocument).filter_by(course_id=course.id, source_sha256=source_sha256).first()
    if existing is not None:
        return {**_syllabus_data(db, existing, include_text=True, admin=True), "duplicate": True}
    destination = (Path(settings.UPLOAD_DIR) / "syllabi").resolve()
    destination.mkdir(parents=True, exist_ok=True)
    path = destination / (uuid.uuid4().hex + extension)
    path.write_bytes(data)
    document = SyllabusDocument(course_id=course.id, uploaded_by=user.id, title=title.strip() or course.title,
                                filename=filename, filepath=relative_upload_path(path, settings.UPLOAD_DIR), size=size, extracted_text=extracted,
                                source_sha256=source_sha256, source_restricted=ACCESS_DATA_WARNING in warnings,
                                status="needs_ocr" if len(extracted.strip()) < 30 else "extracted", warnings_json=json.dumps(warnings, ensure_ascii=False))
    db.add(document)
    try:
        # The document, queue entry and audit record are created together.
        db.flush()
        queue_import(db, document, user)
        _commit(db, user, "syllabus.upload", "syllabus", document,
                fields=["title", "course_id", "filename"], metadata={"course_id": course.id, "size_bytes": size})
    except IntegrityError:
        db.rollback()
        path.unlink(missing_ok=True)
        existing = db.query(SyllabusDocument).filter_by(course_id=course.id, source_sha256=source_sha256).first()
        if existing is not None:
            return {**_syllabus_data(db, existing, include_text=True, admin=True), "duplicate": True}
        raise HTTPException(409, "Документ уже добавляется. Повторите загрузку.")
    except Exception:
        db.rollback()
        path.unlink(missing_ok=True)
        raise
    background.wake_worker()
    return _syllabus_data(db, document, include_text=True, admin=True)


def _visible_document(db, document_id, user):
    document = _get(db, SyllabusDocument, document_id, "Силабус")
    if user.role != "admin" and document.status != "published":
        raise HTTPException(404, "Силабус не найден")
    return document


@router.get("/syllabi/{document_id}")
def syllabus_detail(document_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    return _syllabus_data(db, _visible_document(db, document_id, user), include_text=True, admin=user.role == "admin")


@router.get("/syllabi/{document_id}/download")
def download_syllabus(document_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    document = _visible_document(db, document_id, user)
    if document.source_restricted and user.role != "admin":
        raise HTTPException(403, "В оригинале есть служебные данные доступа. Учебный текст доступен на странице силабуса.")
    try:
        path = safe_syllabus_path(document.filepath, settings.UPLOAD_DIR)
    except ValueError:
        raise HTTPException(404, "Файл недоступен")
    if not path.is_file():
        raise HTTPException(404, "Файл не найден")
    return FileResponse(str(path), filename=document.filename, media_type="application/pdf" if path.suffix == ".pdf" else "application/vnd.openxmlformats-officedocument.wordprocessingml.document")


@router.post("/syllabi/{document_id}/analyze")
async def analyze_syllabus(document_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    document = _get(db, SyllabusDocument, document_id, "Силабус")
    if document.published_at is not None:
        raise HTTPException(409, "Силабус уже опубликован. Редактируйте недели и работы на странице дисциплины.")
    if len((document.extracted_text or "").strip()) < 30 and Path(document.filename).suffix.lower() != ".pdf":
        raise HTTPException(422, "Недостаточно текста для анализа. Проверьте содержимое документа.")
    active = db.query(AIJob).filter_by(kind=SYLLABUS_JOB_KIND, resource_key=resource_key(document)).filter(AIJob.status.in_(("queued", "running"))).first()
    if active is not None:
        return _syllabus_data(db, document, include_text=True, admin=True)
    queue_import(db, document, user)
    _commit(db, user, "syllabus.import_request", "syllabus", document,
            fields=["status"], metadata={"course_id": document.course_id})
    background.wake_worker()
    return _syllabus_data(db, document, include_text=True, admin=True)


@router.put("/syllabi/{document_id}")
def update_syllabus(document_id: int, payload: SyllabusInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    document = _get(db, SyllabusDocument, document_id, "Силабус")
    if payload.title is not None:
        document.title = payload.title
    if payload.summary is not None:
        document.summary = payload.summary
    if payload.draft is not None:
        if document.published_at is not None:
            raise HTTPException(409, "Опубликованный план редактируется на странице дисциплины")
        document.draft_json = payload.draft.model_dump_json()
        document.summary = payload.draft.summary
        document.status = "review"
    _commit(db, user, "syllabus.update", "syllabus", document, fields=list(payload.model_fields_set))
    return _syllabus_data(db, document, include_text=True, admin=True)


@router.post("/syllabi/{document_id}/publish")
def publish_syllabus(document_id: int, payload: PublishInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    document = _get(db, SyllabusDocument, document_id, "Силабус")
    if document.published_at is not None:
        raise HTTPException(409, "Этот силабус уже опубликован")
    if document.status != "review":
        raise HTTPException(409, "Сначала подготовьте и проверьте черновик учебного плана")
    try:
        draft = SyllabusDraft.model_validate_json(document.draft_json)
    except (ValueError, TypeError):
        raise HTTPException(422, "Черновик содержит некорректные данные. Исправьте учебный план перед публикацией.") from None
    if not draft.weeks and not draft.works:
        raise HTTPException(422, "В черновике нет недель или работ для публикации")
    old_weeks = db.query(CurriculumWeek).filter_by(course_id=document.course_id).all()
    old_works = db.query(ModuleWork).filter_by(course_id=document.course_id).all()
    if payload.replace_existing:
        if db.query(WorkSubmission).join(ModuleWork).filter(ModuleWork.course_id == document.course_id).first():
            raise HTTPException(409, "Нельзя заменить план с работами студентов. Редактируйте существующие записи, чтобы сохранить ответы.")
    elif any(week.week_number in {item.week_number for item in draft.weeks} for week in old_weeks):
        raise HTTPException(409, "Такие недели уже существуют. Проверьте план или явно выберите замену.")
    elif any((work.title.casefold().strip(), work.week_number, work.kind) in
             {(item.title.casefold().strip(), item.week_number, item.kind) for item in draft.works} for work in old_works):
        raise HTTPException(409, "Такие работы уже существуют. Сравните черновик с действующим учебным планом.")
    # Claim once inside this transaction, including drafts containing only works.
    claimed = db.query(SyllabusDocument).filter(SyllabusDocument.id == document.id,
                                               SyllabusDocument.status == "review",
                                               SyllabusDocument.published_at.is_(None)).update({
        SyllabusDocument.status: "published", SyllabusDocument.published_at: datetime.now(timezone.utc).replace(tzinfo=None)})
    if claimed != 1:
        db.rollback()
        raise HTTPException(409, "Этот силабус уже опубликован")
    if payload.replace_existing:
        for record in [*old_weeks, *old_works]:
            db.delete(record)
        db.flush()
    for week in draft.weeks:
        db.add(CurriculumWeek(course_id=document.course_id, source_syllabus_id=document.id, **week.model_dump()))
    for work in draft.works:
        db.add(ModuleWork(course_id=document.course_id, source_syllabus_id=document.id, **work.model_dump()))
    course = db.get(Course, document.course_id)
    if not (course.description or "").strip():
        course.description = draft.summary
    facts_changed = fill_missing_course_facts(course, draft)
    document.warnings_json = json.dumps([ACCESS_DATA_WARNING] if document.source_restricted else [], ensure_ascii=False)
    _commit(db, user, "syllabus.publish", "syllabus", document, fields=["status", "draft", *facts_changed],
            metadata={"course_id": document.course_id, "weeks_created": len(draft.weeks), "works_created": len(draft.works), "source": "manual"})
    return {"ok": True, "weeks_created": len(draft.weeks), "works_created": len(draft.works), "syllabus": _syllabus_data(db, document, include_text=True, admin=True)}


@router.delete("/syllabi/{document_id}")
def delete_syllabus(document_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    document = _get(db, SyllabusDocument, document_id, "Силабус")
    # Published curriculum remains editable and keeps students' work when its source is removed.
    db.query(CurriculumWeek).filter_by(source_syllabus_id=document.id).update({CurriculumWeek.source_syllabus_id: None})
    db.query(ModuleWork).filter_by(source_syllabus_id=document.id).update({ModuleWork.source_syllabus_id: None})
    db.delete(document)
    _commit(db, user, "syllabus.delete", "syllabus", document)
    _remove_documents([document])
    return {"ok": True}
