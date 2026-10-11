#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "$(id -u)" != 0 ]]; then
    printf '%s\n' 'Run with sudo: sudo bash scripts/production/Install-Docker.sh' >&2
    exit 1
fi
if [[ ! -f /etc/os-release ]]; then
    printf '%s\n' 'Supported systems: Ubuntu 22.04, 24.04 or 26.04 LTS.' >&2
    exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != ubuntu || ! "${VERSION_ID:-}" =~ ^(22\.04|24\.04|26\.04)$ ]]; then
    printf '%s\n' 'Use Ubuntu 22.04, 24.04 or 26.04 LTS for this installer.' >&2
    exit 1
fi

apt-get update
apt-get install -y ca-certificates curl python3 git
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    systemctl enable --now docker
    docker info --format '{{.OSType}}' >/dev/null
    printf '%s\n' 'Existing Docker and Compose are ready; packages and data were preserved.'
    exit 0
fi

# Do not silently uninstall another container runtime or its existing workloads.
for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$'; then
        printf 'Conflicting package %s is installed. Review existing workloads and the official Docker installation guide before replacing it.\n' "$package" >&2
        exit 1
    fi
done

install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
task_arch="$(dpkg --print-architecture)"
task_codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
if [[ ! "$task_codename" =~ ^(jammy|noble|resolute)$ ]]; then
    printf '%s\n' 'Unexpected Ubuntu codename. No Docker repository was changed.' >&2
    exit 1
fi
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $task_codename
Components: stable
Architectures: $task_arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
chmod 0644 /etc/apt/sources.list.d/docker.sources
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker info --format '{{.OSType}}' >/dev/null
docker compose version
printf '%s\n' 'Docker is ready. Python, Node, app dependencies and OCR are installed inside the QStudy images when you run start.'
