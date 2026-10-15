"""Stop a proved old local QStudy stack once; Docker is never installed or started."""
import argparse
import csv
import io
import json
import ntpath
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


class MigrationError(RuntimeError):
    pass


def call(arguments, *, timeout=8, pinned=False):
    environment = dict(os.environ)
    if pinned:
        for key in ("DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            environment.pop(key, None)
    try:
        result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, env=environment, creationflags=0x08000000 if os.name == "nt" else 0)
    except (OSError, subprocess.TimeoutExpired):
        raise MigrationError("legacy_docker_unavailable") from None
    if result.returncode:
        raise MigrationError("legacy_docker_unavailable")
    return result.stdout.decode("utf-8-sig", errors="replace").strip()


def desktop_running() -> bool:
    if os.name != "nt":
        return False
    executable = str(Path(os.environ["SystemRoot"]) / "System32/tasklist.exe")
    text = call([executable, "/FO", "CSV", "/NH"], timeout=5)
    names = {row[0].casefold() for row in csv.reader(io.StringIO(text)) if row}
    return bool(names & {"com.docker.backend.exe", "docker desktop.exe", "dockerd.exe"})


def docker_path():
    found = shutil.which("docker.exe")
    if found:
        return found
    candidates = []
    for variable, suffix in (("ProgramFiles", "Docker/Docker/resources/bin/docker.exe"),
                             ("LOCALAPPDATA", "Programs/DockerDesktop/resources/bin/docker.exe")):
        if os.environ.get(variable):
            candidates.append(Path(os.environ[variable]) / suffix)
    return next((str(path) for path in candidates if path.is_file()), None)


def prove_containers(root: str, containers: list[tuple[str, dict]]) -> list[str]:
    deployment = ntpath.normcase(ntpath.abspath(ntpath.join(root, "deployment")))
    allowed = {ntpath.normcase(ntpath.join(deployment, name)) for name in ("compose.yml", "compose.http.yml")}
    result = []
    for identifier, labels in containers:
        if not re.fullmatch(r"[a-f0-9]{12,64}", identifier) or not isinstance(labels, dict):
            raise MigrationError("legacy_container_not_owned")
        if labels.get("com.docker.compose.project") != "qstudy" or labels.get("com.docker.compose.service") not in ("backend", "frontend", "caddy"):
            raise MigrationError("legacy_container_not_owned")
        directory = labels.get("com.docker.compose.project.working_dir")
        files = labels.get("com.docker.compose.project.config_files")
        if not isinstance(directory, str) or ntpath.normcase(ntpath.abspath(directory)) != deployment or not isinstance(files, str):
            raise MigrationError("legacy_container_not_owned")
        actual = {ntpath.normcase(ntpath.abspath(value.strip())) for value in files.split(",")}
        if not actual or not actual <= allowed:
            raise MigrationError("legacy_container_not_owned")
        result.append(identifier)
    return result


def stop_old_stack(root: str) -> dict:
    if not desktop_running():
        return {"ok": True, "status": "docker_not_running", "stopped": 0}
    executable = docker_path()
    if not executable:
        raise MigrationError("legacy_docker_cli_missing")
    context = call([executable, "context", "show"])
    try:
        endpoint = json.loads(call([executable, "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}", "--", context]))
    except (ValueError, TypeError):
        raise MigrationError("legacy_docker_context_invalid") from None
    if not isinstance(endpoint, str) or not re.fullmatch(r"npipe:/{2,4}\./pipe/[A-Za-z0-9][A-Za-z0-9_.-]*", endpoint):
        raise MigrationError("legacy_docker_context_not_local")
    base = [executable, "--host", endpoint]
    identifiers = call(base + ["ps", "--filter", "label=com.docker.compose.project=qstudy", "--format", "{{.ID}}"], pinned=True).splitlines()
    candidates = []
    for identifier in identifiers:
        if not re.fullmatch(r"[a-f0-9]{12,64}", identifier):
            raise MigrationError("legacy_container_not_owned")
        try:
            labels = json.loads(call(base + ["inspect", "--format", "{{json .Config.Labels}}", identifier], pinned=True))
        except (ValueError, TypeError):
            raise MigrationError("legacy_container_not_owned") from None
        candidates.append((identifier, labels))
    # Prove every candidate before issuing even the first stop. No compose
    # environment, container environment, volumes or application data are read.
    owned = prove_containers(root, candidates)
    if owned:
        call(base + ["stop", "--time", "45"] + owned, pinned=True, timeout=100)
        remaining = call(base + ["ps", "--filter", "label=com.docker.compose.project=qstudy", "--format", "{{.ID}}"], pinned=True)
        if remaining:
            raise MigrationError("legacy_docker_still_running")
    return {"ok": True, "status": "legacy_docker_stopped", "stopped": len(owned)}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    arguments = parser.parse_args(argv)
    try:
        print(json.dumps(stop_old_stack(arguments.root)))
        return 0
    except MigrationError as error:
        print(json.dumps({"ok": False, "code": str(error)}), file=sys.stderr)
        print("QStudy: прежняя контейнерная установка ещё не подтверждена как остановленная. В Docker Desktop остановите контейнеры qstudy этого проекта (либо закройте Docker Desktop), затем повторите ту же кнопку. Чужие контейнеры и данные не изменены.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
