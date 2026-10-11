"""Check QStudy SMTP configuration, verified TLS and login without sending mail.

Run with backend/.venv/Scripts/python.exe scripts/check_mail.py from the project
root. Output never includes configuration values or SMTP provider messages.
"""
from __future__ import annotations

import argparse
import json
import smtplib
import ssl
import sys
from pathlib import Path


class _PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse normally echoes bad argument values; diagnostics stay private.
        raise ValueError("Invalid diagnostic arguments")


def _load_runtime(project_root: Path):
    """Defer app imports so configuration validation errors can be redacted."""
    sys.path.insert(0, str(project_root / "backend"))
    from app.config import settings
    from app.services.password_recovery import _mail_sender, recovery_mode

    return settings, recovery_mode, _mail_sender


def _initial_report() -> dict:
    return {"ok": False, "stage": "config", "connect": False, "tls": False,
            "auth": "not_attempted"}


def _error_report(report: dict, error: Exception) -> dict:
    if report["auth"] == "attempting":
        report["auth"] = "failed"
    report["error"] = type(error).__name__
    code = getattr(error, "smtp_code", None)
    if type(code) is int and 100 <= code <= 599:
        report["smtp_code"] = code
    return report


def _require_reply(reply, accepted: set[int]):
    code, _message = reply
    if code not in accepted:
        # Preserve only the numeric status; server replies may contain secrets.
        raise smtplib.SMTPResponseException(code, b"")
    return code


def check_mail(config, recovery_mode, validate_sender) -> dict:
    """Return safe diagnostics; injectable config/helpers keep tests isolated."""
    report = _initial_report()
    try:
        if recovery_mode() != "smtp":
            raise ValueError("SMTP recovery is not enabled")
        if not config.SMTP_HOST or config.SMTP_SECURITY not in ("starttls", "ssl"):
            raise ValueError("Invalid SMTP transport configuration")
        validate_sender(config.SMTP_FROM)
        username, password = config.SMTP_USERNAME, config.SMTP_PASSWORD
        gmail = config.SMTP_HOST.strip().lower().rstrip(".") in (
            "smtp.gmail.com", "smtp.googlemail.com"
        )
        if (gmail and (not username or not password)) or bool(username) != bool(password):
            raise ValueError("SMTP authentication configuration is incomplete")

        context = ssl.create_default_context()
        constructor = smtplib.SMTP_SSL if config.SMTP_SECURITY == "ssl" else smtplib.SMTP
        options = {"timeout": 15}
        if config.SMTP_SECURITY == "ssl":
            options["context"] = context
        report["stage"] = "connect"
        with constructor(config.SMTP_HOST, config.SMTP_PORT, **options) as server:
            report["connect"] = True
            if config.SMTP_SECURITY == "ssl":
                report["tls"] = True
            _require_reply(server.ehlo(), {250})
            if config.SMTP_SECURITY == "starttls":
                report["stage"] = "tls"
                _require_reply(server.starttls(context=context), {220})
                report["tls"] = True
                _require_reply(server.ehlo(), {250})
            report["stage"] = "auth"
            if username:
                report["auth"] = "attempting"
                report["smtp_code"] = _require_reply(server.login(username, password), {235, 503})
                report["auth"] = "authenticated"
            else:
                report["auth"] = "not_configured"
            report["stage"] = "disconnect"
        report["ok"] = True
        report["stage"] = "complete"
    except Exception as error:
        _error_report(report, error)
    return report


def main(argv=None) -> int:
    report = _initial_report()
    try:
        parser = _PrivateArgumentParser(description="Check SMTP TLS and authentication; no mail is sent")
        parser.add_argument("--project-root", default=str(Path(__file__).resolve().parents[1]))
        args = parser.parse_args(argv)
        config, mode, sender = _load_runtime(Path(args.project_root).resolve())
        report = check_mail(config, mode, sender)
    except Exception as error:
        _error_report(report, error)
    print(json.dumps(report, ensure_ascii=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
