#!/usr/bin/env bash
set -euo pipefail

APP_ENV_FILE="${APP_ENV_FILE:-/root/security-marketplace/security-backend-nest/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/security-marketplace}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
IMAGE="${POSTGRES_TOOLS_IMAGE:-postgres:16-alpine}"

if [[ ! -f "$APP_ENV_FILE" ]]; then
  echo "Missing env file: $APP_ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$APP_ENV_FILE"
set +a

: "${DATABASE_URL:?DATABASE_URL must be present in $APP_ENV_FILE}"

timestamp="$(date +%Y-%m-%d_%H-%M-%S)"
mkdir -p "$BACKUP_DIR"

backup_file="$BACKUP_DIR/security-marketplace_${timestamp}.dump"
latest_file="$BACKUP_DIR/latest.dump"

if command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file "$backup_file"
else
  docker run --rm \
    -e DATABASE_URL="$DATABASE_URL" \
    "$IMAGE" \
    sh -lc 'pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges' > "$backup_file"
fi

ln -sfn "$backup_file" "$latest_file"
find "$BACKUP_DIR" -type f -name 'security-marketplace_*.dump' -mtime +"$RETENTION_DAYS" -delete

echo "Backup written to $backup_file"
