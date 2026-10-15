"""Own the native API and production Next process after the startup window closes."""
import argparse
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from data import application_keys, atomic_json, load_environment


def utc():
    return datetime.now(timezone.utc).isoformat()


def valid_request(value, token: str, consumed: set[str]) -> bool:
    if not isinstance(value, dict) or set(value) != {"version", "id", "action", "payload", "requested_by", "issued_at", "signature"}:
        return False
    try:
        if value["version"] != 1 or type(value["requested_by"]) is not int or value["requested_by"] < 0:
            return False
        if len(value["id"]) != 32 or uuid.UUID(hex=value["id"]).hex != value["id"] or value["id"] in consumed:
            return False
        issued = datetime.fromisoformat(value["issued_at"].replace("Z", "+00:00"))
        if issued.tzinfo is None or abs((datetime.now(timezone.utc) - issued).total_seconds()) > 120:
            return False
        if value["action"] not in ("restart", "stop", "apply-import") or not isinstance(value["payload"], dict):
            return False
        if value["action"] == "apply-import":
            if set(value["payload"]) != {"transfer_id", "include_settings"} or type(value["payload"]["include_settings"]) is not bool:
                return False
            transfer = value["payload"]["transfer_id"]
            if len(transfer) != 32 or uuid.UUID(hex=transfer).hex != transfer:
                return False
        elif value["payload"]:
            return False
        unsigned = {key: item for key, item in value.items() if key != "signature"}
        encoded = json.dumps(unsigned, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
        expected = hmac.new(token.encode(), encoded, hashlib.sha256).hexdigest()
        return isinstance(value["signature"], str) and hmac.compare_digest(expected, value["signature"])
    except (ValueError, TypeError, KeyError, AttributeError):
        return False


def stop_child(child, *, private_stop: bool = False):
    if child is None or child.poll() is not None:
        return
    try:
        if private_stop:
            # CREATE_NO_WINDOW has no attached Windows console, so CTRL_BREAK
            # cannot be the primary graceful-shutdown channel.
            child.wait(timeout=20)
            return
        child.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGTERM)
        child.wait(timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        # Popen retains the actual child handle, so PID reuse cannot kill a stranger.
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)


def healthy(port: int, host: str = "") -> bool:
    try:
        request = urllib.request.Request("http://127.0.0.1:" + str(port) + "/api/health", headers={"Host": host} if host else {})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=2) as response:
            result = json.loads(response.read(16384))
            return response.status == 200 and result.get("service") == "QStudy"
    except Exception:
        return False


def network_stop(root: Path) -> None:
    if os.name != "nt":
        return
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    hook = root / "scripts/launcher/NetworkStop.ps1"
    result = subprocess.run([str(powershell), "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(hook)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW, timeout=45)
    if result.returncode:
        raise RuntimeError("network_cleanup_failed")


def frontend_environment(environment: dict, root: Path, mode: str) -> dict:
    result = {key: value for key, value in environment.items() if key not in application_keys(root)
              and not key.startswith("QSTUDY_")}
    for key in ("BFF_PROXY_SECRET", "PUBLIC_BASE_URL", "ALLOW_PUBLIC_HTTP", "BACKEND_URL", "TRUST_PROXY_HEADERS"):
        result[key] = environment[key]
    result["QSTUDY_ACCESS_MODE"] = mode
    return result


def stop_files(root: Path, instance: str) -> dict[str, Path]:
    if len(instance) != 32 or uuid.UUID(hex=instance).hex != instance:
        raise ValueError("invalid_runtime_instance")
    return {name: root / ".local/managed" / (name + "-stop-" + instance + ".json")
            for name in ("backend", "frontend")}


def publish_child_stops(root: Path, instance: str, children) -> None:
    files = stop_files(root, instance)
    for index, name in enumerate(("backend", "frontend")):
        if index < len(children) and children[index].poll() is None:
            atomic_json(files[name], {"version": 1, "instance": instance, "action": "stop"})


def clear_child_stops(root: Path, instance: str) -> None:
    for path in stop_files(root, instance).values():
        path.unlink(missing_ok=True)


def run(config: dict) -> int:
    root = Path(config["root"]).resolve()
    managed = root / ".local/managed"
    logs = root / ".local/logs"
    managed.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    children = []
    handles = []
    consumed = set()
    generation = 0
    last_action = None
    processed = managed / "processed.json"
    if processed.is_file():
        try:
            consumed.update(json.loads(processed.read_text())[-256:])
        except Exception:
            raise ValueError("invalid_control_history") from None
    flags = (subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW) if os.name == "nt" else 0

    def status(state, message=""):
        alive = len(children) == 2 and all(child.poll() is None for child in children)
        report = {"version": 1, "instance": config["instance"], "root_owner": str(root), "managed": True,
                  "mode": config["mode"], "data_source": config["data_source"], "public_url": config["site_url"],
                  "backend_port": config["backend_port"], "frontend_port": config["frontend_port"],
                  "ports": {"backend": config["backend_port"], "frontend": config["frontend_port"]},
                  "generation": generation,
                  "last_action": last_action,
                  "state": state, "status": "running" if state == "running" else "unavailable", "running": alive,
                  "control_available": True, "control_ready": True, "updated_at": utc(), "checked_utc": utc(), "message": message,
                  "backend_pid": children[0].pid if children else 0, "frontend_pid": children[1].pid if len(children) > 1 else 0}
        atomic_json(managed / "status.json", report)

    def stop():
        # Stop the UI before its private API. Let FastAPI finish jobs and SQLite writes.
        private_stop = True
        try:
            publish_child_stops(root, config["instance"], children)
        except Exception:
            private_stop = False
        for child in reversed(children):
            stop_child(child, private_stop=private_stop)
        children.clear()
        for handle in handles:
            handle.close()
        handles.clear()

    def start():
        nonlocal generation
        clear_child_stops(root, config["instance"])
        environment = load_environment(config)
        frontend_env = frontend_environment(environment, root, config["mode"])
        frontend_env["QSTUDY_INSTANCE"] = config["instance"]
        frontend_env["QSTUDY_FRONTEND_STOP_FILE"] = str(stop_files(root, config["instance"])["frontend"])
        guard = subprocess.run([sys.executable, "-I", str(Path(__file__).parent / "import_guard.py")],
                               cwd=root / "backend", env=environment, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags, timeout=30)
        if guard.returncode:
            raise RuntimeError("import_recovery_required")
        commands = [
            ([sys.executable, "-I", str(Path(__file__).parent / "backend.py"), "--port", str(config["backend_port"]), "--instance", config["instance"]], root / "backend", "backend"),
            ([config["node"], "--title=qstudy-" + config["instance"], str(root / "frontend/server.mjs"), "--hostname", config["bind"], "--port", str(config["frontend_port"])], root / "frontend", "frontend"),
        ]
        for command, directory, name in commands:
            log = open(logs / (name + "-" + config["instance"] + ".log"), "ab", buffering=0)
            handles.append(log)
            child = subprocess.Popen(command, cwd=directory, env=environment if name == "backend" else frontend_env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                     creationflags=flags, start_new_session=os.name != "nt")
            children.append(child)
            deadline = time.monotonic() + config.get("timeout_seconds", 180)
            host = config["site_url"].split("//", 1)[1] if name == "frontend" else ""
            port = config[name + "_port"]
            while not healthy(port, host):
                status("starting")
                if child.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError(name + "_health_failed")
                time.sleep(0.5)
        generation += 1
        status("running")

    try:
        start()
        while True:
            if any(child.poll() is not None for child in children):
                raise RuntimeError("child_exited")
            status("running")
            request_path = managed / "request.json"
            if request_path.is_file():
                claimed = managed / ("claimed-" + uuid.uuid4().hex + ".json")
                os.replace(request_path, claimed)
                try:
                    try:
                        if claimed.stat().st_size > 16384:
                            raise ValueError("oversized_control_request")
                        request = json.loads(claimed.read_text(encoding="utf-8-sig"))
                        valid = valid_request(request, config["control_token"], consumed)
                    except (ValueError, TypeError, OSError):
                        valid = False
                    if not valid:
                        status("running", "invalid_control_request_rejected")
                        continue
                    consumed.add(request["id"])
                    atomic_json(processed, sorted(consumed)[-256:])
                    action = request["action"]
                    last_action = {"id": request["id"], "action": action, "status": "running"}
                    status("stopping")
                    if action == "stop":
                        network_stop(root)
                    stop()
                    if action == "stop":
                        status("stopped")
                        return 0
                    if action == "apply-import":
                        payload = request["payload"]
                        environment = load_environment(config)
                        command = [sys.executable, "-I", str(Path(__file__).parent / "offline_import.py"), payload["transfer_id"], "1" if payload["include_settings"] else "0"]
                        try:
                            result = subprocess.run(command, cwd=root / "backend", env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                                    stderr=subprocess.PIPE, creationflags=flags, timeout=900)
                            imported = result.returncode == 0
                        except (subprocess.TimeoutExpired, OSError):
                            imported = False
                        if not imported:
                            receipt = subprocess.run([sys.executable, "-I", str(Path(__file__).parent / "import_guard.py"), "--receipt", payload["transfer_id"]],
                                                     cwd=root / "backend", env=load_environment(config), stdin=subprocess.DEVNULL,
                                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags, timeout=30)
                            try:
                                rolled_back = receipt.returncode == 0 and json.loads(receipt.stdout)["status"] == "failed_rolled_back"
                            except (ValueError, KeyError, TypeError):
                                rolled_back = False
                            if not rolled_back:
                                raise RuntimeError("explicit_import_unconfirmed")
                            last_action = {"id": request["id"], "action": action, "status": "failed", "code": "explicit_import_failed"}
                            print("QStudy: explicit import failed; a durable receipt confirms rollback. Restarting the existing store.", file=sys.stderr)
                    if last_action["status"] != "failed":
                        last_action["status"] = "complete"
                    start()
                finally:
                    claimed.unlink(missing_ok=True)
            time.sleep(1)
    except Exception as error:
        try:
            network_stop(root)
        except Exception:
            pass
        known = {"backend_health_failed", "frontend_health_failed", "child_exited", "network_cleanup_failed", "explicit_import_unconfirmed", "import_recovery_required"}
        code = str(error) if isinstance(error, RuntimeError) and str(error) in known else type(error).__name__
        status("failed", code)
        print("QStudy native launch failed (" + code + "). Check the separate backend/frontend logs; existing data were not reset.", file=sys.stderr)
        return 1
    finally:
        stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--instance", required=True)
    options = parser.parse_args()
    configuration = json.loads(Path(options.config).read_text(encoding="utf-8-sig"))
    if configuration["instance"] != options.instance:
        raise SystemExit(1)
    raise SystemExit(run(configuration))
