#!/usr/bin/env bash
# HaVeWa aus einem Backup von deploy/backup.sh wiederherstellen.
# ÜBERSCHREIBT die aktuelle Datenbank und /app/storage.
#
#   bash deploy/restore.sh 20260926T033000Z
#
# Env: HAVEWA_DIR (Standard /opt/havewa), BACKUP_DIR (Standard $HAVEWA_DIR/backups)
set -euo pipefail

STAMP="${1:?Aufruf: restore.sh <stamp>  (z. B. 20260926T033000Z, siehe ls \$BACKUP_DIR)}"
DIR="${HAVEWA_DIR:-/opt/havewa}"
FILES=(-f docker-compose.registry.yml)
BACKUP_DIR="${BACKUP_DIR:-$DIR/backups}"
DUMP="$BACKUP_DIR/havewa-$STAMP.dump"
STORAGE="$BACKUP_DIR/havewa-$STAMP.storage.tar.gz"

cd "$DIR"
[[ -f "$DUMP" ]] || { echo "fehlt: $DUMP" >&2; exit 1; }
[[ -f "$STORAGE" ]] || { echo "fehlt: $STORAGE" >&2; exit 1; }

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
