"""Production configuration preflight; never print credentials or dotenv contents."""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import sys
import urllib.parse
import urllib.request


class ConfigurationError(ValueError):
    pass


def deployment_directory() -> Path:
    return Path(__file__).resolve().parents[2] / "deployment"


def safe_path(base: Path, relative: str) -> Path:
    if base.is_symlink() or (hasattr(base, "is_junction") and base.is_junction()):
        raise ConfigurationError("Production storage must not contain filesystem links.")
    base = base.resolve()
    candidate = base / relative
    if not candidate.resolve().is_relative_to(base):
        raise ConfigurationError("Production paths must remain inside deployment/.")
    current = base
    for part in Path(relative).parts:
        current /= part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ConfigurationError("Production storage must not contain filesystem links.")
    return candidate


def normalized_domain(value: str) -> str:
    try:
        value = value.strip().rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise ConfigurationError("Use a valid DNS domain, without https:// or a path.") from error
    labels = value.split(".")
    label_pattern = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
    if len(value) > 253 or len(labels) < 2 or any(not label_pattern.fullmatch(label) for label in labels) or labels[-1].isdigit():
        raise ConfigurationError("Use a valid DNS domain, without https:// or a path.")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ConfigurationError("Automatic public HTTPS requires a DNS domain, rather than an IP address.")


def normalized_public_ipv4(value: str) -> str:
    try:
        address = ipaddress.IPv4Address(value)
    except (ipaddress.AddressValueError, TypeError) as error:
        raise ConfigurationError("Use one canonical public IPv4 address, without a URL, port or path.") from error
    if (str(address) != value or not address.is_global or address.is_multicast or address.is_reserved
            or address in ipaddress.IPv4Network("192.88.99.0/24")):
        raise ConfigurationError("HTTP hosting requires a canonical public IPv4; private, CGNAT and reserved addresses are unsupported.")
    return str(address)


def normalized_http_port(value: str | int) -> int:
    text = str(value)
    if not re.fullmatch(r"[0-9]{1,5}", text) or not 1 <= int(text) <= 65535 or text != str(int(text)):
        raise ConfigurationError("Use an HTTP port from 1 through 65535, without spaces or leading zeroes.")
    return int(text)


def create_environment(base: Path, replacements: dict[str, str]) -> dict:
    path = safe_path(base, ".env")
    template = (base / ".env.example").read_text(encoding="utf-8")
    for key, value in replacements.items():
        template, count = re.subn(r"^" + re.escape(key) + r"=.*$", lambda _: key + "='" + value + "'", template, flags=re.MULTILINE)
        if count != 1:
            raise ConfigurationError("Production configuration template is incomplete.")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as target:
        target.write(template)
        target.flush()
        os.fsync(target.fileno())
    for relative in ("data/backend/uploads", "data/backups"):
        safe_path(base, relative).mkdir(parents=True, exist_ok=True)
    return {"status": "created", "configuration": "deployment/.env", "credentials_printed": False}


def read_environment(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*", line)
        if not match:
            raise ConfigurationError("Malformed deployment/.env. Use one KEY='value' setting per line.")
        key, value = match.groups()
        if key in values:
            raise ConfigurationError("Duplicate settings in deployment/.env.")
        if value.startswith("'"):
            quoted = re.fullmatch(r"'([^']*)'\s*(?:#.*)?", value)
            if not quoted or quoted.group(1).endswith("\\"):
                raise ConfigurationError("Use simple single-quoted values without embedded apostrophes or a final backslash in deployment/.env.")
            value = quoted.group(1)
        elif value.startswith('"'):
            quoted = re.fullmatch(r'"([^"\\]*)"\s*(?:#.*)?', value)
            if not quoted:
                raise ConfigurationError("Double-quoted values with escapes are unsupported. Use simple single-quoted values in deployment/.env.")
            value = quoted.group(1)
            if "$" in value:
                raise ConfigurationError("Single-quote values containing $ so Docker Compose preserves their literal value.")
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
            if any(character in value for character in ("$", "\\", "'", '"')):
                raise ConfigurationError("Single-quote values containing $, quotes or backslashes in deployment/.env.")
        if any(character in value for character in ("\r", "\n", "\x00")):
            raise ConfigurationError("Environment settings must not contain control characters.")
        values[key] = value
    return values


def initialize(base: Path, domain: str, email: str) -> dict:
    domain = normalized_domain(domain)
    if not re.fullmatch(r"[^\s@'<>]+@[^\s@'<>]+\.[^\s@'<>]+", email):
        raise ConfigurationError("Supply a certificate contact email as the second init argument.")
    path = safe_path(base, ".env")
    base.mkdir(parents=True, exist_ok=True)
    if path.exists():
        existing = read_environment(path)
        if existing.get("QSTUDY_HOST_MODE", "https") != "https" or existing.get("QSTUDY_DOMAIN") != domain:
            raise ConfigurationError("An existing deployment/.env was preserved. Edit its domain settings explicitly.")
        for relative in ("data/backend/uploads", "data/backups"):
            safe_path(base, relative).mkdir(parents=True, exist_ok=True)
        return {"status": "preserved", "configuration": "deployment/.env", "secrets_overwritten": False}
    replacements = {"QSTUDY_DOMAIN": domain, "ACME_EMAIL": email,
                    "QSTUDY_HOST_MODE": "https", "ALLOW_PUBLIC_HTTP": "false",
                    "PUBLIC_BASE_URL": "https://" + domain,
                    "SECRET_KEY": secrets.token_hex(32), "BFF_PROXY_SECRET": secrets.token_hex(32)}
    return create_environment(base, replacements)


def initialize_http(base: Path, public_ip: str, port: str | int = 8080) -> dict:
    public_ip = normalized_public_ipv4(public_ip)
    port = normalized_http_port(port)
    origin = f"http://{public_ip}:{port}"
    path = safe_path(base, ".env")
    base.mkdir(parents=True, exist_ok=True)
    if path.exists():
        existing = read_environment(path)
        if (existing.get("QSTUDY_HOST_MODE", "https") != "http"
                or existing.get("QSTUDY_PUBLIC_IP") != public_ip
                or existing.get("QSTUDY_HTTP_PORT") != str(port)
                or existing.get("PUBLIC_BASE_URL") != origin):
            raise ConfigurationError("An existing deployment/.env was preserved. HTTP init cannot change its host mode, IP, port or public origin.")
        for relative in ("data/backend/uploads", "data/backups"):
            safe_path(base, relative).mkdir(parents=True, exist_ok=True)
        return {"status": "preserved", "configuration": "deployment/.env", "secrets_overwritten": False}
    return create_environment(base, {
        "QSTUDY_HOST_MODE": "http", "QSTUDY_PUBLIC_IP": public_ip,
        "QSTUDY_HTTP_PORT": str(port), "ALLOW_PUBLIC_HTTP": "true", "PUBLIC_BASE_URL": origin,
        "SECRET_KEY": secrets.token_hex(32), "BFF_PROXY_SECRET": secrets.token_hex(32),
    })


def check(base: Path, offline: bool = False) -> dict:
    path = safe_path(base, ".env")
    if not path.is_file():
        raise ConfigurationError("Initialize HTTPS with init DOMAIN CONTACT_EMAIL or HTTP with init-http PUBLIC_IP PORT first.")
    if os.name != "nt" and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ConfigurationError("deployment/.env must be private: chmod 600 deployment/.env.")
    values = read_environment(path)
    mode = values.get("QSTUDY_HOST_MODE", "https")
    public_ip = ""
    if mode == "http":
        public_ip = normalized_public_ipv4(values.get("QSTUDY_PUBLIC_IP", ""))
        public_port = normalized_http_port(values.get("QSTUDY_HTTP_PORT", ""))
        origin = f"http://{public_ip}:{public_port}"
        if values.get("ALLOW_PUBLIC_HTTP") != "true":
            raise ConfigurationError("HTTP mode requires explicit ALLOW_PUBLIC_HTTP='true'.")
        if values.get("PUBLIC_BASE_URL") != origin:
            raise ConfigurationError("HTTP PUBLIC_BASE_URL must exactly equal http:// followed by the configured public IPv4 and :port, without a trailing slash.")
        if not values.get("QSTUDY_DOMAIN", "").strip() or not values.get("ACME_EMAIL", "").strip():
            raise ConfigurationError("HTTP mode needs the unused QSTUDY_DOMAIN and ACME_EMAIL template placeholders for base Compose interpolation; no real domain or certificate email is needed.")
    elif mode == "https":
        domain = normalized_domain(values.get("QSTUDY_DOMAIN", ""))
        public_port = 443
        origin = "https://" + domain
        if values.get("ALLOW_PUBLIC_HTTP", "false") != "false":
            raise ConfigurationError("HTTPS mode must keep ALLOW_PUBLIC_HTTP='false'.")
        if values.get("PUBLIC_BASE_URL") != origin:
            raise ConfigurationError("PUBLIC_BASE_URL must equal https:// followed by QSTUDY_DOMAIN, without a trailing slash.")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", values.get("ACME_EMAIL", "")):
            raise ConfigurationError("Set ACME_EMAIL for certificate notifications.")
    else:
        raise ConfigurationError("QSTUDY_HOST_MODE must be 'https' or explicit 'http'.")
    for key in ("SECRET_KEY", "BFF_PROXY_SECRET"):
        secret = values.get(key, "")
        if len(secret) < 32 or secret.lower().startswith(("change", "replace", "your_")):
            raise ConfigurationError("Generate both private application and proxy secrets with init.")
    if values["SECRET_KEY"] == values["BFF_PROXY_SECRET"]:
        raise ConfigurationError("Application and proxy secrets must be distinct.")
    recovery = values.get("RECOVERY_DELIVERY", "disabled")
    if recovery not in ("disabled", "smtp"):
        raise ConfigurationError("Public hosts require RECOVERY_DELIVERY='smtp' or 'disabled'; local recovery is unsupported.")
    if recovery == "smtp" and any(not values.get(key, "").strip() for key in ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM")):
        raise ConfigurationError("Complete the SMTP settings, or disable recovery until they are ready.")
    for relative in ("data/backend", "data/backend/uploads", "data/backups"):
        directory = safe_path(base, relative)
        if not directory.is_dir():
            raise ConfigurationError("Persistent data folders are missing; run init again and permissions.")
    if not offline and mode == "https":
        try:
            addresses = socket.getaddrinfo(domain, 443, type=socket.SOCK_STREAM)
        except socket.gaierror as error:
            raise ConfigurationError("The domain does not resolve. Create its DNS A/AAAA records first.") from error
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ConfigurationError("The production domain must resolve to public server addresses.")
    return {"status": "configuration_valid", "host_mode": mode, "public_url": origin,
            "compose_file": "compose.http.yml" if mode == "http" else "compose.yml",
            "public_port": public_port, "public_ip": public_ip,
            "dns_checked": not offline and mode == "https", "mail_enabled": recovery == "smtp"}


def permissions(base: Path) -> dict:
    if os.name == "nt" or os.geteuid() != 0:
        raise ConfigurationError("Run production permissions on Linux with sudo.")
    paths = []
    for relative in ("data/backend", "data/backups"):
        directory = safe_path(base, relative)
        directory.mkdir(parents=True, exist_ok=True)
        paths.append(directory)
        for current, folders, filenames in os.walk(directory, followlinks=False):
            for name in folders + filenames:
                path = Path(current) / name
                mode = path.lstat().st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                    raise ConfigurationError("Production storage contains a filesystem link or non-regular file.")
                paths.append(path)
    for path in paths:
        os.chown(path, 10001, 10001, follow_symlinks=False)
        os.chmod(path, 0o700 if path.is_dir() else 0o600, follow_symlinks=False)
    os.chmod(safe_path(base, ".env"), 0o600)
    os.chmod(safe_path(base, "data"), 0o700)
    return {"status": "permissions_ready", "backend_uid": 10001, "backend_gid": 10001}


class ProbeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # Never follow another site or print an untrusted Location header.
        raise ConfigurationError("The public site probe refused a redirect. Check the configured address and proxy.")


def assert_probe_origin(response_url: str, origin: str) -> None:
    try:
        actual = urllib.parse.urlsplit(response_url)
        expected = urllib.parse.urlsplit(origin)
        default_ports = {"https": 443, "http": 80}
        actual_port = default_ports.get(actual.scheme) if actual.port is None else actual.port
        expected_port = default_ports.get(expected.scheme) if expected.port is None else expected.port
        same_origin = (
            response_url == response_url.strip()
            and actual.username is None and actual.password is None
            and expected.scheme in default_ports and actual.scheme == expected.scheme
            and actual.hostname == expected.hostname and actual_port == expected_port
        )
    except (TypeError, ValueError):
        same_origin = False
    if not same_origin:
        raise ConfigurationError("The public site probe received a response from another origin.")


def probe(base: Path, local: bool = False) -> dict:
    # Validate secrets, recovery mode, storage and the exact public URL before
    # any requests. This probe verifies access from this host, not another network.
    configuration = check(base, offline=True)
    origin = configuration["public_url"]
    if local and configuration["host_mode"] != "http":
        raise ConfigurationError("The local probe is available only for explicit public IPv4 HTTP hosting.")
    connection_origin = f"http://127.0.0.1:{configuration['public_port']}" if local else origin
    handlers = [urllib.request.ProxyHandler({}), ProbeRedirectHandler()] if local else [ProbeRedirectHandler()]
    opener = urllib.request.build_opener(*handlers)

    def open_response(path: str):
        # Connect directly to the published local port while preserving Caddy's
        # exact public Host check. This must not depend on router NAT loopback
        # or pass through a system HTTP proxy.
        request = (urllib.request.Request(connection_origin + path, headers={"Host": urllib.parse.urlsplit(origin).netloc})
                   if local else connection_origin + path)
        return opener.open(request, timeout=25)

    with open_response("/api/health") as response:
        assert_probe_origin(response.geturl(), connection_origin)
        try:
            health = json.loads(response.read(10_000))
        except (ValueError, UnicodeError) as error:
            raise ConfigurationError("The public API health response is not valid QStudy JSON.") from error
        if response.status != 200 or not isinstance(health, dict) or health.get("status") != "ok" or health.get("service") != "QStudy":
            raise ConfigurationError("The public API health response is not QStudy.")
    with open_response("/") as response:
        assert_probe_origin(response.geturl(), connection_origin)
        if response.status != 200:
            raise ConfigurationError("The public homepage is unavailable.")
        if configuration["host_mode"] == "https":
            hsts = re.search(r"(?:^|;)\s*max-age\s*=\s*(\d+)\s*(?:;|$)", response.headers.get("Strict-Transport-Security", ""), re.IGNORECASE)
            if not hsts or int(hsts.group(1)) <= 0:
                raise ConfigurationError("The public proxy is missing a valid HTTPS security header.")
    if local:
        return {"status": "local_http_verified", "public_url": origin, "host_mode": "http",
                "verified_locally": True, "external_reachability_proven": False}
    return {"status": "public_" + configuration["host_mode"] + "_verified", "public_url": origin,
            "host_mode": configuration["host_mode"],
            "verified_from_this_host": True, "external_reachability_proven": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    init = subparsers.add_parser("init")
    init.add_argument("domain")
    init.add_argument("email")
    init_http = subparsers.add_parser("init-http")
    init_http.add_argument("public_ip")
    init_http.add_argument("port", nargs="?", default="8080")
    validation = subparsers.add_parser("check")
    validation.add_argument("--offline", action="store_true")
    subparsers.add_parser("permissions")
    verification = subparsers.add_parser("probe")
    verification.add_argument("--local", action="store_true", help="Verify the HTTP port locally with its configured public Host, without requiring router NAT loopback.")
    arguments = parser.parse_args()
    base = deployment_directory()
    try:
        if arguments.command == "init":
            result = initialize(base, arguments.domain, arguments.email)
        elif arguments.command == "init-http":
            result = initialize_http(base, arguments.public_ip, arguments.port)
        elif arguments.command == "check":
            result = check(base, arguments.offline)
        elif arguments.command == "permissions":
            result = permissions(base)
        else:
            result = probe(base, local=arguments.local)
    except ConfigurationError as error:
        print("QStudy: " + str(error), file=sys.stderr)
        return 1
    except Exception as error:
        print("QStudy production preflight failed (" + type(error).__name__ + "). Check file access, network and the public address. Credentials were not printed.", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
