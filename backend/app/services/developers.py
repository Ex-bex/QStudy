"""One-time starter directory; administrator edits and deletions always survive."""
from sqlalchemy.exc import IntegrityError

from app.models import AcademicSetting, DeveloperDepartment
from app.services.audit import record_audit

SEED_KEY = "qforce_developer_departments_seeded_v1"
DEPARTMENTS = (
    ("Coding Department", "Baidybek Nurzhigit", "coding"),
    ("Technology Department", "Serik Dauirzhan", "tech"),
    ("Presentation Department", "Qambar Asan", "press"),
    ("Business Department", "Torebek Bexultan", "business"),
)


def seed_developer_departments(db) -> int:
    if db.get(AcademicSetting, SEED_KEY) is not None:
        return 0
    # Claim the seed and create its rows in one transaction. A concurrent startup
    # can only observe the complete directory or lose the unique stamp race.
    db.add(AcademicSetting(key=SEED_KEY, value="1"))
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        if db.get(AcademicSetting, SEED_KEY) is not None:
            return 0
        raise
    count = 0
    if db.query(DeveloperDepartment.id).first() is None:
        for index, (name, director, logo) in enumerate(DEPARTMENTS):
            db.add(DeveloperDepartment(name=name, director=director, logo=logo, display_order=index * 10))
            count += 1
        record_audit(db, None, "developer_department.seed", "developer_department",
                     metadata={"source": "startup", "count": count})
    db.commit()
    return count
