"""Student career guidance based on current, verifiable QStudy learning results.

The original QCareer idea (gaps, prerequisites and a three-step deterministic
planner) is adapted to students. No corporate employees, self-awarded skills,
synthetic vacancies or separate identity/database are imported.
"""
import json
import math
import re
from datetime import datetime, timezone
from urllib.parse import urlencode

from fastapi import HTTPException
from sqlalchemy.orm import joinedload

from app.career_models import (CareerDirection, CareerLearningLink, CareerOpportunity,
    CareerProfile, CareerSavedOpportunity, CareerSettings, CareerSkill)
from app.models import (Course, CurriculumWeek, ModuleWork, StudentGroup,
    SyllabusDocument, TestSession, User, WeekProgress, WorkSubmission)
from app.services.learning_context import safe_learning_provenance

DISCLAIMER = ("Уровни подтверждают только результаты внутри QStudy. Готовность — доля покрытых "
    "учебных требований, а не гарантия трудоустройства, поступления или профессиональная сертификация.")


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso(value):
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def loads(value, default=None):
    try:
        result = json.loads(value or "null")
        return result if isinstance(result, type(default)) else default
    except (ValueError, TypeError):
        return default


def dumps(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def initialize_career(db):
    """Seed one catalog exactly once; deleting entries never recreates them."""
    settings = db.get(CareerSettings, 1)
    if settings is not None:
        return settings
    settings = CareerSettings(id=1, initialized=True, enabled=True)
    db.add(settings)
    # Unique slugs make this safe for an existing selectively restored catalog.
    catalog = [
        ("programming", "Программирование", "Алгоритмы, функции и решение практических задач", "Разработка"),
        ("web", "Веб-разработка", "Интерфейсы, клиент и сервер веб-приложений", "Разработка"),
        ("data", "Базы данных", "Моделирование, SQL и работа с данными", "Данные"),
        ("testing", "Тестирование", "Проверки, поиск ошибок и качество программ", "Разработка"),
        ("networks", "Сети и системы", "Сетевые основы и администрирование", "Инфраструктура"),
        ("security", "Информационная безопасность", "Защита данных и безопасная разработка", "Инфраструктура"),
        ("analytics", "Аналитическое мышление", "Разбор задачи, работа с фактами и выводами", "Общие навыки"),
        ("communication", "Профессиональное общение", "Ясные объяснения, документация и командная работа", "Общие навыки"),
    ]
    skills = {row.slug: row for row in db.query(CareerSkill).all()}
    for slug, name, description, category in catalog:
        if slug not in skills:
            skill = CareerSkill(slug=slug, name=name, description=description, category=category)
            db.add(skill)
            db.flush()
            skills[slug] = skill
    definitions = [
        ("web-developer", "Веб-разработчик", "Создание сайтов и веб-приложений: от интерфейса до работы с данными.",
         "Разработка", ["Прикладная информатика", "Программная инженерия"],
         ["Стажировка в веб-разработке", "Начальные позиции frontend или backend разработчика"],
         [("programming", 3), ("web", 3), ("data", 2), ("communication", 2)]),
        ("qa-engineer", "Тестировщик ПО", "Проверка поведения приложений, описание ошибок и автоматизация проверок.",
         "Качество", ["Программная инженерия", "Курсы тестирования и автоматизации"],
         ["Стажировка QA", "Начальные позиции ручного тестирования"],
         [("testing", 3), ("analytics", 3), ("programming", 1), ("communication", 2)]),
        ("data-analyst", "Аналитик данных", "Подготовка данных, запросы и аргументированные выводы.",
         "Данные", ["Аналитика данных", "Информационные системы"],
         ["Стажировка аналитика", "Начальные позиции специалиста по данным"],
         [("data", 3), ("analytics", 3), ("programming", 2), ("communication", 2)]),
        ("system-specialist", "Специалист по системам и сетям", "Поддержка инфраструктуры и безопасная работа информационных систем.",
         "Инфраструктура", ["Вычислительная техника и программное обеспечение", "Информационная безопасность"],
         ["Стажировка в технической поддержке", "Начальные позиции системного администратора"],
         [("networks", 3), ("security", 2), ("analytics", 2), ("communication", 2)]),
    ]
    existing = {row.slug for row in db.query(CareerDirection).all()}
    for slug, title, description, category, study, career, requirements in definitions:
        if slug not in existing:
            db.add(CareerDirection(slug=slug, title=title, description=description,
                category=category, study_paths_json=dumps(study), career_paths_json=dumps(career),
                requirements_json=dumps([{"skill_id": skills[key].id, "level": level} for key, level in requirements])))
    db.flush()
    # Conservative convenience mappings only. This writes no achievement: each
    # student still needs their own exact curriculum proof to demonstrate skill.
    for candidate in suggest_learning_links(db):
        db.add(CareerLearningLink(skill_id=candidate["skill_id"], course_id=candidate["course_id"],
            title=candidate["title"], description=candidate["description"], target_level=2, min_score=70))
    db.commit()
    return settings


def config_public(db):
    settings = db.get(CareerSettings, 1)
    if settings is None:
        raise HTTPException(503, "Раздел QCareer ещё не инициализирован. Повторите запуск QStudy")
    from app.services.branding import career_branding
    return {"enabled": settings.enabled, "title": settings.title, "description": settings.description,
        "announcement": settings.announcement, "accent": "orange", **career_branding(db)}


def require_enabled(db, user):
    settings = db.get(CareerSettings, 1)
    if settings is None or not settings.enabled and user.role != "admin":
        raise HTTPException(503, "QCareer временно отключён администратором")


class Curriculum:
    """Current permission-scoped published sources, loaded once per calculation."""
    def __init__(self, db, user=None):
        query = db.query(Course).options(joinedload(Course.group))
        if user is not None and user.role != "admin":
            query = query.filter(Course.group_id == user.group_id) if user.group_id else query.filter(False)
        self.courses = {row.id: row for row in query.order_by(Course.id).all()}
        ids = list(self.courses)
        self.syllabi = {row.id: row for row in db.query(SyllabusDocument).filter(
            SyllabusDocument.course_id.in_(ids), SyllabusDocument.status == "published").all()}
        self.weeks = {row.id: row for row in db.query(CurriculumWeek).filter(CurriculumWeek.course_id.in_(ids)).all()
            if row.source_syllabus_id is None or row.source_syllabus_id in self.syllabi}
        self.works = {row.id: row for row in db.query(ModuleWork).filter(ModuleWork.course_id.in_(ids)).all()
            if row.source_syllabus_id is None or row.source_syllabus_id in self.syllabi}

    def available(self, link):
        if link.course_id not in self.courses:
            return False
        if link.syllabus_id is not None and link.syllabus_id not in self.syllabi:
            return False
        weeks = [row for row in self.weeks.values() if row.course_id == link.course_id]
        works = [row for row in self.works.values() if row.course_id == link.course_id]
        if link.module:
            weeks = [row for row in weeks if (row.module or "").strip() == link.module]
            works = [row for row in works if (row.module or "").strip() == link.module]
            if not weeks and not works:
                return False
        if link.week_number is not None:
            weeks = [row for row in weeks if row.week_number == link.week_number]
            works = [row for row in works if row.week_number == link.week_number]
            if not weeks and not works:
                return False
        if link.work_id is not None:
            works = [row for row in works if row.id == link.work_id]
            if not works:
                return False
            weeks = []
        if link.syllabus_id is not None:
            weeks = [row for row in weeks if row.source_syllabus_id == link.syllabus_id]
            works = [row for row in works if row.source_syllabus_id == link.syllabus_id]
            if not weeks and not works:
                return False
        return True

    def sources(self):
        result = []
        for course in self.courses.values():
            weeks = [row for row in self.weeks.values() if row.course_id == course.id]
            works = [row for row in self.works.values() if row.course_id == course.id]
            result.append({"id": course.id, "title": course.title, "group_id": course.group_id,
                "group_name": course.group.name,
                "modules": sorted({(row.module or "").strip() for row in [*weeks, *works] if (row.module or "").strip()}),
                "weeks": [{"id": row.id, "week_number": row.week_number, "title": row.title,
                    "module": row.module or "", "source_syllabus_id": row.source_syllabus_id}
                    for row in sorted(weeks, key=lambda row: row.week_number)],
                "works": [{"id": row.id, "title": row.title, "module": row.module or "",
                    "week_number": row.week_number, "source_syllabus_id": row.source_syllabus_id} for row in works],
                "syllabi": [{"id": row.id, "title": row.title} for row in self.syllabi.values() if row.course_id == course.id]})
        return {"courses": result}


_CATALOG_ALIASES = {
    "programming": r"программирован|алгоритмизац|алгоритмы\b|\bprogramming\b|\balgorithms\b",
    "web": r"веб[- ]?разработ|web[- ]?разработ|\bweb development\b|\bfrontend\b|\bbackend\b|создани[ея]\s+(?:веб[- ]?)?сайт",
    "data": r"баз[ыа] данных|\bsql\b|\bdatabase",
    "testing": r"тестировани[ея]\s+(?:по\b|программ)|качеств[ао]\s+программ|\bsoftware testing\b|\bquality assurance\b",
    "networks": r"компьютерн\w*\s+сет|сетев\w*\s+(?:технолог|администр)|системн\w*\s+администр|\bcomputer networks\b",
    "security": r"информационн\w*\s+безопасност|кибербезопасност|\bcybersecurity\b|\binformation security\b",
    "analytics": r"анализ\s+данных|аналитик[аи]\s+данных|\bdata analysis\b|\bstatistics\b|статистик",
    "communication": r"профессиональн\w*\s+(?:русск|казах|английск|общен|коммуникац)|делов\w*\s+общен|академическ\w*\s+письм|\bprofessional communication\b",
}


def suggest_learning_links(db):
    """Explainable suggestions, not NLP claims or student evidence.

    Only an explicit discipline title and existing published rows are used.
    Administrators can review, edit or delete mappings; startup invokes this
    exclusively when the one-time catalog marker is first created.
    """
    curriculum = Curriculum(db)
    skills = {row.slug: row for row in db.query(CareerSkill).filter_by(is_active=True)}
    existing = {(row.course_id, row.skill_id) for row in db.query(CareerLearningLink)}
    populated = {row.course_id for row in [*curriculum.weeks.values(), *curriculum.works.values()]}
    result = []
    for course in curriculum.courses.values():
        if course.id not in populated:
            continue
        for slug, pattern in _CATALOG_ALIASES.items():
            skill = skills.get(slug)
            if skill is None or (course.id, skill.id) in existing:
                continue
            if not re.search(pattern, course.title.casefold()):
                continue
            reason = f"Название дисциплины «{course.title}» соответствует тематике навыка «{skill.name}»; связь можно уточнить в админке."
            result.append({"course_id": course.id, "course_title": course.title, "group_id": course.group_id,
                "group_name": course.group.name, "skill_id": skill.id, "skill_name": skill.name,
                "title": course.title, "description": reason, "module": "", "target_level": 2,
                "min_score": 70, "reason": reason})
    return result


def learning_href(link, curriculum):
    course = curriculum.courses.get(link.course_id)
    return f"/dashboard/groups/{course.group_id}/courses/{course.id}" if course else None


def test_href(link):
    query = {"course": link.course_id, "use_web": "false"}
    if link.module:
        query["module"] = link.module
    if link.week_number is not None:
        query["weeks"] = link.week_number
    if link.work_id is not None:
        query["works"] = link.work_id
    return "/dashboard/tests?" + urlencode(query)


def skill_public(row):
    return {key: getattr(row, key) for key in ("id", "slug", "name", "description", "category", "is_active")}


def link_public(row, curriculum, skills):
    course = curriculum.courses.get(row.course_id)
    return {**{key: getattr(row, key) for key in ("id", "skill_id", "course_id", "module", "week_number", "work_id", "syllabus_id", "title", "description", "target_level", "min_score", "is_active")},
        "prerequisites": loads(row.prerequisites_json, []),
        "skill_name": skills[row.skill_id].name if row.skill_id in skills else "Удалённый навык",
        "course_title": course.title if course else "Удалённая дисциплина",
        "group_id": course.group_id if course else None, "group_name": course.group.name if course else "",
        "href": learning_href(row, curriculum), "test_href": test_href(row), "source_available": curriculum.available(row)}


def _matches_test(link, provenance, curriculum):
    course = curriculum.courses.get(link.course_id)
    if provenance.get("mode") != "course" or provenance.get("course_id") != link.course_id or not course:
        return False
    if provenance.get("group_id") != course.group_id:
        return False
    weeks, works = provenance.get("weeks", []), provenance.get("works", [])
    if not weeks and not works:
        return False
    # Validate the current source references, not old display titles. Any deleted
    # or unpublished referenced row invalidates this proof rather than borrowing
    # other rows from a similarly named module/course.
    for item in weeks:
        matches = [row for row in curriculum.weeks.values() if row.course_id == course.id and row.week_number == item.get("week_number")]
        if not matches or not any((row.module or "").strip() == item.get("module", "")
                and row.source_syllabus_id == item.get("source_syllabus_id") for row in matches):
            return False
    for item in works:
        row = curriculum.works.get(item.get("id"))
        if row is None or row.course_id != course.id or (row.module or "").strip() != item.get("module", "") or row.source_syllabus_id != item.get("source_syllabus_id"):
            return False
    if link.module and provenance.get("module") != link.module:
        return False
    if link.week_number is not None and provenance.get("week_numbers") != [link.week_number]:
        return False
    if link.work_id is not None and (provenance.get("work_ids") != [link.work_id] or weeks):
        return False
    if link.syllabus_id is not None and any(item.get("source_syllabus_id") != link.syllabus_id for item in [*weeks, *works]):
        return False
    return True


def _matches_submission(link, work):
    return (work.course_id == link.course_id and (not link.module or (work.module or "").strip() == link.module)
        and (link.week_number is None or work.week_number == link.week_number)
        and (link.work_id is None or work.id == link.work_id)
        and (link.syllabus_id is None or work.source_syllabus_id == link.syllabus_id))


def evidence_for(db, user, curriculum, skills, links):
    result = {skill_id: [] for skill_id in skills}
    tests = db.query(TestSession).filter(TestSession.user_id == user.id, TestSession.status == "finished").all()
    verified_tests = []
    for test in tests:
        if test.finished_at is None or type(test.score) not in (int, float) or not math.isfinite(test.score) or not 0 <= test.score <= 100:
            continue
        provenance = safe_learning_provenance(test.source_context_json)
        if provenance.get("mode") == "course" and provenance.get("course_id") in curriculum.courses:
            verified_tests.append((test, provenance))
    submissions = db.query(WorkSubmission).filter(WorkSubmission.user_id == user.id,
        WorkSubmission.grade.is_not(None), WorkSubmission.status.in_(["submitted", "graded"])).all()
    for link in links:
        if link.skill_id not in skills or not link.is_active or not curriculum.available(link):
            continue
        proofs = result[link.skill_id]
        for test, provenance in verified_tests:
            if test.score >= link.min_score and _matches_test(link, provenance, curriculum):
                proofs.append({"kind": "test", "source_id": test.id,
                    "title": "Тест: " + curriculum.courses[link.course_id].title,
                    "score": test.score, "level": link.target_level, "course_id": link.course_id,
                    "module": link.module, "href": f"/dashboard/tests?session={test.id}", "verified_at": iso(test.finished_at)})
        for submission in submissions:
            work = curriculum.works.get(submission.work_id)
            if not work or not _matches_submission(link, work) or not work.max_score or work.max_score <= 0:
                continue
            grade = submission.grade
            if type(grade) not in (int, float) or not math.isfinite(grade) or not 0 <= grade <= work.max_score:
                continue
            score = 100 * grade / work.max_score
            if score >= link.min_score:
                proofs.append({"kind": "submission", "source_id": submission.id, "title": work.title,
                    "score": round(score, 2), "level": link.target_level, "course_id": link.course_id,
                    "module": work.module or "", "href": "/dashboard/modules?" + urlencode({"course": work.course_id}),
                    "verified_at": iso(submission.updated_at)})
    for skill_id, proofs in result.items():
        unique = {}
        for proof in proofs:
            key = proof["kind"], proof["source_id"]
            if key not in unique or proof["level"] > unique[key]["level"]:
                unique[key] = proof
        result[skill_id] = sorted(unique.values(), key=lambda item: (-item["level"], item["kind"], item["source_id"]))
    return result


def direction_public(row, skills, levels=None):
    levels = levels or {}
    requirements = []
    complete = True
    for requirement in loads(row.requirements_json, []):
        skill = skills.get(requirement.get("skill_id"))
        if skill is None or not skill.is_active:
            complete = False
            requirements.append({"skill_id": requirement["skill_id"],
                "skill_name": skill.name if skill else "Недоступный навык",
                "level": requirement.get("level", 0), "current_level": 0,
                "gap": requirement.get("level", 0)})
            continue
        required = requirement.get("level", 0)
        current = levels.get(skill.id, 0)
        requirements.append({"skill_id": skill.id, "skill_name": skill.name, "level": required,
            "current_level": current, "gap": max(0, required - current)})
    total = sum(item["level"] for item in requirements)
    covered = sum(min(item["current_level"], item["level"]) for item in requirements)
    return {**{key: getattr(row, key) for key in ("id", "slug", "title", "description", "category", "is_active")},
        "study_paths": loads(row.study_paths_json, []), "career_paths": loads(row.career_paths_json, []),
        "requirements": requirements, "readiness": round(100 * covered / total, 1) if total and complete else None,
        "data_complete": complete,
        "matched_skills": sum(item["gap"] == 0 for item in requirements), "total_requirements": len(requirements)}


def profile_public(db, user):
    row = db.get(CareerProfile, user.id)
    group = db.get(StudentGroup, user.group_id) if user.group_id else None
    return {"user_id": user.id, "name": user.name, "group_id": user.group_id,
        "group_name": group.name if group else "", "target_direction_id": row.target_direction_id if row else None,
        "interests": loads(row.interests_json, []) if row else [], "about": row.about if row else "",
        "saved_opportunity_ids": [item[0] for item in db.query(CareerSavedOpportunity.opportunity_id).filter_by(user_id=user.id).all()]}


def _gaps(requirements, levels, skills):
    return [{"skill_id": item["skill_id"], "skill_name": skills[item["skill_id"]].name,
        "current_level": levels.get(item["skill_id"], 0), "required_level": item["level"],
        "gap": max(0, item["level"] - levels.get(item["skill_id"], 0))}
        for item in requirements if item["skill_id"] in skills and levels.get(item["skill_id"], 0) < item["level"]]


def plan_steps(links, curriculum, skills, levels, direction):
    """Bounded beam search: prerequisite preparation can unlock later steps.

    Unlike greedy gap-only ranking, paths may include a prerequisite skill not
    required by the chosen profession. Candidate ordering/tie breaks are stable.
    Repeated links to one activity apply together and occupy one plan step.
    """
    requirements = direction["requirements"] if direction else []
    requirements = [{"skill_id": item["skill_id"], "level": item["level"]} for item in requirements]
    assumptions = ["План не начисляет навыки заранее: нужен результат теста или оценённой работы не ниже указанного порога.",
        "Рекомендации используют опубликованную программу вашей группы; расписание и внешние требования проверяйте отдельно."]
    remaining = _gaps(requirements, levels, skills)
    if not requirements or not remaining or direction and not direction.get("data_complete", True):
        return {"mode": "rules", "steps": [], "remaining_gaps": remaining,
            "reason": "Требования направления содержат недоступные навыки. Администратору нужно уточнить каталог." if direction and not direction.get("data_complete", True) else
                "Требования выбранного направления покрыты. Изучите возможности и соберите портфолио." if requirements else "Выберите направление с настроенными требованиями, чтобы построить учебный план.",
            "assumptions": assumptions}
    useful_skills = {item["skill_id"] for item in remaining}
    candidates = [link for link in links if link.is_active and link.skill_id in skills and curriculum.available(link)]
    for _ in range(3):
        useful_skills.update(requirement["skill_id"] for link in candidates if link.skill_id in useful_skills
            for requirement in loads(link.prerequisites_json, []))
    candidates = [link for link in candidates if link.skill_id in useful_skills]
    candidates.sort(key=lambda row: (row.skill_id not in {item["skill_id"] for item in remaining}, row.id))
    if len(candidates) > 200:
        assumptions.append("Поиск ограничен 200 релевантными связями и 64 промежуточными вариантами; это подходящий, не гарантированно оптимальный план.")
        candidates = candidates[:200]
    grouped = {}
    for link in candidates:
        key = (link.course_id, link.module, link.week_number, link.work_id, link.syllabus_id)
        grouped.setdefault(key, []).append(link)
    activities = list(grouped.values())
    def covered(state):
        return sum(min(state.get(item["skill_id"], 0), item["level"]) for item in requirements)
    initial_covered = covered(levels)
    states = [(dict(levels), [], set())]
    best = states[0]
    states_truncated = False
    for _depth in range(3):
        next_states = []
        for current, path, used in states:
            for index, activity in enumerate(activities):
                if index in used:
                    continue
                eligible = [link for link in activity if link.target_level > current.get(link.skill_id, 0)
                    and all(current.get(item["skill_id"], 0) >= item["level"] for item in loads(link.prerequisites_json, []))]
                if not eligible:
                    continue
                # One assessment may be configured with several thresholds for
                # a skill. Forecast its highest eligible result once rather
                # than displaying duplicate gains or a lower score threshold.
                by_skill = {}
                for link in eligible:
                    previous = by_skill.get(link.skill_id)
                    if previous is None or (link.target_level, -link.min_score, -link.id) > (previous.target_level, -previous.min_score, -previous.id):
                        by_skill[link.skill_id] = link
                eligible = sorted(by_skill.values(), key=lambda link: link.id)
                after = dict(current)
                for link in eligible:
                    after[link.skill_id] = max(after.get(link.skill_id, 0), link.target_level)
                next_states.append((after, [*path, eligible], used | {index}))
        if not next_states:
            break
        next_states.sort(key=lambda state: (-covered(state[0]), -sum(state[0].values()), len(state[1]),
            tuple(link.id for activity in state[1] for link in activity)))
        states = next_states[:64]
        states_truncated = states_truncated or len(next_states) > 64
        candidate = states[0]
        if (covered(candidate[0]), -len(candidate[1]), sum(candidate[0].values())) > (covered(best[0]), -len(best[1]), sum(best[0].values())):
            best = candidate
    steps, current = [], dict(levels)
    if covered(best[0]) > initial_covered:
        for activity in best[1]:
            primary = next((link for link in activity if link.skill_id in {item["skill_id"] for item in remaining}), activity[0])
            course = curriculum.courses[primary.course_id]
            gains = [{"skill_id": link.skill_id, "skill_name": skills[link.skill_id].name,
                "from_level": current.get(link.skill_id, 0), "to_level": link.target_level} for link in activity]
            for gain in gains:
                current[gain["skill_id"]] = max(current.get(gain["skill_id"], 0), gain["to_level"])
            primary_gain = next(gain for gain in gains if gain["skill_id"] == primary.skill_id)
            required_score = max(link.min_score for link in activity)
            steps.append({"id": primary.id, "title": primary.title or primary.module or course.title,
                "description": primary.description, "course_id": course.id, "course_title": course.title,
                "module": primary.module, "week_number": primary.week_number, "work_id": primary.work_id,
                **primary_gain, "gains": gains, "prerequisites": loads(primary.prerequisites_json, []),
                "href": learning_href(primary, curriculum), "test_href": test_href(primary),
                "min_score": required_score,
                "reason": f"После проверки от {required_score}% можно подтвердить: {skills[primary.skill_id].name}, уровень {primary.target_level}."})
    if states_truncated:
        assumptions.append("Поиск сохраняет 64 лучших промежуточных варианта на шаг; оптимальность среди всех возможных последовательностей не гарантируется.")
    return {"mode": "rules", "steps": steps, "remaining_gaps": _gaps(requirements, current, skills),
        "reason": "План покрывает часть учебных требований; результат обновится после проверки работ или тестов." if steps else "Для текущих пробелов нет доступного плана. Администратору нужно связать навыки с программой или добавить подготовительные шаги.",
        "assumptions": assumptions}


def workspace(db, user):
    curriculum = Curriculum(db, user)
    skills = {row.id: row for row in db.query(CareerSkill).filter_by(is_active=True).order_by(CareerSkill.category, CareerSkill.id).all()}
    links = db.query(CareerLearningLink).filter(CareerLearningLink.course_id.in_(curriculum.courses), CareerLearningLink.is_active.is_(True)).order_by(CareerLearningLink.id).all()
    evidence = evidence_for(db, user, curriculum, skills, links)
    levels = {skill_id: max((item["level"] for item in proofs), default=0) for skill_id, proofs in evidence.items()}
    directions = [direction_public(row, skills, levels) for row in db.query(CareerDirection).filter_by(is_active=True).order_by(CareerDirection.id).all()]
    directions.sort(key=lambda row: (row["readiness"] is None, -(row["readiness"] or 0), row["id"]))
    profile = profile_public(db, user)
    target = next((item for item in directions if item["id"] == profile["target_direction_id"]), None)
    recommended_target = target or next((item for item in directions if item["requirements"]), None)
    proof_ids = {(proof["kind"], proof["source_id"]) for proofs in evidence.values() for proof in proofs}
    accessible_weeks = list(curriculum.weeks)
    accessible_works = list(curriculum.works)
    return {"profile": profile, "summary": {"demonstrated_skills": sum(level > 0 for level in levels.values()),
        "evidence_count": len(proof_ids), "readiness": target["readiness"] if target else None,
        "target_direction_id": target["id"] if target else None, "target_direction_title": target["title"] if target else None},
        "skills": [{**skill_public(row), "level": levels[row.id], "evidence": evidence[row.id]} for row in skills.values()],
        "directions": directions, "recommendations": {**plan_steps(links, curriculum, skills, levels, recommended_target),
            "direction_id": recommended_target["id"] if recommended_target else None,
            "direction_title": recommended_target["title"] if recommended_target else None},
        "activity": {"completed_weeks": db.query(WeekProgress).filter(WeekProgress.user_id == user.id,
                WeekProgress.week_id.in_(accessible_weeks), WeekProgress.completed.is_(True)).count(),
            "finished_tests": db.query(TestSession).filter(TestSession.user_id == user.id, TestSession.status == "finished").count(),
            "graded_works": db.query(WorkSubmission).filter(WorkSubmission.user_id == user.id,
                WorkSubmission.work_id.in_(accessible_works), WorkSubmission.grade.is_not(None)).count()},
        "disclaimer": DISCLAIMER}


def opportunity_public(row, directions, saved_ids=(), personal_directions=None):
    direction = directions.get(row.direction_id)
    personal = (personal_directions or {}).get(row.direction_id)
    return {**{key: getattr(row, key) for key in ("id", "title", "organization", "description", "kind", "url", "location", "direction_id", "is_active")},
        "direction_title": direction.title if direction else None,
        "published_at": iso(row.published_at), "expires_at": iso(row.expires_at), "saved": row.id in saved_ids,
        "readiness": personal["readiness"] if personal else None,
        "requirements_met": personal["readiness"] == 100 if personal and personal["readiness"] is not None else None}
