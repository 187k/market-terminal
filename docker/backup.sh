#!/bin/sh
# PostgreSQL backups for docker-compose.prod.yml (runs in the postgres image).
#
# Writes a pg_dump in custom format to /backups every BACKUP_INTERVAL_HOURS and deletes dumps
# older than BACKUP_KEEP_DAYS. The per-minute market snapshots are left out by default: they
# are a 7-day rolling window that refills by itself, and they are most of the database.
# BACKUP_ONCE=true writes one dump and exits (manual backups, tests).
#
# Restore: see docs/deployment.md.
set -eu

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
mkdir -p /backups

backup() {
  file="/backups/mip-$(date -u +%Y%m%dT%H%M%SZ).dump"
  set -- --format=custom --file="$file.partial"
  if [ "${BACKUP_INCLUDE_SNAPSHOTS:-false}" != "true" ]; then
    set -- "$@" --exclude-table-data=market_snapshots
  fi
  if pg_dump "$@"; then
    mv "$file.partial" "$file"
    echo "$(date -u +%FT%TZ) backup written: $file ($(du -h "$file" | cut -f1))"
  else
    rm -f "$file.partial"
    echo "$(date -u +%FT%TZ) backup FAILED" >&2
  fi
  find /backups -name 'mip-*.dump' -mtime +"$KEEP_DAYS" -delete
}

if [ "${BACKUP_ONCE:-false}" = "true" ]; then
  backup
  exit 0
fi

while true; do
  backup
  sleep $((INTERVAL_HOURS * 3600))
done
