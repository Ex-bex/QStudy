"""Create a first admin interactively only when the selected store has none."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from data import load_environment
from diagnostics import error_code


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    arguments = parser.parse_args(argv)
    config = json.loads(Path(arguments.config).read_text(encoding="utf-8-sig"))
    root = Path(config["root"]).resolve()
    environment = load_environment(config)
    os.environ.clear()
    os.environ.update(environment)
    sys.path.insert(0, str(root / "backend"))
    os.chdir(root / "backend")
    from app.services.transfers import assert_no_incomplete_imports
    assert_no_incomplete_imports()
    source = root / "scripts/production/runtime.py"
    spec = importlib.util.spec_from_file_location("qstudy_native_accounts", source)
    accounts = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(accounts)
    try:
        summary = accounts.account_status()
    except Exception:
        summary = None
    if summary is not None and summary["active_admin_exists"]:
        print("QStudy: существующий администратор сохранён. Пароли аккаунтов не менялись.")
        return 0
    from app.services import backups
    from app.main import initialize_database
    backups.create_pre_upgrade_backup()
    initialize_database()
    summary = accounts.account_status()
    if not summary["active_admin_exists"]:
        print("В выбранной базе нет активного администратора. Создайте первого администратора до публикации сайта.")
        email = input("Email первого администратора: ").strip()
        accounts.first_admin(email)
    if not accounts.account_status()["active_admin_exists"]:
        raise RuntimeError("active_admin_required")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("QStudy: первоначальная проверка администратора не завершена: " + error_code(error) + ". Проверьте доступ к выбранной базе и файлу настроек. Пароли аккаунтов не сбрасывались.", file=sys.stderr)
        raise SystemExit(1)
