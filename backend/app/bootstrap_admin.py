"""One-time, local administrator bootstrap. Never grant admin on public signup."""
import argparse
from getpass import getpass
from sqlalchemy import func
from pydantic import TypeAdapter, EmailStr
from app.auth import hash_password, validate_password
from app.database import SessionLocal
from app.models import User


def main():
    parser = argparse.ArgumentParser(description="Create or promote a QStudy administrator")
    parser.add_argument("email")
    parser.add_argument("--name", default="Администратор")
    args = parser.parse_args()
    email = str(TypeAdapter(EmailStr).validate_python(args.email)).strip().lower()
    password = validate_password(getpass("New administrator password (10+ chars, letter + digit): "))
    if password != getpass("Repeat password: "):
        raise SystemExit("Passwords do not match")
    # Initialize non-destructive migrations and seed default group.
    from app.main import initialize_database
    initialize_database()
    with SessionLocal() as db:
        user = db.query(User).filter(func.lower(User.email) == email).first()
        if user is None:
            user = User(email=email, name=args.name, hashed_password=hash_password(password), role="admin")
            db.add(user)
        else:
            user.role = "admin"
            user.is_active = True
            user.hashed_password = hash_password(password)
            user.token_version += 1
        db.commit()
    print("Administrator account is ready. Existing sessions have been revoked.")


if __name__ == "__main__":
    main()
