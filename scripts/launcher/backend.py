"""The native API always listens on loopback; SIGBREAK requests graceful shutdown."""
import argparse
import asyncio
import os
from pathlib import Path
import signal
import sys
import copy
import json

sys.path.insert(0, str(Path(__file__).resolve().parent))
from diagnostics import SafeStartupLog, error_code


def stop_requested(path: Path, instance: str) -> bool:
    try:
        if path.is_symlink() or path.stat().st_size > 4096:
            return False
        with path.open("r", encoding="utf-8-sig") as source:
            request = json.load(source)
        return request == {"version": 1, "instance": instance, "action": "stop"}
    except (OSError, ValueError, TypeError):
        return False


async def serve_with_private_stop(server, stop_file: Path, instance: str):
    async def watch():
        while True:
            if stop_requested(stop_file, instance):
                server.should_exit = True
                return
            await asyncio.sleep(0.2)

    watcher = asyncio.create_task(watch())
    try:
        await server.serve()
    finally:
        watcher.cancel()
        try:
            await watcher
        except asyncio.CancelledError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--instance", required=True)
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    os.chdir(root / "backend")
    sys.path.insert(0, str(root / "backend"))
    try:
        import uvicorn
        from app.main import app
        logging_config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
        logging_config["filters"] = {"safe_startup": {"()": SafeStartupLog}}
        for handler in logging_config["handlers"].values():
            handler["filters"] = ["safe_startup"]
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=arguments.port, access_log=False, proxy_headers=False, log_config=logging_config))
        if hasattr(signal, "SIGBREAK"):
            signal.signal(signal.SIGBREAK, lambda *_: setattr(server, "should_exit", True))
        stop_file = root / ".local/managed" / ("backend-stop-" + arguments.instance + ".json")
        asyncio.run(serve_with_private_stop(server, stop_file, arguments.instance))
        return 0
    except Exception as error:
        print("QStudy API startup failed: " + error_code(error) + ". Check access to the selected database/settings and available disk space.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
