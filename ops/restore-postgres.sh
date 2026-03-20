#!/usr/bin/env bash
set -euo pipefail

APP_ENV_FILE="${APP_ENV_FILE:-/root/security-marketplace/security-backend-nest/.env}"
IMAGE="${POSTGRES_TOOLS_IMAGE:-postgres:17-alpine}"
BACKUP_FILE="${1:-}"

if [[ -z "$BACKUP_FILE" ]]; then
  echo "Usage: $0 /path/to/backup.dump" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if [[ ! -f "$APP_ENV_FILE" ]]; then
  echo "Missing env file: $APP_ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$APP_ENV_FILE"
set +a

: "${DATABASE_URL:?DATABASE_URL must be present in $APP_ENV_FILE}"

if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" "$BACKUP_FILE"
else
  backup_dir="$(dirname "$BACKUP_FILE")"
  backup_name="$(basename "$BACKUP_FILE")"
  docker run --rm -i \
    -e DATABASE_URL="$DATABASE_URL" \
    -v "$backup_dir:/backup" \
    "$IMAGE" \
    pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" "/backup/$backup_name"
fi

echo "Restore completed from $BACKUP_FILE"
