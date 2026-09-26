#!/usr/bin/env bash
# HaVeWa aus einem Backup von deploy/backup.sh wiederherstellen.
# ÜBERSCHREIBT die aktuelle Datenbank und /app/storage — sichert den aktuellen Stand vorher
# (deploy/backup.sh), damit auch ein falscher Stamp oder ein abgebrochener Restore umkehrbar ist.
#
#   bash deploy/restore.sh 20260926T033000Z
#
# Env: HAVEWA_DIR (Standard /opt/havewa), BACKUP_DIR (Standard $HAVEWA_DIR/backups)
set -euo pipefail

STAMP="${1:?Aufruf: restore.sh <stamp>  (z. B. 20260926T033000Z, siehe ls \$BACKUP_DIR)}"
[[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "ungültiger Stamp: $STAMP" >&2; exit 1; }
DIR="${HAVEWA_DIR:-/opt/havewa}"
FILES=(-f docker-compose.registry.yml)
BACKUP_DIR="${BACKUP_DIR:-$DIR/backups}"
DUMP="$BACKUP_DIR/havewa-$STAMP.dump"
STORAGE="$BACKUP_DIR/havewa-$STAMP.storage.tar.gz"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DIR"
[[ -f "$DUMP" ]] || { echo "fehlt: $DUMP" >&2; exit 1; }
[[ -f "$STORAGE" ]] || { echo "fehlt: $STORAGE" >&2; exit 1; }

# Eigenes Unterverzeichnis: das Aufräumen in backup.sh (maxdepth 1) darf das Ziel-Backup
# nicht löschen, falls es älter als BACKUP_KEEP_DAYS ist. Rückweg:
#   BACKUP_DIR=$BACKUP_DIR/pre-restore bash deploy/restore.sh <stamp>
echo "==> backing up current state to $BACKUP_DIR/pre-restore"
HAVEWA_DIR="$DIR" BACKUP_DIR="$BACKUP_DIR/pre-restore" BACKUP_RSYNC_TARGET="" bash "$HERE/backup.sh"

# App stoppen, damit während des Restores niemand schreibt.
echo "==> stopping app"
docker compose "${FILES[@]}" stop app

echo "==> restoring database"
docker compose "${FILES[@]}" exec -T db dropdb -U havewa --if-exists --force havewa
docker compose "${FILES[@]}" exec -T db createdb -U havewa -O havewa havewa
docker compose "${FILES[@]}" exec -T db pg_restore -U havewa -d havewa --no-owner --role=havewa --exit-on-error < "$DUMP"

# Storage über einen Wegwerf-Container mit dem App-Image befüllen — die App läuft ja nicht.
echo "==> restoring storage"
docker compose "${FILES[@]}" run --rm --no-deps -T --entrypoint sh app \
  -c 'find /app/storage -mindepth 1 -delete && tar -C /app/storage -xzf -' < "$STORAGE"

echo "==> starting app"
docker compose "${FILES[@]}" up -d app
docker compose "${FILES[@]}" ps
