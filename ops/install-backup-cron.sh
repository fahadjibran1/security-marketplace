#!/usr/bin/env bash
set -euo pipefail

BACKUP_SCRIPT_PATH="${BACKUP_SCRIPT_PATH:-/usr/local/bin/security-marketplace-backup}"
APP_ENV_FILE="${APP_ENV_FILE:-/root/security-marketplace/security-backend-nest/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/security-marketplace}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LOG_FILE="${LOG_FILE:-/var/log/security-marketplace-backup.log}"
CRON_SCHEDULE="${CRON_SCHEDULE:-30 2 * * *}"

cat > "$BACKUP_SCRIPT_PATH" <<EOF
#!/usr/bin/env bash
APP_ENV_FILE="$APP_ENV_FILE" BACKUP_DIR="$BACKUP_DIR" RETENTION_DAYS="$RETENTION_DAYS" /usr/local/bin/backup-postgres.sh
EOF

chmod +x "$BACKUP_SCRIPT_PATH"

current_crontab="$(mktemp)"
crontab -l > "$current_crontab" 2>/dev/null || true
grep -v "$BACKUP_SCRIPT_PATH" "$current_crontab" > "${current_crontab}.next" || true
echo "$CRON_SCHEDULE $BACKUP_SCRIPT_PATH >> $LOG_FILE 2>&1" >> "${current_crontab}.next"
crontab "${current_crontab}.next"
rm -f "$current_crontab" "${current_crontab}.next"

echo "Installed cron job: $CRON_SCHEDULE"
