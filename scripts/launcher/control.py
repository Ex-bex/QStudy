"""Signed local supervisor control; credentials never enter command arguments."""
import argparse
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import tempfile
import uuid


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--action", choices=("stop", "restart"), required=True)
    options = parser.parse_args(argv)
    config = json.loads(Path(options.config).read_text(encoding="utf-8-sig"))
    request = {"version": 1, "id": uuid.uuid4().hex, "action": options.action, "payload": {}, "requested_by": 0,
               "issued_at": datetime.now(timezone.utc).isoformat()}
    encoded = json.dumps(request, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    request["signature"] = hmac.new(config["control_token"].encode(), encoded, hashlib.sha256).hexdigest()
    target = Path(config["root"]) / ".local/managed/request.json"
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=".control-", suffix=".tmp", dir=target.parent)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(request, output, ensure_ascii=True)
            output.flush()
            os.fsync(output.fileno())
        if os.name == "nt":
            os.rename(temporary, target)  # Windows refuses an existing target.
        else:
            os.link(temporary, target)  # Atomic no-replace publication on POSIX.
        return 0
    except FileExistsError:
        print("QStudy: another administrator command is pending. Wait before changing launch mode.", file=sys.stderr)
        return 2
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    raise SystemExit(main())
