"""Portable upload references, always resolved inside the configured private root."""
from pathlib import Path, PureWindowsPath


def resolve_upload_path(value: str, upload_dir: str | Path) -> Path:
    if not value or "\x00" in value:
        raise ValueError("Invalid upload reference")
    root = Path(upload_dir).resolve()
    path = Path(value)
    if PureWindowsPath(value).drive and not path.is_absolute():
        raise ValueError("Invalid upload drive")
    candidate = (path if path.is_absolute() else root / path).resolve()
    if candidate == root or not candidate.is_relative_to(root):
        raise ValueError("Upload reference leaves private storage")
    # Original installations stored "uploads/<uuid>" relative to backend cwd.
    # Prefer a real canonical file if both layouts exist; otherwise strip only
    # the known configured directory name, never search by basename.
    if not path.is_absolute() and len(path.parts) > 1 and path.parts[0] == root.name and not candidate.exists():
        legacy = (root / Path(*path.parts[1:])).resolve()
        if legacy == root or not legacy.is_relative_to(root):
            raise ValueError("Upload reference leaves private storage")
        candidate = legacy
    return candidate


def relative_upload_path(value: str | Path, upload_dir: str | Path) -> str:
    candidate = resolve_upload_path(str(value), upload_dir)
    return candidate.relative_to(Path(upload_dir).resolve()).as_posix()
