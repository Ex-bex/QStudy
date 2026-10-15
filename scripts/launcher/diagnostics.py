"""Fixed diagnostic codes, never exception values, SQL parameters or settings."""
import errno
import logging


def error_code(error) -> str:
    observed = set()
    current = error
    while current is not None and id(current) not in observed:
        observed.add(id(current))
        if isinstance(current, PermissionError) or getattr(current, "errno", None) in (errno.EACCES, errno.EPERM):
            return "storage_permission_denied"
        if getattr(current, "errno", None) == errno.ENOSPC:
            return "storage_disk_full"
        if getattr(current, "errno", None) in (errno.EADDRINUSE, 10048):
            return "port_in_use"
        name = type(current).__name__
        if name == "ValidationError":
            return "settings_validation_failed"
        if name in ("OperationalError", "DatabaseError"):
            message = str(current).lower()
            if "unable to open database file" in message:
                return "database_cannot_open"
            if "readonly database" in message or "read-only database" in message:
                return "database_read_only"
            if "locked" in message:
                return "database_busy"
            return "database_operation_failed"
        if name == "BackupError":
            return "backup_preflight_failed"
        current = current.__cause__ or current.__context__
    return "application_start_failed"


class SafeStartupLog(logging.Filter):
    def filter(self, record):
        if record.exc_info:
            record.msg = "QStudy API: " + error_code(record.exc_info[1]) + ". Existing data were not reset."
            record.args = ()
            record.exc_info = None
            record.exc_text = None
            record.stack_info = None
        else:
            text = record.getMessage()
            if "Traceback (most recent call last)" in text or "[parameters:" in text:
                if "unable to open database file" in text:
                    code = "database_cannot_open"
                elif "readonly database" in text or "read-only database" in text:
                    code = "database_read_only"
                elif "PermissionError" in text:
                    code = "storage_permission_denied"
                elif "ValidationError" in text:
                    code = "settings_validation_failed"
                else:
                    code = "application_start_failed"
                record.msg = "QStudy API: " + code + ". Check access to the selected database/settings and available disk space."
                record.args = ()
        return True
