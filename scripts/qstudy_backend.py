"""Private local launcher entry point; do not log environment values or access URLs."""
from pathlib import Path
import argparse
import os
import sys

parser = argparse.ArgumentParser(description="QStudy private backend launcher")
parser.add_argument("--port", type=int, default=8000)
parser.add_argument("--qstudy-instance", default="")
arguments = parser.parse_args()
if not 1024 <= arguments.port <= 65535:
    parser.error("port must be between 1024 and 65535")

backend = Path(__file__).resolve().parents[1] / "backend"
os.chdir(backend)
sys.path.insert(0, str(backend))
try:
    import uvicorn
    from app.main import app
except Exception as error:
    print("QStudy could not load the backend (" + type(error).__name__ + "). Check backend/.env and install backend/requirements.txt. Environment values are not logged.", file=sys.stderr)
    raise SystemExit(1)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=arguments.port, access_log=False)
