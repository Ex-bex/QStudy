#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
task_config="$task_root/scripts/production/configure.py"
task_compose_file="$task_root/deployment/compose.yml"
task_env_file="$task_root/deployment/.env"

help() {
    cat <<'EOF'
QStudy production management (Linux home server or VPS)
  sudo bash scripts/production/Manage-QStudy.sh init DOMAIN CONTACT_EMAIL
  sudo bash scripts/production/Manage-QStudy.sh check [--offline]
  sudo bash scripts/production/Manage-QStudy.sh permissions
  sudo bash scripts/production/Manage-QStudy.sh start
  sudo bash scripts/production/Manage-QStudy.sh update
  sudo bash scripts/production/Manage-QStudy.sh stop
  sudo bash scripts/production/Manage-QStudy.sh status
  sudo bash scripts/production/Manage-QStudy.sh admin EMAIL [--name NAME]
  sudo bash scripts/production/Manage-QStudy.sh mail-check
  sudo bash scripts/production/Manage-QStudy.sh backup
  sudo bash scripts/production/Manage-QStudy.sh verify BACKUP_BASENAME
  sudo bash scripts/production/Manage-QStudy.sh restore BACKUP_BASENAME
Edit deployment/.env privately before start. Set DNS to the server and allow
incoming TCP 80/443 (UDP 443 optional). This script never opens your firewall.
Backend port 8000 and frontend port 3000 are private container ports.
EOF
}

if [[ "${1:-}" == help || "${1:-}" == --help || -z "${1:-}" ]]; then
    help
    exit 0
fi
if [[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]]; then
    printf '%s\n' 'Run the production manager on the Linux server with sudo.' >&2
    exit 1
fi
command -v python3 >/dev/null || { printf '%s\n' 'Install Python with Install-Docker.sh first.' >&2; exit 1; }
task_action="$1"
shift
compose() {
    env -u PUBLIC_BASE_URL -u SECRET_KEY -u BFF_PROXY_SECRET -u QSTUDY_DOMAIN -u ACME_EMAIL -u RECOVERY_DELIVERY \
        docker compose --project-name qstudy --project-directory "$task_root/deployment" --env-file "$task_env_file" -f "$task_compose_file" "$@"
}
docker_ready() {
    command -v docker >/dev/null || { printf '%s\n' 'Run Install-Docker.sh first.' >&2; exit 1; }
    docker compose version >/dev/null
    docker info --format '{{.OSType}}' >/dev/null
    # Never print the resolved Compose configuration: it contains secrets.
    compose config --quiet
}

case "$task_action" in
    init)
        [[ "$#" == 2 ]] || { help; exit 1; }
        python3 "$task_config" init "$@"
        python3 "$task_config" permissions
        printf '%s\n' 'Next: privately edit deployment/.env, then run check and start.'
        ;;
    permissions)
        [[ "$#" == 0 ]] || { help; exit 1; }
        python3 "$task_config" permissions
        ;;
    check)
        python3 "$task_config" check "$@"
        docker_ready
        printf '%s\n' 'Compose configuration is valid. A build and public HTTPS probe are still required.'
        ;;
    start|update)
        [[ "$#" == 0 ]] || { help; exit 1; }
        python3 "$task_config" permissions
        python3 "$task_config" check
        docker_ready
        if [[ "$task_action" == update ]] && compose ps --status running --services | grep -qx backend; then
            compose exec -T backend python production_runtime.py backup
        fi
        # Build before replacing running containers; do not delete any volumes.
        compose build --pull
        compose pull caddy
        compose run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
        compose up -d --wait --wait-timeout 600 backend
        compose exec -T backend python production_runtime.py mail-check-if-enabled
        compose up -d --wait --wait-timeout 600
        task_verified=false
        for task_attempt in $(seq 1 12); do
            if python3 "$task_config" probe; then
                task_verified=true
                break
            fi
            printf '%s\n' 'Waiting for DNS/automatic HTTPS. Check that ports 80/443 reach this server.'
            sleep 10
        done
        if [[ "$task_verified" != true ]]; then
            printf '%s\n' 'Containers started, but the public HTTPS check failed. Verify DNS, server ports and Caddy status; publication is not yet verified.' >&2
            exit 1
        fi
        ;;
    stop|status)
        [[ "$#" == 0 ]] || { help; exit 1; }
        python3 "$task_config" check --offline
        docker_ready
        if [[ "$task_action" == stop ]]; then compose stop caddy frontend backend; else compose ps; fi
        ;;
    admin)
        [[ "$#" -ge 1 && "$1" != -* ]] || { help; exit 1; }
        python3 "$task_config" check --offline
        docker_ready
        # getpass inside the application never echoes or saves the typed password.
        compose exec backend python -m app.bootstrap_admin "$@"
        ;;
    backup|verify|mail-check)
        if [[ "$task_action" == verify ]]; then
            [[ "$#" == 1 ]] || { help; exit 1; }
        else
            [[ "$#" == 0 ]] || { help; exit 1; }
        fi
        python3 "$task_config" check --offline
        docker_ready
        compose exec -T backend python production_runtime.py "$task_action" "$@"
        ;;
    restore)
        [[ "$#" == 1 ]] || { help; exit 1; }
        python3 "$task_config" check --offline
        docker_ready
        # Validate with the existing backend before interrupting the site.
        if compose ps --status running --services | grep -qx backend; then
            compose exec -T backend python production_runtime.py verify "$1"
        fi
        compose stop caddy frontend backend
        python3 "$task_config" permissions
        if ! compose run --rm --no-deps -T backend python production_runtime.py restore "$1" --stopped; then
            printf '%s\n' 'Restore failed. Services remain stopped; the previous database and uploads were preserved or rolled back. Check the archive before starting again.' >&2
            exit 1
        fi
        compose up -d --wait --wait-timeout 600
        python3 "$task_config" probe
        ;;
    *)
        help
        exit 1
        ;;
esac
