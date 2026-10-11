"""Durable, conservative syllabus ingestion into the selected course only."""
import hashlib
import json
import asyncio
from fastapi import HTTPException
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings
from app.models import Course, CurriculumWeek, ModuleWork, SyllabusDocument, User
from app.services import background
from app.services.audit import record_audit
from app.services.syllabus import (ACCESS_DATA_WARNING, AUTO_OCR_WARNING, SyllabusDraft,
                                  analyze_syllabus_text, fill_missing_course_facts, redact_access_data, safe_syllabus_path)
from app.services.pdf_ocr import OCR_WARNING_PREFIXES, PDFOCRError, recognize_pdf
from app.services.ai import AIError

KIND = "syllabus_import"
CONFIGURATION_WARNING = "ИИ не настроен. Документ сохранён: добавьте GEMINI_API_KEY на сервере и нажмите «Повторить автоматический импорт»."
CONFLICT_WARNING = "В дисциплине уже есть учебный план. Автоматический импорт сохранил черновик для проверки; существующие недели, работы и ответы студентов сохранены."
EMPTY_WARNING = "В документе не найден план по неделям или заданиям. Проверьте извлечённый текст и дополните черновик вручную."
FACTS_WARNING = "Проверьте соответствие исходного документа выбранной дисциплине. Неуказанные часы и сроки остаются пустыми; 100 баллов у работы — значение по умолчанию, если источник не содержит оценки."


def document_fingerprint(document):
    """A manual draft or document edit must never be overwritten by a late AI reply."""
    values = [document.course_id, document.source_sha256, document.title,
              document.summary or "", document.draft_json or "{}"]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False).encode("utf-8")).hexdigest()


def resource_key(document):
    return f"syllabus:{document.id}:{document.source_sha256}"


def base_warnings(document):
    warnings = [ACCESS_DATA_WARNING] if document.source_restricted else []
    try:
        stored = json.loads(document.warnings_json or "[]")
    except (TypeError, ValueError):
        stored = []
    if isinstance(stored, list):
        warnings.extend(item for item in stored if isinstance(item, str) and
                        item.startswith(OCR_WARNING_PREFIXES))
    return list(dict.fromkeys(warnings))


def needs_pdf_ocr(document):
    if Path(document.filename).suffix.lower() != ".pdf":
        return False
    try:
        warnings = json.loads(document.warnings_json or "[]")
    except (TypeError, ValueError):
        warnings = []
    return len((document.extracted_text or "").strip()) < 30 or (isinstance(warnings, list) and AUTO_OCR_WARNING in warnings)


def queue_import(db, document, actor):
    if document.published_at is not None:
        return None
    ocr_required = needs_pdf_ocr(document)
    if len((document.extracted_text or "").strip()) < 30 and not ocr_required:
        document.status = "needs_ocr"
        return None
    if not settings.GEMINI_API_KEY and not ocr_required:
        document.status = "needs_configuration"
        document.warnings_json = json.dumps(base_warnings(document) + [CONFIGURATION_WARNING], ensure_ascii=False)
        return None
    job = background.enqueue_job(db, actor.id, KIND, document.title,
                                 {"document_id": document.id, "fingerprint": document_fingerprint(document),
                                  "ocr_required": ocr_required},
                                 resource_key=resource_key(document))
    document.status = "queued"
    document.warnings_json = json.dumps(base_warnings(document), ensure_ascii=False)
    return job


def _result(document, status, weeks=0, works=0):
    return {"document_id": document.id, "course_id": document.course_id,
            "status": status, "weeks_created": weeks, "works_created": works}


def _missing_weeks(draft):
    numbers = {week.week_number for week in draft.weeks}
    return sorted(set(range(min(numbers), max(numbers) + 1)) - numbers) if numbers else []


def _work_identity(work):
    return (" ".join(work.title.casefold().split()), work.week_number,
            work.kind, " ".join(work.module.casefold().split()))


def _candidate_delta(original, candidate):
    old_numbers = {week.week_number for week in original.weeks}
    known_numbers = old_numbers | {week.week_number for week in candidate.weeks}
    works = []
    known_work_keys = {_work_identity(work) for work in original.works}
    for work in candidate.works:
        key = _work_identity(work)
        if key not in known_work_keys and (work.week_number is None or work.week_number in known_numbers):
            works.append(work)
            known_work_keys.add(key)
    return {"weeks": [week.model_dump() for week in candidate.weeks if week.week_number not in old_numbers],
            "works": [work.model_dump() for work in works],
            "course_facts": candidate.course_facts.model_dump() if candidate.course_facts is not None else None}


def _apply_repair_delta(original, delta):
    # Keep existing topics/works verbatim and include every newly confirmed
    # candidate week, including newly recognized table continuation at the edges.
    facts = original.course_facts.model_dump() if original.course_facts is not None else {}
    if isinstance(delta.get("course_facts"), dict):
        for name, value in delta["course_facts"].items():
            if facts.get(name) in (None, ""):
                facts[name] = value
    return SyllabusDraft.model_validate({**original.model_dump(),
        "weeks": [week.model_dump() for week in original.weeks] + delta["weeks"],
        "works": [work.model_dump() for work in original.works] + delta["works"],
        "course_facts": facts or None})


def _merge_gap_repair(original, candidate, missing):
    old_numbers = {week.week_number for week in original.weeks}
    candidate_numbers = {week.week_number for week in candidate.weeks}
    if not old_numbers.issubset(candidate_numbers) or not set(missing).issubset(candidate_numbers) or _missing_weeks(candidate):
        return None
    return _apply_repair_delta(original, _candidate_delta(original, candidate))


async def _repair_ocr_gaps(ctx, payload, original, checkpoint, extracted_text, ocr_required):
    missing = _missing_weeks(original)
    if not missing:
        return original, []
    with ctx.session() as db:
        job = ctx.require_current(db)
        actor = db.get(User, ctx.user_id)
        document = db.get(SyllabusDocument, payload["document_id"])
        if actor is None or actor.role != "admin" or document is None:
            raise background.JobCancelled("Силабус удалён или права администратора изменены; повторный анализ отменён")
        if document.published_at is not None or document_fingerprint(document) != payload["fingerprint"]:
            # The normal finalization branch handles publication/manual edits.
            return original, []
        ocr_used = ocr_required or any(warning.startswith(OCR_WARNING_PREFIXES)
                                       for warning in base_warnings(document))
        exhausted = job.attempts >= job.max_attempts
    if not ocr_used:
        return original, []

    stage = checkpoint.get("gap_repair")
    finished = isinstance(stage, dict) and stage.get("missing") == missing and stage.get("status") in (
        "accepted", "incomplete", "invalid", "unavailable", "limit")
    if not finished:
        # A completed outcome is never repeated after restart. An interrupted
        # request may be retried under the queue's existing bounded attempts.
        stage = {"attempted": True, "missing": missing, "status": "running"}
        checkpoint = {**checkpoint, "gap_repair": stage}
        try:
            ctx.save_checkpoint(checkpoint)
        except HTTPException as error:
            if error.status_code != 413:
                raise
            # No second provider call occurred; the first valid draft can still
            # be finalized as review when even its attempt marker cannot fit.
            return original, ["Повторный анализ не запускался: сохранённый черновик достиг допустимого объёма. "
                              "Первый корректный результат сохранён для проверки по оригиналу."]
        try:
            candidate = await analyze_syllabus_text(extracted_text, repair_missing_weeks=missing)
            candidate = SyllabusDraft.model_validate(candidate.model_dump() if isinstance(candidate, SyllabusDraft) else candidate)
            merged = _merge_gap_repair(original, candidate, missing)
            stage = {**stage, "status": "accepted" if merged is not None else "incomplete",
                     "observed_week_numbers": [week.week_number for week in candidate.weeks],
                     "delta": _candidate_delta(original, candidate)}
        except (ValueError, KeyError, TypeError):
            stage = {**stage, "status": "invalid"}
        except AIError:
            if not exhausted:
                raise
            # A failed recovery must not discard a valid first analysis.
            stage = {**stage, "status": "unavailable"}
        try:
            ctx.save_checkpoint({**checkpoint, "gap_repair": stage})
        except HTTPException as error:
            if error.status_code != 413:
                raise
            # This marker is smaller than the running marker that already fit.
            # It records the completed outcome without duplicating a large AI
            # result and prevents another repair request after restart.
            stage = {"attempted": True, "missing": missing, "status": "limit"}
            ctx.save_checkpoint({**checkpoint, "gap_repair": stage})

    if stage["status"] == "accepted":
        try:
            if "delta" in stage:
                merged = _apply_repair_delta(original, stage["delta"])
                if _missing_weeks(merged):
                    merged = None
            else:
                # Resume full candidate checkpoints written by the older worker.
                candidate = SyllabusDraft.model_validate(stage["candidate"])
                merged = _merge_gap_repair(original, candidate, missing)
        except (ValueError, KeyError, TypeError):
            merged = None
        if merged is not None:
            return merged, ["Повторный анализ исходного текста восстановил пропущенные недели: " +
                            ", ".join(map(str, missing)) + ". Ранее распознанные темы и работы сохранены."]
    if stage["status"] == "limit":
        return original, ["Результат повторного анализа превысил допустимый объём сохранения. "
                          "Первый корректный черновик сохранён; сверьте пропуски с оригиналом перед публикацией."]
    return original, ["Автоматическая повторная проверка исходного текста не подтвердила полный план. "
                      "Сохранён первый корректный черновик; сверьте пропуски с оригиналом перед публикацией."]


@background.register_handler(KIND)
async def import_syllabus(ctx, payload):
    with ctx.session() as db:
        ctx.require_current(db)
        actor = db.get(User, ctx.user_id)
        document = db.get(SyllabusDocument, payload["document_id"])
        if actor is None or actor.role != "admin":
            raise background.JobCancelled("Автоматический импорт отменён: роль администратора больше недоступна")
        if document is None:
            raise background.JobCancelled("Силабус удалён; автоматический импорт отменён")
        if document.published_at is not None:
            result = _result(document, "published")
            ctx.complete(db, result)
            return result
        extracted_text = document.extracted_text or ""
        ocr_required = payload.get("ocr_required", False) or needs_pdf_ocr(document)
        path = safe_syllabus_path(document.filepath, settings.UPLOAD_DIR) if ocr_required else None

    checkpoint = ctx.get_checkpoint()
    if ocr_required:
        if "ocr_text" in checkpoint:
            extracted_text = checkpoint["ocr_text"]
            ocr_warnings = checkpoint.get("ocr_warnings", [])
        else:
            try:
                extracted_text, ocr_warnings = await asyncio.to_thread(recognize_pdf, path)
            except PDFOCRError as error:
                raise background.JobPermanentError(str(error)) from error
            extracted_text, restricted = redact_access_data(extracted_text)
            checkpoint = {**checkpoint, "ocr_text": extracted_text, "ocr_warnings": ocr_warnings,
                          "ocr_restricted": restricted}
            ctx.save_checkpoint(checkpoint)
        with ctx.session() as db:
            ctx.require_current(db)
            actor = db.get(User, ctx.user_id)
            document = db.get(SyllabusDocument, payload["document_id"])
            if actor is None or actor.role != "admin" or document is None:
                raise background.JobCancelled("Силабус удалён или права администратора изменены; распознавание отменено")
            if document.published_at is not None:
                result = _result(document, "published")
                ctx.complete(db, result)
                return result
            if document_fingerprint(document) != payload["fingerprint"]:
                result = _result(document, "manual_conflict")
                if document.status == "queued":
                    document.status = "review"
                ctx.complete(db, result)
                return result
            document.extracted_text = extracted_text
            document.source_restricted = document.source_restricted or checkpoint.get("ocr_restricted", False)
            document.warnings_json = json.dumps(base_warnings(document) + ocr_warnings, ensure_ascii=False)
            if len(extracted_text.strip()) < 30:
                document.status = "needs_ocr"
                document.warnings_json = json.dumps(base_warnings(document) + ocr_warnings +
                    ["Распознавание не нашло достаточно текста. Проверьте качество скана и содержимое страниц."], ensure_ascii=False)
                result = _result(document, "needs_ocr")
                ctx.complete(db, result)
                return result
            db.commit()

    with ctx.session() as db:
        ctx.require_current(db)
        actor = db.get(User, ctx.user_id)
        document = db.get(SyllabusDocument, payload["document_id"])
        if actor is None or actor.role != "admin" or document is None:
            raise background.JobCancelled("Силабус удалён или права администратора изменены; импорт отменён")
        if not settings.GEMINI_API_KEY:
            document.status = "needs_configuration"
            warnings = json.loads(document.warnings_json or "[]")
            document.warnings_json = json.dumps(list(dict.fromkeys(base_warnings(document) + warnings + [CONFIGURATION_WARNING])), ensure_ascii=False)
            result = _result(document, "needs_configuration")
            ctx.complete(db, result)
            return result
    if "ai_output" in checkpoint:
        draft = SyllabusDraft.model_validate(checkpoint["ai_output"])
    else:
        try:
            draft = await analyze_syllabus_text(extracted_text)
        except (ValueError, KeyError, TypeError):
            raise background.JobPermanentError("ИИ вернул некорректный учебный план. Документ сохранён; повторите импорт или заполните программу вручную.")
        checkpoint = {**checkpoint, "ai_output": draft.model_dump()}
        ctx.save_checkpoint(checkpoint)

    recognition_warnings = checkpoint.get("ocr_warnings", []) if ocr_required else []
    draft, repair_warnings = await _repair_ocr_gaps(ctx, payload, draft, checkpoint, extracted_text, ocr_required)
    recognition_warnings = recognition_warnings + repair_warnings

    with ctx.session() as db:
        ctx.require_current(db)
        actor = db.get(User, ctx.user_id)
        document = db.get(SyllabusDocument, payload["document_id"])
        if actor is None or actor.role != "admin" or document is None:
            raise background.JobCancelled("Силабус удалён или права администратора изменены; импорт отменён")
        if document.published_at is not None:
            result = _result(document, "published")
            ctx.complete(db, result)
            return result
        if document_fingerprint(document) != payload["fingerprint"]:
            warnings = json.loads(document.warnings_json or "[]")
            message = "Черновик изменён администратором во время анализа. Эти изменения сохранены; автоматическая публикация отменена."
            document.warnings_json = json.dumps(list(dict.fromkeys(warnings + [message])), ensure_ascii=False)
            if document.status == "queued":
                document.status = "review"
            result = _result(document, "manual_conflict")
            ctx.complete(db, result)
            return result

        # Acquire the document's write claim before checking the course. SQLite
        # serializes this transaction with concurrent imports and manual edits.
        claimed = db.query(SyllabusDocument).filter(
            SyllabusDocument.id == document.id,
            SyllabusDocument.published_at.is_(None),
            SyllabusDocument.draft_json == (document.draft_json or "{}"),
            SyllabusDocument.title == document.title,
            SyllabusDocument.summary == (document.summary or ""),
        ).update({SyllabusDocument.status: "review"}, synchronize_session=False)
        if claimed != 1:
            raise background.JobCancelled("Силабус изменён во время анализа; сохранённый учебный план не затронут")
        document.draft_json = draft.model_dump_json()
        document.summary = draft.summary
        document.status = "review"
        existing = (db.query(CurriculumWeek).filter_by(course_id=document.course_id).first()
                    or db.query(ModuleWork).filter_by(course_id=document.course_id).first())
        review_warnings = []
        if existing:
            review_warnings.append(CONFLICT_WARNING)
        elif not (draft.weeks or draft.works):
            review_warnings.append(EMPTY_WARNING)
        # OCR can lose a row without making the AI's JSON invalid. Preserve the
        # real source weeks as a draft rather than filling gaps or publishing an
        # incomplete plan. A native document may intentionally be noncontinuous.
        ocr_used = ocr_required or any(warning.startswith(OCR_WARNING_PREFIXES)
                                       for warning in base_warnings(document))
        missing = _missing_weeks(draft)
        if ocr_used and missing:
            review_warnings.append("После OCR в плане пропущены номера недель: " +
                ", ".join(map(str, missing)) + ". Автоматическая публикация остановлена: "
                "сверьте распознанный текст и черновик с оригиналом, затем проверьте и опубликуйте план вручную. "
                "Отсутствующие недели автоматически не добавлялись.")
        if review_warnings:
            document.warnings_json = json.dumps(list(dict.fromkeys(base_warnings(document) + recognition_warnings + review_warnings + [FACTS_WARNING])), ensure_ascii=False)
            result = _result(document, "review")
            record_audit(db, actor, "syllabus.import_review", "syllabus", document.id,
                         fields=["draft", "summary"], metadata={"course_id": document.course_id, "job_id": ctx.job_id, "source": "syllabus"})
            ctx.complete(db, result)
            return result

        document.status = "published"
        document.published_at = datetime.now(timezone.utc).replace(tzinfo=None)
        document.warnings_json = json.dumps(list(dict.fromkeys(base_warnings(document) + recognition_warnings + [FACTS_WARNING])), ensure_ascii=False)
        course = db.get(Course, document.course_id)
        if not (course.description or "").strip():
            course.description = draft.summary
        course_fields = fill_missing_course_facts(course, draft)
        for week in draft.weeks:
            db.add(CurriculumWeek(course_id=document.course_id, source_syllabus_id=document.id, **week.model_dump()))
        for work in draft.works:
            db.add(ModuleWork(course_id=document.course_id, source_syllabus_id=document.id, **work.model_dump()))
        result = _result(document, "published", len(draft.weeks), len(draft.works))
        record_audit(db, actor, "syllabus.auto_publish", "syllabus", document.id,
                     fields=["draft", "summary", "status", *course_fields],
                     metadata={"course_id": document.course_id, "job_id": ctx.job_id, "source": "syllabus",
                               "weeks_created": len(draft.weeks), "works_created": len(draft.works)})
        ctx.complete(db, result)
        return result
