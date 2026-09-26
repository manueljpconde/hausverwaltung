#!/usr/bin/env bash
# Demo-Stack neu aufsetzen: Volumes löschen, starten, Demodaten einspielen und prüfen.
# Fasst nur /opt/havewa-demo an; der Haupt-Stack (/opt/havewa) bleibt unberührt.
# .env dort: HAVEWA_TAG, DEMO_DOMAIN, DEMO_DB_PASSWORD, DEMO_AUTH_SECRET, CRMWARE_DEMO_PASSWORD.
set -euo pipefail
cd /opt/havewa-demo
set -a; . ./.env; set +a
: "${CRMWARE_DEMO_PASSWORD:?CRMWARE_DEMO_PASSWORD in .env setzen (mind. 12 Zeichen)}"
IMAGE="${HAVEWA_IMAGE:-ghcr.io/manueljpconde/hausverwaltung}:${HAVEWA_TAG}"

docker compose -f docker-compose.demo.yml down -v
docker compose -f docker-compose.demo.yml up -d

echo "==> warte auf die Demo-App (Migrationen)…"
for _ in $(seq 1 90); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$DEMO_DOMAIN:443:127.0.0.1" "https://$DEMO_DOMAIN/pt/login" || true)
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || { echo "Demo-App antwortet nicht (HTTP $code)" >&2; exit 1; }

# Seed mit demselben Image vom Host aus: DB über 127.0.0.1 (Guard: lokal, Name *_demo),
# Dokumente in den Speicher der Demo-App.
seed() {
  docker run --rm --network host \
    -v havewa-demo_demo-storage:/app/storage \
    -e NODE_ENV=development -e ALLOW_DEMO_SEED=1 -e CRMWARE_DEMO_PASSWORD \
    -e DATABASE_URL="postgresql://havewa:${DEMO_DB_PASSWORD}@127.0.0.1:5433/havewa_demo" \
    "$IMAGE" npx tsx prisma/seed-crmware-demo.ts "$@"
}
seed
seed --validate
echo "==> Demo bereit: https://$DEMO_DOMAIN"
