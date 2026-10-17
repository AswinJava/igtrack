#!/usr/bin/env bash
set -euo pipefail

# IGTrack restore — isolated test, never destroys prod DB
# Usage: ./scripts/restore.sh ./backups/igtrack_YYYY-MM-DD.sql.gz [restore_db_name]
# Restores into a temporary database on the SAME Postgres instance and verifies.

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <backup.sql.gz> [restore_db_name]" >&2
  exit 2
fi
BACKUP="$1"
RESTORE_DB="${2:-igtrack_restore_$(date -u +%Y%m%d%H%M%S)}"

if [[ ! -f "${BACKUP}" ]]; then
  echo "backup not found: ${BACKUP}" >&2
  exit 1
fi

# Resolve psql target
if docker ps --format '{{.Names}}' | grep -q '^igtrack-db$'; then
  CONTAINER="igtrack-db"
elif docker ps --format '{{.Names}}' | grep -q '^igtrack-db-prod$'; then
  CONTAINER="igtrack-db-prod"
else
  echo "no igtrack-db container found" >&2
  exit 1
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] restore start backup=${BACKUP} -> db=${RESTORE_DB} container=${CONTAINER}"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${BACKUP}" || true
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "${BACKUP}" || true
fi

# Create restore DB
docker exec "${CONTAINER}" psql -U igtrack -d postgres -c "CREATE DATABASE \"${RESTORE_DB}\";"

# Restore (handle both gz and plain sql)
if [[ "${BACKUP}" == *.gz ]]; then
  gzip -dc "${BACKUP}" | docker exec -i "${CONTAINER}" psql -U igtrack -d "${RESTORE_DB}" -v ON_ERROR_STOP=1
else
  cat "${BACKUP}" | docker exec -i "${CONTAINER}" psql -U igtrack -d "${RESTORE_DB}" -v ON_ERROR_STOP=1
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] restore data loaded, verifying..."

# Verify expected tables exist
for tbl in users targets ig_accounts profile_snapshots follow_snapshots follow_snapshot_members evidence stories story_mentions monitoring_jobs scheduler_state; do
  docker exec "${CONTAINER}" psql -U igtrack -d "${RESTORE_DB}" -c "SELECT count(*) FROM ${tbl};" >/dev/null
  echo "  table ${tbl} ok"
done

# Row-count verification (sample — operator can extend)
echo "--- row counts ---"
docker exec "${CONTAINER}" psql -U igtrack -d "${RESTORE_DB}" -c "
SELECT 'users' as tbl, count(*) FROM users
UNION ALL SELECT 'targets', count(*) FROM targets
UNION ALL SELECT 'ig_accounts', count(*) FROM ig_accounts
UNION ALL SELECT 'evidence', count(*) FROM evidence
UNION ALL SELECT 'follow_snapshots', count(*) FROM follow_snapshots
UNION ALL SELECT 'follow_snapshot_members', count(*) FROM follow_snapshot_members
UNION ALL SELECT 'stories', count(*) FROM stories
UNION ALL SELECT 'monitoring_jobs', count(*) FROM monitoring_jobs
ORDER BY tbl;"

# Integrity: evidence FKs should be intact (no orphan follow_snapshots)
docker exec "${CONTAINER}" psql -U igtrack -d "${RESTORE_DB}" -c "
SELECT 'orphan_follow_snapshots' as check, count(*) FROM follow_snapshots s LEFT JOIN evidence e ON s.evidence_id=e.id WHERE s.evidence_id IS NOT NULL AND e.id IS NULL
UNION ALL SELECT 'orphan_stories', count(*) FROM stories s LEFT JOIN evidence e ON s.evidence_id=e.id WHERE s.evidence_id IS NOT NULL AND e.id IS NULL;
"

# App can connect? Try via DATABASE_URL override
RESTORE_URL="postgresql://igtrack:igtrack@127.0.0.1:5432/${RESTORE_DB}"
if DATABASE_URL="${RESTORE_URL}" node -e "import('postgres').then(m=>{const sql=m.default('${RESTORE_URL}',{max:1}); sql\`SELECT 1\`.then(()=>{console.log('  app connect ok'); sql.end()}).catch(e=>{console.error(e);process.exit(1)})})" 2>&1 | head -5; then
  echo "  app connect ok"
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] restore verify complete — restore DB '${RESTORE_DB}' retained for inspection (drop manually: docker exec ${CONTAINER} psql -U igtrack -d postgres -c \"DROP DATABASE \\\"${RESTORE_DB}\\\";\")"
