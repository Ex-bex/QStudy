"""Production configuration preflight; never print credentials or dotenv contents."""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import sys
import urllib.request


class ConfigurationError(ValueError):
    pass


def deployment_directory() -> Path:
    return Path(__file__).resolve().parents[2] / "deployment"


def safe_path(base: Path, relative: str) -> Path:
    if base.is_symlink() or (hasattr(base, "is_junction") and base.is_junction()):
        raise ConfigurationError("Production storage must not contain filesystem links.")
    base = base.resolve()
    candidate = base / relative
    if not candidate.resolve().is_relative_to(base):
        raise ConfigurationError("Production paths must remain inside deployment/.")
    current = base
    for part in Path(relative).parts:
        current /= part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ConfigurationError("Production storage must not contain filesystem links.")
    return candidate


def normalized_domain(value: str) -> str:
    try:
        value = value.strip().rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise ConfigurationError("Use a valid DNS domain, without https:// or a path.") from error
    labels = value.split(".")
    label_pattern = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
    if len(value) > 253 or len(labels) < 2 or any(not label_pattern.fullmatch(label) for label in labels) or labels[-1].isdigit():
        raise ConfigurationError("Use a valid DNS domain, without https:// or a path.")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ConfigurationError("Automatic public HTTPS requires a DNS domain, rather than an IP address.")


def read_environment(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*", line)
        if not match:
            raise ConfigurationError("Malformed deployment/.env. Use one KEY='value' setting per line.")
        key, value = match.groups()
        if key in values:
            raise ConfigurationError("Duplicate settings in deployment/.env.")
        if value.startswith("'"):
            quoted = re.fullmatch(r"'([^']*)'\s*(?:#.*)?", value)
            if not quoted or quoted.group(1).endswith("\\"):
                raise ConfigurationError("Use simple single-quoted values without embedded apostrophes or a final backslash in deployment/.env.")
            value = quoted.group(1)
        elif value.startswith('"'):
            quoted = re.fullmatch(r'"([^"\\]*)"\s*(?:#.*)?', value)
            if not quoted:
                raise ConfigurationError("Double-quoted values with escapes are unsupported. Use simple single-quoted values in deployment/.env.")
            value = quoted.group(1)
            if "$" in value:
                raise ConfigurationError("Single-quote values containing $ so Docker Compose preserves their literal value.")
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
            if any(character in value for character in ("$", "\\", "'", '"')):
                raise ConfigurationError("Single-quote values containing $, quotes or backslashes in deployment/.env.")
        if any(character in value for character in ("\r", "\n", "\x00")):
            raise ConfigurationError("Environment settings must not contain control characters.")
        values[key] = value
    return values


def initialize(base: Path, domain: str, email: str) -> dict:
    domain = normalized_domain(domain)
    if not re.fullmatch(r"[^\s@'<>]+@[^\s@'<>]+\.[^\s@'<>]+", email):
        raise ConfigurationError("Supply a certificate contact email as the second init argument.")
    path = safe_path(base, ".env")
    base.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if read_environment(path).get("QSTUDY_DOMAIN") != domain:
            raise ConfigurationError("An existing deployment/.env was preserved. Edit its domain settings explicitly.")
        for relative in ("data/backend/uploads", "data/backups"):
            safe_path(base, relative).mkdir(parents=True, exist_ok=True)
        return {"status": "preserved", "configuration": "deployment/.env", "secrets_overwritten": False}
    template = (base / ".env.example").read_text(encoding="utf-8")
    replacements = {"QSTUDY_DOMAIN": domain, "ACME_EMAIL": email,
                    "PUBLIC_BASE_URL": "https://" + domain,
                    "SECRET_KEY": secrets.token_hex(32), "BFF_PROXY_SECRET": secrets.token_hex(32)}
    for key, value in replacements.items():
        template, count = re.subn(r"^" + re.escape(key) + r"=.*$", lambda _: key + "='" + value + "'", template, flags=re.MULTILINE)
        if count != 1:
            raise ConfigurationError("Production configuration template is incomplete.")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as target:
        target.write(template)
        target.flush()
        os.fsync(target.fileno())
    for relative in ("data/backend/uploads", "data/backups"):
        safe_path(base, relative).mkdir(parents=True, exist_ok=True)
    return {"status": "created", "configuration": "deployment/.env", "credentials_printed": False}


def check(base: Path, offline: bool = False) -> dict:
    path = safe_path(base, ".env")
    if not path.is_file():
        raise ConfigurationError("Run Manage-QStudy.sh init DOMAIN CONTACT_EMAIL first.")
    if os.name != "nt" and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ConfigurationError("deployment/.env must be private: chmod 600 deployment/.env.")
    values = read_environment(path)
    domain = normalized_domain(values.get("QSTUDY_DOMAIN", ""))
    if values.get("PUBLIC_BASE_URL") != "https://" + domain:
        raise ConfigurationError("PUBLIC_BASE_URL must equal https:// followed by QSTUDY_DOMAIN, without a trailing slash.")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", values.get("ACME_EMAIL", "")):
        raise ConfigurationError("Set ACME_EMAIL for certificate notifications.")
    for key in ("SECRET_KEY", "BFF_PROXY_SECRET"):
        secret = values.get(key, "")
        if len(secret) < 32 or secret.lower().startswith(("change", "replace", "your_")):
            raise ConfigurationError("Generate both private application and proxy secrets with init.")
    if values["SECRET_KEY"] == values["BFF_PROXY_SECRET"]:
        raise ConfigurationError("Application and proxy secrets must be distinct.")
    recovery = values.get("RECOVERY_DELIVERY", "disabled")
    if recovery not in ("disabled", "smtp"):
        raise ConfigurationError("Public hosts require RECOVERY_DELIVERY='smtp' or 'disabled'; local recovery is unsupported.")
    if recovery == "smtp" and any(not values.get(key, "").strip() for key in ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM")):
        raise ConfigurationError("Complete the SMTP settings, or disable recovery until they are ready.")
    for relative in ("data/backend", "data/backend/uploads", "data/backups"):
        directory = safe_path(base, relative)
        if not directory.is_dir():
            raise ConfigurationError("Persistent data folders are missing; run init again and permissions.")
    if not offline:
        try:
            addresses = socket.getaddrinfo(domain, 443, type=socket.SOCK_STREAM)
        except socket.gaierror as error:
            raise ConfigurationError("The domain does not resolve. Create its DNS A/AAAA records first.") from error
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ConfigurationError("The production domain must resolve to public server addresses.")
    return {"status": "configuration_valid", "public_url": "https://" + domain,
            "dns_checked": not offline, "mail_enabled": recovery == "smtp"}


def permissions(base: Path) -> dict:
    if os.name == "nt" or os.geteuid() != 0:
        raise ConfigurationError("Run production permissions on Linux with sudo.")
    paths = []
    for relative in ("data/backend", "data/backups"):
        directory = safe_path(base, relative)
        directory.mkdir(parents=True, exist_ok=True)
        paths.append(directory)
        for current, folders, filenames in os.walk(directory, followlinks=False):
            for name in folders + filenames:
                path = Path(current) / name
                mode = path.lstat().st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                    raise ConfigurationError("Production storage contains a filesystem link or non-regular file.")
                paths.append(path)
    for path in paths:
        os.chown(path, 10001, 10001, follow_symlinks=False)
        os.chmod(path, 0o700 if path.is_dir() else 0o600, follow_symlinks=False)
    os.chmod(safe_path(base, ".env"), 0o600)
    os.chmod(safe_path(base, "data"), 0o700)
    return {"status": "permissions_ready", "backend_uid": 10001, "backend_gid": 10001}


def probe(base: Path) -> dict:
    values = read_environment(safe_path(base, ".env"))
    origin = "https://" + normalized_domain(values.get("QSTUDY_DOMAIN", ""))
    with urllib.request.urlopen(origin + "/api/health", timeout=25) as response:
        health = json.loads(response.read(10_000))
        if response.status != 200 or health.get("status") != "ok" or health.get("service") != "QStudy":
            raise ConfigurationError("The public API health response is not QStudy.")
    with urllib.request.urlopen(origin + "/", timeout=25) as response:
        if response.status != 200:
            raise ConfigurationError("The public homepage is unavailable.")
        if "max-age=" not in response.headers.get("Strict-Transport-Security", ""):
            raise ConfigurationError("The public proxy is missing its HTTPS security header.")
    return {"status": "public_https_verified", "public_url": origin}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    init = subparsers.add_parser("init")
    init.add_argument("domain")
    init.add_argument("email")
    validation = subparsers.add_parser("check")
    validation.add_argument("--offline", action="store_true")
    subparsers.add_parser("permissions")
    subparsers.add_parser("probe")
    arguments = parser.parse_args()
    base = deployment_directory()
    try:
        if arguments.command == "init":
            result = initialize(base, arguments.domain, arguments.email)
        elif arguments.command == "check":
            result = check(base, arguments.offline)
        elif arguments.command == "permissions":
            result = permissions(base)
        else:
            result = probe(base)
    except ConfigurationError as error:
        print("QStudy: " + str(error), file=sys.stderr)
        return 1
    except Exception as error:
        print("QStudy production preflight failed (" + type(error).__name__ + "). Check file access, DNS and HTTPS. Credentials were not printed.", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
