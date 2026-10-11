"""Atomic, once-only import of a reviewed data snapshot, never executable HTML.

Clock slots and original cell text were checked against both embedded workbooks
and the HTML's static fallback. No class duration or calendar validity is inferred.
"""
import hashlib
import json
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import AcademicSetting, Course, ScheduleEntry, StudentGroup

REFERENCE_KEY = "reference_timetable_2026_v1"
REFERENCE_DATA = Path(__file__).resolve().parents[1] / "data" / "timetable_2026.json"
REVIEWED_SHA256 = "3ee1337e47248dc9b2cf46fbf26e9a0f599a15159bec4a91eff1aa8b6fc15060"
SOURCE_SHA256 = "e80adad9c4c4e79acd977d4e31071473eb5898f3a6d5f53df232bb0783ee9866"


@lru_cache(maxsize=1)
def reviewed_timetable() -> dict:
    content = REFERENCE_DATA.read_bytes()
    if hashlib.sha256(content).hexdigest() != REVIEWED_SHA256:
        raise ValueError("Reviewed timetable mapping checksum mismatch")
    mapping = json.loads(content)
    if mapping["source"]["sha256"] != SOURCE_SHA256:
        raise ValueError("Timetable source checksum mismatch")
    return mapping


def seed_sourced_timetable(db: Session, source_path: Path | None = None) -> dict:
    if db.get(AcademicSetting, REFERENCE_KEY):
        return {"imported": False, "reason": "already_imported"}
    mapping = reviewed_timetable()
    project_root = Path(__file__).resolve().parents[3]
    source = source_path or (project_root / "local-documents" / mapping["source"]["filename"])
    if source_path is None and not source.is_file():
        source = project_root / mapping["source"]["filename"]
    if not source.is_file():
        return {"imported": False, "reason": "source_missing"}
    # Hashing bytes is the only operation performed on the original HTML here.
    if source.stat().st_size > 5_000_000 or hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
        return {"imported": False, "reason": "source_changed"}
    from app.routers.academic import GroupInput, ScheduleInput, _schedule_values

    now = datetime.now(timezone.utc).isoformat()
    counts = {"groups_created": 0, "courses_created": 0, "schedule_created": 0}
    try:
        # Claim and insert inside one transaction: a failed import leaves no marker
        # or partial records; subsequent restarts never restore admin deletions.
        marker = AcademicSetting(key=REFERENCE_KEY, value="{}")
        db.add(marker)
        db.flush()
        group_ids = {}
        for item in mapping["groups"]:
            values = GroupInput(name=item["name"], program=item["program"], study_year=item["study_year"],
                                semester=item["semester"], academic_year=item["academic_year"]).model_dump()
            group = db.query(StudentGroup).filter_by(name=item["name"]).first()
            if group is None:
                group = StudentGroup(**values)
                db.add(group)
                db.flush()
                counts["groups_created"] += 1
            else:
                # An existing name/description/curator and nonempty metadata are
                # authoritative. Add only source metadata that was not set.
                for name in ("program", "study_year", "semester", "academic_year"):
                    if getattr(group, name) in (None, ""):
                        setattr(group, name, values[name])
            group.warnings_json = json.dumps(list(dict.fromkeys(json.loads(group.warnings_json or "[]") + item["warnings"])), ensure_ascii=False)
            group_ids[item["source_group_id"]] = group.id
        lessons_by_course = defaultdict(list)
        for item in mapping["expanded_lessons"]:
            lessons_by_course[(group_ids[item["source_group_id"]], item["title"])].append(item)
        course_ids = []
        for (group_id, title), lessons in lessons_by_course.items():
            course = db.query(Course).filter_by(group_id=group_id, title=title).order_by(Course.id).first()
            if course is None:
                teachers = list(dict.fromkeys(item["teacher"] for item in lessons if item["teacher"]))
                teacher = teachers[0] if len(teachers) == 1 else ""
                course = Course(group_id=group_id, title=title, teacher=teacher,
                                description="Дисциплина из предоставленного расписания. Кредиты, недельный план и оценивание в справочнике не указаны.")
                db.add(course)
                db.flush()
                counts["courses_created"] += 1
            # This exact-title reuse preserves Мамандыққа кіріспе and its syllabus,
            # all 15 weeks, module works and student progress.
            course_ids.append(course.id)
            for item in lessons:
                payload = ScheduleInput(course_id=course.id, day_of_week=item["day_of_week"], start_time=item["start_time"],
                                        start_times=item["start_times"], end_time=None, room=item["room"],
                                        teacher=item["teacher"], lesson_type=item["lesson_type"] or "Не указан",
                                        week_pattern="unspecified")
                warning = "Время окончания и чётность недель не заданы; календарные даты действия расписания не подтверждены."
                entry = ScheduleEntry(**_schedule_values(payload), source_file=item["source_workbook"],
                                      source_sheet=item["source_sheet"], source_cell=item["source_cell"],
                                      source_row_id=item["source_record_key"], source_sha256=item["source_sha256"],
                                      source_container=mapping["source"]["filename"], source_container_sha256=SOURCE_SHA256,
                                      source_updated_at=item["source_updated_at"], source_raw=item["source_text"],
                                      warnings_json=json.dumps(list(dict.fromkeys(item["warnings"] + [warning])), ensure_ascii=False))
                db.add(entry)
                counts["schedule_created"] += 1
        marker.value = json.dumps({"imported_at": now, "source_sha256": SOURCE_SHA256,
                                  "group_ids": list(group_ids.values()), "course_ids": course_ids, **counts})
        db.commit()
    except IntegrityError:
        db.rollback()
        if db.get(AcademicSetting, REFERENCE_KEY):
            return {"imported": False, "reason": "already_imported"}
        raise
    except Exception:
        db.rollback()
        raise
    return {"imported": True, **counts}


def timetable_source_data(db: Session) -> dict:
    mapping = reviewed_timetable()
    source = mapping["source"]
    marker = db.get(AcademicSetting, REFERENCE_KEY)
    receipt = json.loads(marker.value) if marker else {}
    rows = db.query(ScheduleEntry).filter_by(source_container_sha256=SOURCE_SHA256).all()
    metrics = mapping["metrics"]
    return {"imported": marker is not None, "source_file": source["filename"], "source_sha256": SOURCE_SHA256,
            "title": source["title"], "updated_at": source["updated_at"], "university": source["university"],
            "school": source["school"], "academic_year": source["academic_year"], "utc_offset": source["utc_offset"],
            "timezone_label": source["timezone_label"], "warnings": source["warnings"], "sources": mapping["sources"],
            "counts": {key: metrics[key] for key in ("groups", "original_lessons", "group_schedule_records", "group_start_slots")},
            "current_counts": {"groups": db.query(StudentGroup).filter(StudentGroup.id.in_(receipt.get("group_ids", []))).count(),
                               "courses": db.query(Course).filter(Course.id.in_(receipt.get("course_ids", []))).count(),
                               "schedule_records": len(rows), "start_slots": sum(len(json.loads(row.start_times_json or "[]")) or 1 for row in rows)},
            "imported_at": receipt.get("imported_at")}
