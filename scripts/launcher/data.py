"""Native launch settings. Never import, replace or reset a database at startup."""
import ast
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time


def dataset(root: Path, source: str) -> dict:
    root = root.resolve()
    if source not in ("local", "deployment"):
        raise ValueError("invalid_data_source")
    folder = root / ("backend" if source == "local" else "deployment/data/backend")
    env_file = root / ("backend/.env" if source == "local" else "deployment/.env")
    return {"database": folder / "studyhub.db", "uploads": folder / "uploads", "env_file": env_file,
            "backups": root / (".backups/automatic" if source == "local" else "deployment/data/backups")}


def private_file(path: Path, sid: str = "") -> None:
    if os.name == "nt":
        if not re.fullmatch(r"S-1-\d+(?:-\d+)+", sid):
            raise ValueError("invalid_owner")
        command = [str(Path(os.environ["SystemRoot"]) / "System32/icacls.exe"), str(path), "/inheritance:r", "/grant:r",
                   "*" + sid + ":F", "*S-1-5-18:F", "*S-1-5-32-544:F"]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
    else:
        path.chmod(0o600)


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".native-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=True, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        for attempt in range(12):
            try:
                os.replace(temporary, path)
                break
            except OSError as error:
                # Windows readers (including PowerShell 5.1) can open status
                # without FILE_SHARE_DELETE. Keep the old whole JSON until a
                # brief reader/AV sharing conflict clears; permanent denial is
                # still raised after a bounded total wait of under one second.
                if os.name != "nt" or getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 11:
                    raise
                time.sleep(min(0.01 * 2 ** attempt, 0.1))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def application_keys(root: Path) -> set[str]:
    tree = ast.parse((root / "backend/app/config.py").read_text(encoding="utf-8-sig"))
    model = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Settings")
    return {node.target.id for node in model.body if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id.isupper()}


def load_environment(config: dict) -> dict:
    from dotenv import dotenv_values
    root = Path(config["root"]).resolve()
    paths = dataset(root, config["data_source"])
    env_file = paths["env_file"]
    original_bytes = env_file.read_bytes()
    text = original_bytes.decode("utf-8-sig")
    selected = dotenv_values(stream=io.StringIO(text), interpolate=False)
    if not selected.get("SECRET_KEY") or len(selected["SECRET_KEY"]) < 32:
        raise ValueError("existing_secret_invalid")
    if not selected.get("BFF_PROXY_SECRET", "").strip():
        token = secrets.token_urlsafe(48)
        line = "BFF_PROXY_SECRET=" + token
        pattern = re.compile(r"(?m)^[ \t]*BFF_PROXY_SECRET[ \t]*=[^\r\n]*")
        updated = pattern.sub(line, text) if pattern.search(text) else text + ("" if not text or text.endswith("\n") else "\n") + line + "\n"
        descriptor, temporary = tempfile.mkstemp(prefix=".qstudy-settings-", suffix=".tmp", dir=env_file.parent)
        try:
            os.close(descriptor)
            private_file(Path(temporary), config["owner_sid"])
            with open(temporary, "wb") as output:
                output.write((b"\xef\xbb\xbf" if original_bytes.startswith(b"\xef\xbb\xbf") else b"") + updated.encode("utf-8"))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, env_file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        selected["BFF_PROXY_SECRET"] = token
    allowed = application_keys(root)
    environment = {key: value for key, value in os.environ.items() if key not in allowed}
    environment.update({key: value for key, value in selected.items() if key in allowed and value is not None})
    environment.update({
        "DATABASE_URL": "sqlite:///" + paths["database"].as_posix(),
        "UPLOAD_DIR": str(paths["uploads"]), "BACKUP_DIR": str(paths["backups"]),
        "PUBLIC_BASE_URL": config["site_url"], "CORS_ORIGINS": config["site_url"],
        "ALLOW_PUBLIC_HTTP": "true" if config["mode"] == "internet" else "false",
        "BACKEND_URL": "http://127.0.0.1:" + str(config["backend_port"]),
        "NODE_ENV": "production", "NEXT_TELEMETRY_DISABLED": "1", "PYTHONUNBUFFERED": "1",
        "TRUST_PROXY_HEADERS": "true", "QSTUDY_MANAGED_RUNTIME": "1", "QSTUDY_PROJECT_ROOT": str(root),
        "QSTUDY_ENV_FILE": str(env_file), "QSTUDY_CONTROL_DIR": str(root / ".local/managed"),
        "QSTUDY_CONTROL_TOKEN": config["control_token"],
        "QSTUDY_ACCESS_MODE": config["mode"],
    })
    for key in ("NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME"):
        environment.pop(key, None)
    return environment
