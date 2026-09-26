#!/usr/bin/env bash
# HaVeWa sichern: Postgres-Dump (pg_dump -Fc) + Archiv von /app/storage (Dokumente, Logo).
# Läuft auf dem Docker-Host neben docker-compose.registry.yml, z. B. /opt/havewa.
#
#   bash deploy/backup.sh
#   # nächtlich, /etc/cron.d/havewa-backup:
#   # 30 3 * * * root HAVEWA_DIR=/opt/havewa bash /opt/havewa/deploy/backup.sh >> /var/log/havewa-backup.log 2>&1
#
# Env (alle optional):
#   HAVEWA_DIR           Verzeichnis mit Compose-Datei + .env   (Standard /opt/havewa)
#   BACKUP_DIR           Zielverzeichnis lokal                  (Standard $HAVEWA_DIR/backups)
#   BACKUP_KEEP_DAYS     lokale Aufbewahrung in Tagen           (Standard 14)
#   BACKUP_RSYNC_TARGET  Off-site-Ziel für rsync, z. B. Hetzner Storage Box:
#                        u123456@u123456.your-storagebox.de:havewa/
#   BACKUP_RSYNC_SSH     SSH-Befehl für rsync                   (Standard "ssh -p 23", Storage-Box-Port)
#
# Off-site ist append-only (kein --delete): lokales Aufräumen löscht nichts entfernt.
# Aufbewahrung dort regelt man auf dem Ziel (z. B. Storage-Box-Snapshots).
# DB-Dump und Storage-Archiv entstehen nacheinander, nicht als gemeinsamer Snapshot.
# Wiederherstellen: deploy/restore.sh <stamp>
set -euo pipefail
# Dumps enthalten personenbezogene Daten — nur für root lesbar.
umask 077

DIR="${HAVEWA_DIR:-/opt/havewa}"
FILES=(-f docker-compose.registry.yml)
BACKUP_DIR="${BACKUP_DIR:-$DIR/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

cd "$DIR"
mkdir -p "$BACKUP_DIR"

# Erst in .partial schreiben, dann umbenennen — ein abgebrochener Lauf hinterlässt
# nie eine Datei, die wie ein vollständiges Backup aussieht.
echo "==> dumping database"
docker compose "${FILES[@]}" exec -T db pg_dump -U havewa -Fc havewa > "$BACKUP_DIR/havewa-$STAMP.dump.partial"
mv "$BACKUP_DIR/havewa-$STAMP.dump.partial" "$BACKUP_DIR/havewa-$STAMP.dump"

echo "==> archiving storage"
# Wegwerf-Container statt exec: funktioniert auch, wenn die App gestoppt ist oder crasht.
docker compose "${FILES[@]}" run --rm --no-deps -T --entrypoint tar app -C /app/storage -czf - . > "$BACKUP_DIR/havewa-$STAMP.storage.tar.gz.partial"
mv "$BACKUP_DIR/havewa-$STAMP.storage.tar.gz.partial" "$BACKUP_DIR/havewa-$STAMP.storage.tar.gz"

echo "==> pruning local backups older than $KEEP_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'havewa-*' -mtime +"$KEEP_DAYS" -print -delete

if [[ -n "${BACKUP_RSYNC_TARGET:-}" ]]; then
  echo "==> copying off-site to $BACKUP_RSYNC_TARGET"
  rsync -a -e "${BACKUP_RSYNC_SSH:-ssh -p 23}" --exclude '*.partial' "$BACKUP_DIR/" "$BACKUP_RSYNC_TARGET"
fi

echo "==> done: $STAMP"
ls -l "$BACKUP_DIR/havewa-$STAMP".*
