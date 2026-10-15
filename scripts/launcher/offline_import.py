"""An explicit admin transfer command, invoked only after both children stop."""
import json
from pathlib import Path
import sys


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
    try:
        from app.services.transfers import apply_prepared_import
        result = apply_prepared_import(sys.argv[1], include_settings=sys.argv[2] == "1")
        print(json.dumps(result, ensure_ascii=True))
    except Exception as error:
        print("QStudy explicit import failed (" + type(error).__name__ + "). Check the transfer receipt in the administrator page.", file=sys.stderr)
        raise SystemExit(1)
