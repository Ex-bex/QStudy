"""Read only durable transfer state; never import, roll back or open a database."""
import argparse
import json
from pathlib import Path
import sys


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", default="")
    arguments = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
    try:
        from app.services.transfers import assert_no_incomplete_imports, read_import_receipt
        if arguments.receipt:
            print(json.dumps(read_import_receipt(arguments.receipt), ensure_ascii=True))
        else:
            assert_no_incomplete_imports()
        raise SystemExit(0)
    except Exception:
        print("QStudy: transfer recovery requires administrator attention. No automatic import or rollback was performed.", file=sys.stderr)
        raise SystemExit(1)
