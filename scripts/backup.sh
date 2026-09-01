#!/usr/bin/env bash
set -euo pipefail

# IGTrack backup — daily pg_dump, 14-day retention, SHA-256 checksum
# Usage: ./scripts/backup.sh
# Env: DATABASE_URL or POSTGRES_PASSWORD + POSTGRES_PORT (for prod compose)
#      BACKUP_DIR (default ./backups)
# Exit 0 on success, non-zero on failure (does NOT delete old backups on failure)

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
FILE="igtrack_${TIMESTAMP}.sql"
GZ="${FILE}.gz"
LOG="${BACKUP_DIR}/backup.log"

mkdir -p "${BACKUP_DIR}"

# Resolve pg_dump target — prefer container (portable, no host pg_dump needed), fallback to host pg_dump
if docker ps --format '{{.Names}}' | grep -q '^igtrack-db$'; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup start container igtrack-db" | tee -a "${LOG}"
  if ! docker exec igtrack-db pg_dump -U igtrack -d igtrack --no-owner --no-privileges -F p > "${BACKUP_DIR}/${FILE}"; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup FAILED container pg_dump" | tee -a "${LOG}"
    exit 1
  fi
elif docker ps --format '{{.Names}}' | grep -q '^igtrack-db-prod$'; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup start container igtrack-db-prod" | tee -a "${LOG}"
  if ! docker exec igtrack-db-prod pg_dump -U igtrack -d igtrack --no-owner --no-privileges -F p > "${BACKUP_DIR}/${FILE}"; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup FAILED container pg_dump prod" | tee -a "${LOG}"
    exit 1
  fi
elif [[ -n "${DATABASE_URL:-}" ]] && command -v pg_dump >/dev/null 2>&1; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup start DATABASE_URL via pg_dump" | tee -a "${LOG}"
  if ! pg_dump "${DATABASE_URL}" --no-owner --no-privileges -F p -f "${BACKUP_DIR}/${FILE}"; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup FAILED pg_dump" | tee -a "${LOG}"
    exit 1
  fi
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup FAILED no igtrack-db container and no pg_dump" | tee -a "${LOG}"
  exit 1
fi

SIZE="$(wc -c < "${BACKUP_DIR}/${FILE}" | tr -d ' ')"
gzip -f "${BACKUP_DIR}/${FILE}"
GZ_SIZE="$(wc -c < "${BACKUP_DIR}/${GZ}" | tr -d ' ')"
if command -v sha256sum >/dev/null 2>&1; then
  SUM="$(sha256sum "${BACKUP_DIR}/${GZ}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  SUM="$(shasum -a 256 "${BACKUP_DIR}/${GZ}" | awk '{print $1}')"
else
  SUM="no-sha256"
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup success ${GZ} size=${GZ_SIZE} (raw ${SIZE}) sha256=${SUM}" | tee -a "${LOG}"

# Retention: keep 14 daily files (mtime +14)
if ! find "${BACKUP_DIR}" -type f -name "igtrack_*.sql.gz" -mtime +14 -print -delete | tee -a "${LOG}"; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] retention prune warning" | tee -a "${LOG}"
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup complete retention 14d enforced" | tee -a "${LOG}"
