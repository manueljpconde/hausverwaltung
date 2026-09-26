#!/usr/bin/env bash
# HaVeWa auf einen gepinnten GHCR-Tag aktualisieren (oder zurückrollen), z. B. in /opt/havewa.
#
#   bash deploy/update.sh sha-abc1234
#
# Sichert vorher (deploy/backup.sh): Migrationen laufen beim Start und werden durch
# ein Zurücksetzen des Tags NICHT rückgängig gemacht — dafür gibt es deploy/restore.sh.
# Setzt HAVEWA_TAG in .env, zieht das Image, startet den App-Container neu und räumt
# danach verwaiste Images weg — sonst sammeln sich nach jedem Pull alte <none>-Images
# an, bis die Platte voll ist und Postgres crasht.
set -euo pipefail

TAG="${1:?Aufruf: update.sh <tag>  (z. B. sha-abc1234)}"
[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "ungültiger Tag: $TAG" >&2; exit 1; }
DIR="${HAVEWA_DIR:-/opt/havewa}"
FILES=(-f docker-compose.registry.yml)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DIR"
[[ -f .env ]] || { echo "fehlt: $DIR/.env (siehe .env.prod.example)" >&2; exit 1; }
PREV="$(grep -E '^HAVEWA_TAG=' .env | cut -d= -f2- || true)"

echo "==> backing up before update"
HAVEWA_DIR="$DIR" bash "$HERE/backup.sh"

echo "==> pinning HAVEWA_TAG=$TAG (was: ${PREV:-unset})"
{ grep -vE '^HAVEWA_TAG=' .env || true; echo "HAVEWA_TAG=$TAG"; } > .env.tmp
chmod --reference=.env .env.tmp 2>/dev/null || chmod 600 .env.tmp
mv .env.tmp .env

echo "==> pulling image"
docker compose "${FILES[@]}" pull app
echo "==> restarting app"
docker compose "${FILES[@]}" up -d app

# Migrationen laufen beim Start; schlagen sie fehl, startet die App in einer Schleife neu.
echo "==> waiting for app to answer HTTP"
for _ in $(seq 1 60); do
  if docker compose "${FILES[@]}" exec -T app node -e 'fetch("http://localhost:3000/",{redirect:"manual"}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))' 2>/dev/null; then
    HEALTHY=1; break
  fi
  sleep 2
done
if [[ -z "${HEALTHY:-}" ]]; then
  docker compose "${FILES[@]}" logs --tail 50 app >&2
  echo "FEHLER: App antwortet nicht nach 120 s. Image zurück: bash $HERE/update.sh ${PREV:-<previous-tag>}; Daten zurück: bash $HERE/restore.sh <stamp von oben>" >&2
  exit 1
fi

echo "==> pruning dangling images"
docker image prune -f
echo "==> done. Image zurück: bash $HERE/update.sh ${PREV:-<previous-tag>} — Daten zurück (nach Migration): bash $HERE/restore.sh <stamp von oben>"
docker compose "${FILES[@]}" ps
