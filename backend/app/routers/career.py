"""One QStudy session for student guidance and administrator catalog management."""
import re
from datetime import datetime, timezone
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, ValidationError, create_model, field_validator, model_validator
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_admin
from app.career_models import (CareerDirection, CareerLearningLink, CareerOpportunity,
    CareerProfile, CareerSavedOpportunity, CareerSettings, CareerSkill)
from app.database import get_db
from app.models import User, StudentGroup
from app.services import career as service
from app.services.audit import record_audit

router = APIRouter(tags=["QCareer"])
PositiveId = Annotated[int, Field(strict=True, gt=0)]
Level = Annotated[int, Field(strict=True, ge=1, le=5)]


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Requirement(StrictInput):
    skill_id: PositiveId
    level: Level


def unique_requirements(values):
    if len({item.skill_id for item in values}) != len(values):
        raise ValueError("Навык не должен повторяться в требованиях")
    return values


class ConfigInput(StrictInput):
    enabled: bool = Field(strict=True)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(max_length=4000)
    announcement: str = Field(max_length=2000)


class SkillInput(StrictInput):
    slug: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=4000)
    category: str = Field(default="", max_length=120)
    is_active: bool = Field(default=True, strict=True)


class DirectionInput(StrictInput):
    slug: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=6000)
    category: str = Field(default="", max_length=120)
    study_paths: list[Annotated[str, Field(min_length=1, max_length=300)]] = Field(default_factory=list, max_length=20)
    career_paths: list[Annotated[str, Field(min_length=1, max_length=300)]] = Field(default_factory=list, max_length=20)
    requirements: list[Requirement] = Field(default_factory=list, max_length=100)
    is_active: bool = Field(default=True, strict=True)
    _requirements = field_validator("requirements")(unique_requirements)


class LearningLinkInput(StrictInput):
    skill_id: PositiveId
    course_id: PositiveId
    module: str = Field(default="", max_length=200)
    week_number: Annotated[int, Field(strict=True, ge=1, le=52)] | None = None
    work_id: PositiveId | None = None
    syllabus_id: PositiveId | None = None
    title: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=4000)
    target_level: Level = 1
    min_score: Annotated[int, Field(strict=True, ge=0, le=100)] = 70
    prerequisites: list[Requirement] = Field(default_factory=list, max_length=100)
    is_active: bool = Field(default=True, strict=True)
    _prerequisites = field_validator("prerequisites")(unique_requirements)


class OpportunityInput(StrictInput):
    title: str = Field(min_length=1, max_length=200)
    organization: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=10000)
    kind: Literal["job", "internship", "study", "course"] = "study"
    url: str = Field(default="", max_length=2000)
    location: str = Field(default="", max_length=200)
    direction_id: PositiveId | None = None
    published_at: datetime | None = None
    expires_at: datetime | None = None
    is_active: bool = Field(default=True, strict=True)

    @field_validator("url")
    @classmethod
    def public_url(cls, value):
        if not value:
            return value
        try:
            parsed = urlsplit(value)
            if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password or parsed.port == 0:
                raise ValueError
        except ValueError:
            raise ValueError("Укажите HTTP(S) ссылку без пароля и логина") from None
        if re.search(r"[\x00-\x20\x7f\\]", value):
            raise ValueError("В ссылке недопустимы пробелы и управляющие символы")
        return value

    @field_validator("published_at", "expires_at")
    @classmethod
    def utc_date(cls, value):
        if value is None:
            return value
        return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value

    @model_validator(mode="after")
    def valid_dates(self):
        if self.expires_at is not None and self.expires_at <= (self.published_at or service.now()):
            raise ValueError("Окончание публикации должно быть позже её начала")
        return self


class ProfileInput(StrictInput):
    target_direction_id: PositiveId | None = None
    interests: list[Annotated[str, Field(min_length=1, max_length=60)]] = Field(default_factory=list, max_length=12)
    about: str = Field(default="", max_length=2000)


class SuggestionApplyInput(StrictInput):
    course_ids: list[PositiveId] = Field(min_length=1, max_length=1000)


def partial(schema):
    return create_model(schema.__name__ + "Patch", __config__=ConfigDict(extra="forbid", str_strip_whitespace=True),
        **{name: (field.annotation | None, None) for name, field in schema.model_fields.items()})


ConfigPatch = partial(ConfigInput)
SkillPatch = partial(SkillInput)
DirectionPatch = partial(DirectionInput)
LinkPatch = partial(LearningLinkInput)
OpportunityPatch = partial(OpportunityInput)
ProfilePatch = partial(ProfileInput)


def get_record(db, model, identifier, label):
    row = db.get(model, identifier)
    if row is None:
        raise HTTPException(404, f"{label} не найден")
    return row


def read_fields(row, schema):
    result = {}
    for field in schema.model_fields:
        value = getattr(row, field, None)
        if hasattr(row, field + "_json"):
            value = service.loads(getattr(row, field + "_json"), [])
        result[field] = value
    return result


def validated_patch(row, payload, schema):
    changed = payload.model_dump(exclude_unset=True)
    try:
        return schema.model_validate({**read_fields(row, schema), **changed})
    except ValidationError as error:
        raise HTTPException(422, str(error)) from None


def assign(row, payload):
    for name, value in payload.model_dump().items():
        if hasattr(row, name + "_json"):
            setattr(row, name + "_json", service.dumps(value))
        else:
            setattr(row, name, value)


def commit(db, actor, action, kind, row, fields=()):
    try:
        db.flush()
        record_audit(db, actor, "career." + action, "career_" + kind, getattr(row, "id", None), fields=fields)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Такой идентификатор уже используется или связанный объект изменён. Обновите страницу") from None


def validate_requirements(db, requirements, *, allow_inactive=False):
    for item in requirements:
        skill = get_record(db, CareerSkill, item.skill_id, "Навык")
        if not skill.is_active and not allow_inactive:
            raise HTTPException(422, "В требованиях используйте активные навыки")


def validate_link(db, payload, *, existing=None):
    get_record(db, CareerSkill, payload.skill_id, "Навык")
    curriculum = service.Curriculum(db)
    # A published source can later be withdrawn. Its existing mapping must
    # remain possible to archive/edit without re-publishing that source. Only
    # unchanged source references may use this exception, never a new mapping.
    archived_existing = (existing is not None and not payload.is_active
        and all(getattr(payload, key) == getattr(existing, key)
            for key in ("course_id", "module", "week_number", "work_id", "syllabus_id")))
    if not curriculum.available(payload) and not archived_existing:
        raise HTTPException(422, "Выберите существующие опубликованные материалы одной дисциплины; модуль, неделя, работа и силабус должны соответствовать друг другу")
    validate_requirements(db, payload.prerequisites, allow_inactive=existing is not None)
    if any(item.skill_id == payload.skill_id and item.level >= payload.target_level for item in payload.prerequisites):
        raise HTTPException(422, "Входной уровень этого навыка должен быть ниже достигаемого")
    return curriculum


def validate_opportunity(db, payload):
    if payload.direction_id is not None:
        get_record(db, CareerDirection, payload.direction_id, "Направление")
    if payload.published_at is None:
        payload.published_at = service.now()


@router.get("/career/config")
def config(db: Session = Depends(get_db)):
    return service.config_public(db)


@router.get("/career/me")
def me(db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.require_enabled(db, user)
    return service.workspace(db, user)


@router.patch("/career/profile")
def update_profile(payload: ProfilePatch, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.require_enabled(db, user)
    row = db.get(CareerProfile, user.id)
    existing = row or CareerProfile(user_id=user.id, interests_json="[]", about="")
    validated = validated_patch(existing, payload, ProfileInput)
    if validated.target_direction_id is not None:
        direction = get_record(db, CareerDirection, validated.target_direction_id, "Направление")
        if not direction.is_active and validated.target_direction_id != existing.target_direction_id:
            raise HTTPException(422, "Выберите активное направление")
    if row is None:
        row = existing
        db.add(row)
    assign(row, validated)
    db.commit()
    return service.profile_public(db, user)


@router.get("/career/directions")
def directions(db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.require_enabled(db, user)
    return {"items": service.workspace(db, user)["directions"]}


@router.get("/career/directions/{direction_id}")
def direction(direction_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    values = directions(db, user)["items"]
    result = next((item for item in values if item["id"] == direction_id), None)
    if result is None:
        raise HTTPException(404, "Направление не найдено")
    return result


@router.get("/career/opportunities")
def opportunities(kind: Literal["job", "internship", "study", "course"] | None = None,
        direction_id: int | None = Query(default=None, gt=0), saved: bool = False,
        db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.require_enabled(db, user)
    current = service.now()
    query = db.query(CareerOpportunity).filter(CareerOpportunity.is_active.is_(True),
        CareerOpportunity.published_at <= current,
        or_(CareerOpportunity.expires_at.is_(None), CareerOpportunity.expires_at > current))
    if kind:
        query = query.filter_by(kind=kind)
    if direction_id:
        query = query.filter_by(direction_id=direction_id)
    saved_ids = {item[0] for item in db.query(CareerSavedOpportunity.opportunity_id).filter_by(user_id=user.id)}
    if saved:
        query = query.filter(CareerOpportunity.id.in_(saved_ids))
    current_directions = {item["id"]: item for item in service.workspace(db, user)["directions"]}
    catalog = {row.id: row for row in db.query(CareerDirection).all()}
    return {"items": [service.opportunity_public(row, catalog, saved_ids, current_directions) for row in query.order_by(CareerOpportunity.published_at.desc(), CareerOpportunity.id.desc()).all()
        if row.direction_id is None or row.direction_id in current_directions],
        "as_of": service.iso(current), "source": "admin_curated"}


@router.put("/career/opportunities/{opportunity_id}/save")
def save_opportunity(opportunity_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.require_enabled(db, user)
    row = get_record(db, CareerOpportunity, opportunity_id, "Возможность")
    current = service.now()
    direction = db.get(CareerDirection, row.direction_id) if row.direction_id else None
    if not row.is_active or row.published_at > current or row.expires_at and row.expires_at <= current or direction and not direction.is_active:
        raise HTTPException(404, "Публикация больше недоступна")
    if not db.query(CareerSavedOpportunity).filter_by(user_id=user.id, opportunity_id=opportunity_id).first():
        db.add(CareerSavedOpportunity(user_id=user.id, opportunity_id=opportunity_id))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    return {"saved": True}


@router.delete("/career/opportunities/{opportunity_id}/save")
def unsave_opportunity(opportunity_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.require_enabled(db, user)
    db.query(CareerSavedOpportunity).filter_by(user_id=user.id, opportunity_id=opportunity_id).delete()
    db.commit()
    return {"saved": False}


@router.get("/admin/career/config")
def admin_config(db: Session = Depends(get_db), user=Depends(require_admin)):
    return service.config_public(db)


@router.patch("/admin/career/config")
def update_config(payload: ConfigPatch, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = get_record(db, CareerSettings, 1, "Настройки")
    assign(row, validated_patch(row, payload, ConfigInput))
    commit(db, user, "config.update", "settings", row, payload.model_fields_set)
    return service.config_public(db)


@router.get("/admin/career/skills")
def admin_skills(db: Session = Depends(get_db), user=Depends(require_admin)):
    return {"items": [service.skill_public(row) for row in db.query(CareerSkill).order_by(CareerSkill.id)]}


@router.post("/admin/career/skills", status_code=201)
def create_skill(payload: SkillInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = CareerSkill()
    assign(row, payload)
    db.add(row)
    commit(db, user, "skill.create", "skill", row, payload.model_fields_set)
    return service.skill_public(row)


@router.patch("/admin/career/skills/{skill_id}")
def update_skill(skill_id: int, payload: SkillPatch, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = get_record(db, CareerSkill, skill_id, "Навык")
    assign(row, validated_patch(row, payload, SkillInput))
    commit(db, user, "skill.update", "skill", row, payload.model_fields_set)
    return service.skill_public(row)


@router.delete("/admin/career/skills/{skill_id}")
def delete_skill(skill_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = get_record(db, CareerSkill, skill_id, "Навык")
    for direction in db.query(CareerDirection):
        direction.requirements_json = service.dumps([item for item in service.loads(direction.requirements_json, []) if item.get("skill_id") != skill_id])
    for link in db.query(CareerLearningLink):
        link.prerequisites_json = service.dumps([item for item in service.loads(link.prerequisites_json, []) if item.get("skill_id") != skill_id])
    db.delete(row)
    commit(db, user, "skill.delete", "skill", row)
    return {"ok": True}


@router.get("/admin/career/directions")
def admin_directions(db: Session = Depends(get_db), user=Depends(require_admin)):
    skills = {row.id: row for row in db.query(CareerSkill)}
    return {"items": [service.direction_public(row, skills) for row in db.query(CareerDirection).order_by(CareerDirection.id)]}


@router.post("/admin/career/directions", status_code=201)
def create_direction(payload: DirectionInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    validate_requirements(db, payload.requirements)
    row = CareerDirection()
    assign(row, payload)
    db.add(row)
    commit(db, user, "direction.create", "direction", row, payload.model_fields_set)
    skills = {skill.id: skill for skill in db.query(CareerSkill)}
    return service.direction_public(row, skills)


@router.patch("/admin/career/directions/{direction_id}")
def update_direction(direction_id: int, payload: DirectionPatch, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = get_record(db, CareerDirection, direction_id, "Направление")
    validated = validated_patch(row, payload, DirectionInput)
    # Preserve archived requirements while editing titles/paths. Hiding a skill
    # makes coverage incomplete; it must not make the existing direction
    # impossible to maintain or silently erase its stored requirements.
    validate_requirements(db, validated.requirements, allow_inactive=True)
    assign(row, validated)
    commit(db, user, "direction.update", "direction", row, payload.model_fields_set)
    skills = {skill.id: skill for skill in db.query(CareerSkill)}
    return service.direction_public(row, skills)


@router.delete("/admin/career/directions/{direction_id}")
def delete_direction(direction_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = get_record(db, CareerDirection, direction_id, "Направление")
    db.delete(row)
    commit(db, user, "direction.delete", "direction", row)
    return {"ok": True}


@router.get("/admin/career/sources")
def sources(db: Session = Depends(get_db), user=Depends(require_admin)):
    return service.Curriculum(db).sources()


@router.get("/admin/career/learning-links")
def admin_links(db: Session = Depends(get_db), user=Depends(require_admin)):
    curriculum = service.Curriculum(db)
    skills = {row.id: row for row in db.query(CareerSkill)}
    return {"items": [service.link_public(row, curriculum, skills) for row in db.query(CareerLearningLink).order_by(CareerLearningLink.id)]}


@router.post("/admin/career/learning-links/suggest")
def suggest_links(payload: StrictInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    items = service.suggest_learning_links(db)
    return {"items": items, "count": len(items)}


@router.post("/admin/career/learning-links/apply-suggestions")
def apply_suggestions(payload: SuggestionApplyInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    chosen = set(payload.course_ids)
    candidates = [item for item in service.suggest_learning_links(db) if item["course_id"] in chosen]
    rows = []
    for item in candidates:
        row = CareerLearningLink(skill_id=item["skill_id"], course_id=item["course_id"],
            title=item["title"], description=item["description"], target_level=2, min_score=70)
        db.add(row)
        rows.append(row)
    if rows:
        db.flush()
        record_audit(db, user, "career.links.suggested", "career_learning_link", fields=["course_id", "skill_id"], metadata={"count": len(rows)})
        db.commit()
    curriculum = service.Curriculum(db)
    skills = {row.id: row for row in db.query(CareerSkill)}
    return {"created": len(rows), "items": [service.link_public(row, curriculum, skills) for row in rows]}


@router.post("/admin/career/learning-links", status_code=201)
def create_link(payload: LearningLinkInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    curriculum = validate_link(db, payload)
    row = CareerLearningLink()
    assign(row, payload)
    db.add(row)
    commit(db, user, "link.create", "learning_link", row, payload.model_fields_set)
    skills = {skill.id: skill for skill in db.query(CareerSkill)}
    return service.link_public(row, curriculum, skills)


@router.patch("/admin/career/learning-links/{link_id}")
def update_link(link_id: int, payload: LinkPatch, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = get_record(db, CareerLearningLink, link_id, "Связь")
    validated = validated_patch(row, payload, LearningLinkInput)
    curriculum = validate_link(db, validated, existing=row)
    assign(row, validated)
    commit(db, user, "link.update", "learning_link", row, payload.model_fields_set)
    skills = {skill.id: skill for skill in db.query(CareerSkill)}
    return service.link_public(row, curriculum, skills)


@router.delete("/admin/career/learning-links/{link_id}")
def delete_link(link_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = get_record(db, CareerLearningLink, link_id, "Связь")
    db.delete(row)
    commit(db, user, "link.delete", "learning_link", row)
    return {"ok": True}


@router.get("/admin/career/opportunities")
def admin_opportunities(db: Session = Depends(get_db), user=Depends(require_admin)):
    directions = {row.id: row for row in db.query(CareerDirection)}
    return {"items": [service.opportunity_public(row, directions) for row in db.query(CareerOpportunity).order_by(CareerOpportunity.id.desc())]}


@router.post("/admin/career/opportunities", status_code=201)
def create_opportunity(payload: OpportunityInput, db: Session = Depends(get_db), user=Depends(require_admin)):
    validate_opportunity(db, payload)
    row = CareerOpportunity()
    assign(row, payload)
    db.add(row)
    commit(db, user, "opportunity.create", "opportunity", row, payload.model_fields_set)
    return service.opportunity_public(row, {item.id: item for item in db.query(CareerDirection)})


@router.patch("/admin/career/opportunities/{opportunity_id}")
def update_opportunity(opportunity_id: int, payload: OpportunityPatch, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = get_record(db, CareerOpportunity, opportunity_id, "Возможность")
    validated = validated_patch(row, payload, OpportunityInput)
    validate_opportunity(db, validated)
    assign(row, validated)
    commit(db, user, "opportunity.update", "opportunity", row, payload.model_fields_set)
    return service.opportunity_public(row, {item.id: item for item in db.query(CareerDirection)})


@router.delete("/admin/career/opportunities/{opportunity_id}")
def delete_opportunity(opportunity_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = get_record(db, CareerOpportunity, opportunity_id, "Возможность")
    db.delete(row)
    commit(db, user, "opportunity.delete", "opportunity", row)
    return {"ok": True}


def student_summary(db, row):
    value = service.workspace(db, row)
    return {"id": row.id, "name": row.name, "email": row.email, "group_id": row.group_id,
        "group_name": value["profile"]["group_name"], **value["summary"]}


@router.get("/admin/career/students")
def students(search: str = Query(default="", max_length=120), group_id: int | None = Query(default=None, gt=0),
        db: Session = Depends(get_db), user=Depends(require_admin)):
    query = db.query(User).filter(User.role == "student")
    if group_id:
        query = query.filter(User.group_id == group_id)
    if search.strip():
        needle = "%" + search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.filter(or_(User.name.ilike(needle, escape="\\"), User.email.ilike(needle, escape="\\")))
    return {"items": [student_summary(db, row) for row in query.order_by(User.name, User.id).limit(200)]}


@router.get("/admin/career/students/{user_id}")
def student(user_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    row = get_record(db, User, user_id, "Студент")
    if row.role != "student":
        raise HTTPException(404, "Студент не найден")
    return service.workspace(db, row)


@router.get("/admin/career/overview")
def overview(db: Session = Depends(get_db), user=Depends(require_admin)):
    people = db.query(User).filter(User.role == "student").all()
    groups = {row.id: {"id": row.id, "name": row.name, "students_count": 0,
        "demonstrated_skills": 0, "evidence_count": 0} for row in db.query(StudentGroup).order_by(StudentGroup.name)}
    for person in people:
        group = groups.get(person.group_id)
        if group is None:
            continue
        summary = service.workspace(db, person)["summary"]
        group["students_count"] += 1
        group["demonstrated_skills"] += summary["demonstrated_skills"]
        group["evidence_count"] += summary["evidence_count"]
    return {"students_count": len(people),
        "active_skills": db.query(CareerSkill).filter_by(is_active=True).count(),
        "active_directions": db.query(CareerDirection).filter_by(is_active=True).count(),
        "active_links": db.query(CareerLearningLink).filter_by(is_active=True).count(),
        "active_opportunities": db.query(CareerOpportunity).filter(CareerOpportunity.is_active.is_(True),
            CareerOpportunity.published_at <= service.now(),
            or_(CareerOpportunity.expires_at.is_(None), CareerOpportunity.expires_at > service.now())).count(),
        "groups": [group for group in groups.values() if group["students_count"]]}
