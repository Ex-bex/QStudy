"""Opt-in production BFF + real TCP/WebSocket + disposable SQLite integration.

Run after `npm run build` with QSTUDY_LUMABALL_STACK_TEST=1, or use --run.
No project database, .env, running server, firewall or public listener is used.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode


ROOT = Path(__file__).resolve().parents[2]

FIXTURE_API = '''from contextlib import asynccontextmanager
from fastapi import FastAPI
from sqlalchemy import select
from app.database import Base, engine, SessionLocal
from app.models import User
from app.auth import hash_password
from app.routers import auth_routes, lumaball_identity, lumaball_rooms
from app.services import lumaball_realtime
from app.services.lumaball_rooms import initialize_rooms

@asynccontextmanager
async def lifespan(app):
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        for email, name, role in (
            ("stack-admin@example.com", "Stack administrator", "admin"),
            ("stack-student@example.com", "Stack student", "student")):
            if db.scalar(select(User).where(User.email == email)) is None:
                db.add(User(email=email, name=name, role=role,
                            hashed_password=hash_password("FixturePassword4729")))
        db.commit()
        initialize_rooms(db)
    await lumaball_realtime.hub.start()
    try:
        yield
    finally:
        await lumaball_realtime.hub.stop()
        engine.dispose()

app = FastAPI(lifespan=lifespan)
for module in (auth_routes, lumaball_identity, lumaball_rooms, lumaball_realtime):
    app.include_router(module.router, prefix="/api")

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "QStudy"}
'''


class StackFailure(Exception):
    pass


def require(condition, description):
    if not condition:
        raise StackFailure(description)


def free_port(exclude=()):
    for _ in range(10):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        if port not in exclude:
            return port
    raise StackFailure("Could not reserve distinct disposable loopback ports")


def base_environment():
    allowed = {"SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA",
               "APPDATA", "USERPROFILE", "HOME", "LANG", "LC_ALL", "COMSPEC"}
    return {key: value for key, value in os.environ.items() if key.upper() in allowed}


def stop_child(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def startup_category(log_path):
    """Report only fixed categories from bounded, disposable child logs."""
    if log_path is None:
        return "not-collected"
    try:
        with Path(log_path).open("rb") as source:
            source.seek(0, os.SEEK_END)
            source.seek(max(0, source.tell() - 64 * 1024))
            value = source.read(64 * 1024).decode("utf-8", errors="replace")
    except OSError:
        return "unavailable"
    categories = (
        (("EADDRINUSE",), "port-in-use"),
        (("EACCES", "EPERM"), "permission-denied"),
        (("ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "Cannot find module"), "module-not-found"),
        (("ENOENT", "Could not find a production build", "BUILD_ID"), "build-file-missing"),
        (("QStudy: frontend listener failed",), "listener-failed"),
        (("QStudy: frontend could not start",), "frontend-prepare-failed"),
        (("TypeError",), "type-error"),
        (("ReferenceError",), "reference-error"),
        (("Error", "Traceback"), "runtime-error"),
    )
    for markers, category in categories:
        if any(marker in value for marker in markers):
            return category
    return "no-error-output"


def wait_healthy(url, process, *, seconds=90, log_path=None):
    import httpx
    until = time.monotonic() + seconds
    last_http = None
    last_issue = "none"

    def diagnostics():
        exit_code = process.poll()
        state = "alive" if exit_code is None else f"exit-{exit_code}"
        return f"http={last_http}, issue={last_issue}, process={state}, child={startup_category(log_path)}"

    with httpx.Client(timeout=1, trust_env=False) as client:
        while time.monotonic() < until:
            if process.poll() is not None:
                raise StackFailure("A disposable server exited during startup (" + diagnostics() + ")")
            try:
                response = client.get(url)
                last_http = response.status_code
                last_issue = "non-success-http" if last_http != 200 else "health-marker-mismatch"
                if last_http == 200:
                    payload = response.json()
                    if isinstance(payload, dict) and payload.get("service") == "QStudy":
                        return
            except httpx.HTTPError as error:
                last_issue = type(error).__name__
            except ValueError:
                last_issue = "non-json-health-response"
            time.sleep(0.2)
    raise StackFailure("Disposable server health deadline exceeded (" + diagnostics() + ")")


def response_json(response, status=200):
    require(response.status_code == status, f"Unexpected HTTP status {response.status_code}; expected {status}")
    return response.json()


def session(client):
    response = client.post("/api/lumaball/session")
    value = response_json(response)
    require("guest_token" not in value, "BFF exposed the private guest credential")
    return value, response


def receive(connection, kind, predicate=lambda value: True):
    until = time.monotonic() + 8
    for _ in range(40):
        remaining = until - time.monotonic()
        require(remaining > 0, "WebSocket event deadline exceeded")
        value = json.loads(connection.recv(timeout=remaining))
        if value.get("type") == kind and predicate(value):
            return value
    raise StackFailure("Expected WebSocket event was not delivered")


def send(connection, value):
    connection.send(json.dumps(value, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Explicitly run the disposable production integration")
    parser.add_argument("--node", default=None, help="Optional absolute portable Node executable")
    args = parser.parse_args()
    if not args.run and os.environ.get("QSTUDY_LUMABALL_STACK_TEST") != "1":
        print("SKIP: set QSTUDY_LUMABALL_STACK_TEST=1 or pass --run after building frontend.")
        return 0
    require((ROOT / "frontend" / ".next" / "BUILD_ID").is_file(), "Build frontend before running this integration")
    node = args.node or shutil.which("node")
    require(node is not None and Path(node).is_file(), "Node executable was not found")
    # Next loads environment files from its project directory. Refuse those
    # rather than let a fixture accidentally load private frontend settings.
    require(not any((ROOT / "frontend" / name).exists() for name in
                    (".env", ".env.local", ".env.production", ".env.production.local")),
            "Disposable integration requires no frontend .env files")
    import httpx
    from websockets.sync.client import connect
    from websockets.exceptions import InvalidStatus

    stage = "preparing fixtures"
    try:
        with tempfile.TemporaryDirectory(prefix="qstudy-lumaball-stack-") as temporary, ExitStack() as stack:
            folder = Path(temporary)
            (folder / "stack_fixture.py").write_text(FIXTURE_API, encoding="utf-8")
            database = folder / "fixture.sqlite3"
            uploads = folder / "uploads"; uploads.mkdir()
            api_port = free_port()
            site_port = free_port(exclude=(api_port,))
            api_url = f"http://127.0.0.1:{api_port}"
            site_url = f"http://127.0.0.1:{site_port}"
            environment = base_environment()
            environment.update({
                "SECRET_KEY": secrets.token_hex(32),
                "BFF_PROXY_SECRET": secrets.token_hex(32),
                "QSTUDY_MANAGED_RUNTIME": "1",
                "DATABASE_URL": "sqlite:///" + database.as_posix(),
                "UPLOAD_DIR": str(uploads), "BACKUP_DIR": str(folder / "backups"),
                "BACKUPS_ENABLED": "false", "RATE_LIMIT_ENABLED": "false",
                "PUBLIC_BASE_URL": site_url, "CORS_ORIGINS": site_url,
                "ALLOW_PUBLIC_HTTP": "false", "RECOVERY_DELIVERY": "disabled",
                "GEMINI_API_KEY": "", "SMTP_HOST": "", "SMTP_PASSWORD": "",
                "PYTHONPATH": str(ROOT / "backend"), "PYTHONUTF8": "1",
                "PYTHONUNBUFFERED": "1", "NODE_ENV": "production",
                "NEXT_TELEMETRY_DISABLED": "1", "TRUST_PROXY_HEADERS": "true",
                "QSTUDY_ACCESS_MODE": "local", "BACKEND_URL": api_url,
            })
            api_log = stack.enter_context((folder / "api.log").open("wb"))
            node_log = stack.enter_context((folder / "frontend.log").open("wb"))
            api = None
            frontend = None
            api_command = [sys.executable, "-m", "uvicorn", "stack_fixture:app", "--host", "127.0.0.1", "--port", str(api_port),
                           "--no-access-log", "--log-level", "error", "--ws-max-size", str(24 * 1024)]

            def start_api():
                process = subprocess.Popen(api_command, cwd=folder, env=environment, stdin=subprocess.DEVNULL,
                                           stdout=api_log, stderr=subprocess.STDOUT)
                try:
                    wait_healthy(api_url + "/api/health", process, seconds=30, log_path=folder / "api.log")
                except Exception:
                    stop_child(process)
                    raise
                return process

            try:
                stage = "starting isolated API"
                api = start_api()
                stage = "starting production frontend"
                frontend = subprocess.Popen([node, str(ROOT / "frontend" / "server.mjs"), "--hostname", "127.0.0.1", "--port", str(site_port)],
                                            # Match the real native launcher. Fresh Next builds
                                            # may resolve runtime assets from process.cwd().
                                            cwd=ROOT / "frontend", env=environment, stdin=subprocess.DEVNULL,
                                            stdout=node_log, stderr=subprocess.STDOUT)
                wait_healthy(site_url + "/api/health", frontend, log_path=folder / "frontend.log")
                host = stack.enter_context(httpx.Client(base_url=site_url, headers={"Origin": site_url}, timeout=12, trust_env=False))
                peer = stack.enter_context(httpx.Client(base_url=site_url, headers={"Origin": site_url}, timeout=12, trust_env=False))
                admin = stack.enter_context(httpx.Client(base_url=site_url, headers={"Origin": site_url}, timeout=12, trust_env=False))
                student = stack.enter_context(httpx.Client(base_url=site_url, headers={"Origin": site_url}, timeout=12, trust_env=False))

                stage = "checking public pages and HttpOnly guest sessions"
                landing = host.get("/lumaball")
                require(landing.status_code == 200 and "LumaBall" in landing.text, "Public game landing page did not render")
                host_session, host_response = session(host)
                peer_session, peer_response = session(peer)
                host_identity, peer_identity = host_session["identity"], peer_session["identity"]
                require(host_identity["kind"] == peer_identity["kind"] == "guest", "Anonymous play did not create guest identities")
                require(host_identity["id"] != peer_identity["id"] and host_identity["name"] != peer_identity["name"], "Guest identities were not unique")
                for response in (host_response, peer_response):
                    cookie = response.headers.get("set-cookie", "").lower()
                    require("lumaball_guest=" in cookie and "httponly" in cookie
                            and ("samesite=strict" in cookie or "samesite=lax" in cookie),
                            "Guest credential is not protected by an HttpOnly SameSite cookie")
                require(response_json(host.get("/api/lumaball/me"))["identity"]["id"] == host_identity["id"], "BFF did not restore guest identity from its cookie")
                require(host.get("/api/admin/lumaball/settings").status_code == 401, "Guest reached administrator settings")
                require(host.patch("/api/admin/lumaball/settings", json={"title": "Unauthorised"}).status_code == 401,
                        "Guest changed administrator settings")
                require(host.post("/api/lumaball/rooms", headers={"Origin": "http://foreign.example"},
                                  json={"name": "Cross-origin room"}).status_code == 403,
                        "Production BFF accepted a cross-origin mutation")

                stage = "checking shared QStudy accounts and administrator settings"
                for client, email in ((admin, "stack-admin@example.com"), (student, "stack-student@example.com")):
                    logged_in = response_json(client.post("/api/auth/login", data={"username": email, "password": "FixturePassword4729"}))
                    require("access_token" not in logged_in and "token" not in logged_in, "BFF exposed the QStudy bearer token")
                    require("qstudy_session" in client.cookies, "QStudy login did not set its session cookie")
                member_session, _ = session(student)
                require(member_session["identity"]["kind"] == "user" and member_session["identity"].get("user_id") is not None,
                        "LumaBall did not reuse the signed-in QStudy account")
                require(student.get("/api/admin/lumaball/settings").status_code == 403, "Student gained administrator privileges")
                response_json(admin.patch("/api/admin/lumaball/settings", json={"announcement": "Fixture persisted announcement"}))

                stage = "creating and joining a password-protected room through BFF"
                room = response_json(host.post("/api/lumaball/rooms", json={"name": "Stack arena", "password": "fixture-room", "max_players": 4}), 201)
                require(peer.post("/api/lumaball/rooms/" + room["id"] + "/join", json={"password": "wrong"}).status_code == 403,
                        "Room password was not enforced")
                response_json(peer.post("/api/lumaball/rooms/" + room["id"] + "/join", json={"password": "fixture-room"}))
                host_ticket = session(host)[0]["ws_ticket"]
                peer_ticket = session(peer)[0]["ws_ticket"]
                ws_root = site_url.replace("http://", "ws://") + "/api/lumaball/ws?"
                with ExitStack() as connections:
                    stage = "upgrading both WebSockets through the production Node listener"
                    rejected = False
                    try:
                        with connect(ws_root + urlencode({"ticket": host_ticket, "room": room["id"]}),
                                     origin="http://foreign.example", open_timeout=8, close_timeout=2, proxy=None):
                            pass
                    except InvalidStatus as error:
                        rejected = error.response.status_code == 403
                    require(rejected, "Production WebSocket proxy accepted a cross-origin handshake")
                    host_ws = connections.enter_context(connect(ws_root + urlencode({"ticket": host_ticket, "room": room["id"]}),
                        origin=site_url, open_timeout=8, close_timeout=2, max_size=24 * 1024, proxy=None))
                    require(receive(host_ws, "welcome")["identity"]["id"] == host_identity["id"], "WebSocket host identity did not match cookie session")
                    peer_ws = connections.enter_context(connect(ws_root + urlencode({"ticket": peer_ticket, "room": room["id"]}),
                        origin=site_url, open_timeout=8, close_timeout=2, max_size=24 * 1024, proxy=None))
                    require(receive(peer_ws, "welcome")["identity"]["id"] == peer_identity["id"], "WebSocket peer identity did not match cookie session")

                    stage = "round-tripping signaling, input, frames, chat and result"
                    send(host_ws, {"type": "signal", "target": peer_identity["id"], "payload": {"description": {"type": "offer", "sdp": "fixture-offer"}}})
                    require(receive(peer_ws, "signal")["from"] == host_identity["id"], "Host signaling was not delivered to the right peer")
                    send(peer_ws, {"type": "signal", "target": host_identity["id"], "payload": {"description": {"type": "answer", "sdp": "fixture-answer"}}})
                    require(receive(host_ws, "signal")["payload"]["description"]["type"] == "answer", "Peer signaling answer was not delivered")
                    send(host_ws, {"type": "command", "action": "start"})
                    playing = receive(host_ws, "room", lambda value: value["room"]["status"] == "playing")["room"]
                    receive(peer_ws, "room", lambda value: value["room"]["status"] == "playing")
                    send(peer_ws, {"type": "input", "from": host_identity["id"], "input": {"x": 1, "y": 0, "kick": True}})
                    require(receive(host_ws, "input")["from"] == peer_identity["id"], "Client-supplied player ID bypassed server identity")
                    frame = {"seq": 1, "match_id": playing["match_id"], "width": 1200, "height": 700,
                        "players": [{"id": member["id"], "name": "FORGED_NAME", "team": member["team"],
                            "x": 350 if member["team"] == "red" else 850, "y": 350, "vx": 0, "vy": 0, "kicking": False}
                            for member in playing["members"] if member["team"] != "spectator"],
                        "ball": {"x": 600, "y": 350, "vx": 0, "vy": 0}, "score": {"red": 0, "blue": 0},
                        "elapsed": 0, "remaining": playing["time_limit"] * 60, "kickoff": 1, "finished": False, "winner": None}
                    send(host_ws, {"type": "frame", "frame": frame})
                    delivered = receive(peer_ws, "frame")["frame"]
                    require(delivered["match_id"] == playing["match_id"] and "FORGED_NAME" not in json.dumps(delivered),
                            "Frame relay did not validate the room roster")
                    send(peer_ws, {"type": "chat", "text": "Fixture good game"})
                    require(receive(host_ws, "chat")["message"]["text"] == "Fixture good game", "Chat did not cross the production WS tunnel")
                    send(host_ws, {"type": "result", "match_id": playing["match_id"], "red": 5, "blue": 2, "duration_seconds": 72})
                    require(receive(peer_ws, "room", lambda value: value["room"]["status"] == "finished")["room"]["score"] == {"red": 5, "blue": 2},
                            "Finished result was not published")
                    require(response_json(peer.get("/api/lumaball/matches"))["total"] == 1, "Finished result was not stored in SQLite")
                    host_ws.close()
                    require(receive(peer_ws, "closed")["reason"] == "host_left", "Creator departure did not notify the peer")

                stage = "restarting only the disposable API and verifying persistence"
                stop_child(api); api = None
                api = start_api()
                wait_healthy(site_url + "/api/health", frontend, seconds=30, log_path=folder / "frontend.log")
                restored = response_json(host.get("/api/lumaball/me"))
                require(restored["identity"]["id"] == host_identity["id"], "Guest profile did not survive API restart")
                require(restored["config"]["announcement"] == "Fixture persisted announcement", "Game settings did not survive API restart")
                results = response_json(peer.get("/api/lumaball/matches"))
                require(results["total"] == 1 and results["items"][0]["red_score"] == 5, "Match history did not survive API restart")
                require(response_json(peer.get("/api/lumaball/rooms"))["total"] == 0, "A browser-owned room incorrectly resumed after server restart")
                require(response_json(student.get("/api/auth/me"))["email"] == "stack-student@example.com", "QStudy account login did not survive API restart")
                print("PASS: production frontend/BFF, HttpOnly guests, shared accounts, room passwords, same-port WebSocket signaling/input/frame/chat/results, moderation and SQLite restart persistence.")
                return 0
            finally:
                stop_child(frontend)
                stop_child(api)
    except Exception as error:
        # Never print a WebSocket URL (it contains a one-use ticket), environment
        # values, credentials or arbitrary child logs to a shared CI log.
        reason = str(error) if isinstance(error, StackFailure) else type(error).__name__
        if isinstance(error, OSError):
            reason += f" (errno={error.errno}, winerror={getattr(error, 'winerror', None)})"
        print(f"FAIL: LumaBall disposable stack at {stage}: {reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
