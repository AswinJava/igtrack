#!/usr/bin/env bash
set -euo pipefail

# IGTrack cloud backup — Neon → gzip → SHA-256 → Cloudflare R2
# Usage: DATABASE_URL=... R2_BUCKET=... R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... ./scripts/backup-cloud.sh
# No secrets printed; DATABASE_URL and R2 keys are masked in logs.

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
YEAR="$(date -u +%Y)"; MONTH="$(date -u +%m)"; DAY="$(date -u +%d)"; HM="$(date -u +%H%M%S)"
FILE="igtrack_${TIMESTAMP}.sql"
GZ="${FILE}.gz"
KEY="igtrack/${YEAR}/${MONTH}/${DAY}/${HM}.sql.gz"
LOG="${BACKUP_DIR}/backup.log"

if [[ -z "${DATABASE_URL:-}" ]]; then echo "DATABASE_URL required" >&2; exit 2; fi
if [[ -z "${R2_BUCKET:-}" ]]; then echo "R2_BUCKET required (Cloudflare R2 bucket)" >&2; exit 2; fi
if [[ -z "${R2_ENDPOINT:-}" ]]; then echo "R2_ENDPOINT required (e.g. https://<account>.r2.cloudflarestorage.com)" >&2; exit 2; fi
if [[ -z "${R2_ACCESS_KEY_ID:-}" || -z "${R2_SECRET_ACCESS_KEY:-}" ]]; then echo "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY required" >&2; exit 2; fi

mkdir -p "${BACKUP_DIR}"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup-cloud start DATABASE_URL=*** R2_BUCKET=${R2_BUCKET} R2_ENDPOINT=${R2_ENDPOINT} KEY=${KEY}" | tee -a "${LOG}"

# pg_dump via container if local, else host pg_dump
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^igtrack-db$'; then
  docker exec igtrack-db pg_dump -U igtrack -d igtrack --no-owner --no-privileges -F p > "${BACKUP_DIR}/${FILE}"
elif command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DATABASE_URL" --no-owner --no-privileges -F p -f "${BACKUP_DIR}/${FILE}"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup-cloud FAILED no docker and no pg_dump" | tee -a "${LOG}"
  exit 1
fi

gzip -f "${BACKUP_DIR}/${FILE}"
if command -v sha256sum >/dev/null 2>&1; then SUM="$(sha256sum "${BACKUP_DIR}/${GZ}" | awk '{print $1}')"; else SUM="$(shasum -a 256 "${BACKUP_DIR}/${GZ}" | awk '{print $1}')"; fi
SIZE="$(wc -c < "${BACKUP_DIR}/${GZ}" | tr -d ' ')"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup-cloud gzip done size=${SIZE} sha256=${SUM} file=${GZ}" | tee -a "${LOG}"
echo -n "${SUM}  ${KEY}" > "${BACKUP_DIR}/${GZ}.sha256"

# Upload to R2 via aws cli (S3-compatible)
# Use --checksum-algorithm if available, fallback plain
export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
# R2 endpoint is like https://<accountId>.r2.cloudflarestorage.com
if ! command -v aws >/dev/null 2>&1; then pip install -q awscli >/dev/null 2>&1 || true; fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] uploading to R2 s3://${R2_BUCKET}/${KEY}" | tee -a "${LOG}"
# Do not echo keys; aws cli reads from env
if aws s3 cp "${BACKUP_DIR}/${GZ}" "s3://${R2_BUCKET}/${KEY}" --endpoint-url "${R2_ENDPOINT}" 2>&1 | sed -E 's/(AWS_SECRET_ACCESS_KEY|DATABASE_URL)=[^ ]*/\1=***/g' | tee -a "${LOG}"; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] R2 upload success ${KEY}" | tee -a "${LOG}"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] R2 upload FAILED ${KEY}" | tee -a "${LOG}"
  exit 1
fi
aws s3 cp "${BACKUP_DIR}/${GZ}.sha256" "s3://${R2_BUCKET}/${KEY}.sha256" --endpoint-url "${R2_ENDPOINT}" 2>&1 | sed -E 's/(AWS_SECRET_ACCESS_KEY|DATABASE_URL)=[^ ]*/\1=***/g' | tee -a "${LOG}" || true

# Retention on R2: keep 14 days — delete objects older than 14 days.
# Keys embed UTC date (igtrack/YYYY/MM/DD/HHMMSS.sql.gz) so lexical comparison
# against the cutoff is a date comparison. Runs only after a successful upload,
# so a failed backup never destroys the previous valid backup. Best-effort:
# failures here do not fail the backup.
KEEP_DAYS=14
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] R2 retention check (keep ${KEEP_DAYS}d, delete only after successful upload)" | tee -a "${LOG}"
CUTOFF="$(date -u -d '14 days ago' +%Y/%m/%d 2>/dev/null || date -u -v-14d +%Y/%m/%d || echo '')"
if [[ -n "${CUTOFF}" ]]; then
  aws s3 ls "s3://${R2_BUCKET}/igtrack/" --endpoint-url "${R2_ENDPOINT}" --recursive 2>/dev/null | awk '{print $4}' | grep -E '^igtrack/[0-9]{4}/[0-9]{2}/[0-9]{2}/' | while read -r key; do
    keydate="$(echo "$key" | grep -oE '[0-9]{4}/[0-9]{2}/[0-9]{2}' | head -1)"
    if [[ -n "$keydate" && "$keydate" < "$CUTOFF" ]]; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] deleting expired R2 object: $key" | tee -a "${LOG}"
      aws s3 rm "s3://${R2_BUCKET}/${key}" --endpoint-url "${R2_ENDPOINT}" >> "${LOG}" 2>&1 || echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WARN: failed to delete $key" | tee -a "${LOG}"
    fi
  done || true
else
  aws s3 ls "s3://${R2_BUCKET}/igtrack/" --endpoint-url "${R2_ENDPOINT}" --recursive 2>&1 | while read -r line; do echo "$line" | tee -a "${LOG}"; done || true
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup-cloud complete KEY=${KEY} sha256=${SUM}" | tee -a "${LOG}"
# Also keep local copy for 14d (same as VPS script)
find "${BACKUP_DIR}" -type f -name "igtrack_*.sql.gz" -mtime +14 -print -delete 2>&1 | tee -a "${LOG}" || true
find "${BACKUP_DIR}" -type f -name "igtrack_*.sql.gz.sha256" -mtime +14 -print -delete 2>&1 | tee -a "${LOG}" || true
