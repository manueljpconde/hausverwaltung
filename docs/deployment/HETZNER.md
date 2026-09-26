# Hetzner devbox deployment

This fork runs as a **devbox** (not production) on a single Hetzner Cloud VM with
Docker Compose: Caddy (automatic HTTPS) + app + Postgres 16. The app image is built
by GitHub Actions from this fork and pulled from GHCR; nothing is built on the server.

| | |
|---|---|
| URL | https://realestate.crmware.pt |
| Server | Hetzner Cloud `havewa`, type `cx23` (2 vCPU / 4 GB / 40 GB), location `nbg1`, Ubuntu 24.04 |
| IPv4 / IPv6 | `2.28.113.150` / `2a01:4f8:1c19:1ad4::1` |
| Image | `ghcr.io/manueljpconde/hausverwaltung:sha-<short>` (public package) |
| Stack dir | `/opt/havewa` on the server |
| Tracking | #4 (deployment scripts, PR #5) |

Devbox scope: backups stay on the server only; no off-site copy, no Hetzner backups.

## How a release reaches the server

1. Push or merge to `main`.
2. `.github/workflows/docker-publish.yml` builds amd64 + arm64 and pushes
   `ghcr.io/manueljpconde/hausverwaltung:latest` and `:sha-<short>`.
3. Deploy the pinned tag:

   ```bash
   ssh -i ~/.ssh/havewa_hetzner_ed25519 root@2.28.113.150 \
     'bash /opt/havewa/deploy/update.sh sha-<short>'
   ```

`update.sh` backs up, pins `HAVEWA_TAG` in `.env`, pulls, restarts the app, waits up to
120 s for HTTP (exits 1 with logs if the app does not come up) and prunes dangling images.
Migrations run on container start. Going back to an older tag does **not** undo them —
restore the backup `update.sh` printed instead.

Check the build before deploying:

```bash
gh run list -R manueljpconde/hausverwaltung -w "Build and push image" -L 3
```

## Server layout

```
/opt/havewa/                      0700 root
├── .env                          0600 — secrets, never in git
├── docker-compose.registry.yml
├── Caddyfile
├── deploy/{update,backup,restore}.sh
└── backups/                      0700 — havewa-<stamp>.dump + .storage.tar.gz (0600)
    └── pre-restore/              state saved by restore.sh before overwriting
```

`.env` keys: `DB_PASSWORD` (hex), `AUTH_SECRET`, `DOMAIN=realestate.crmware.pt`,
`HAVEWA_TAG`. Secrets were generated on the server with `openssl rand` and exist only there.

Docker volumes: `havewa_havewa-db` (Postgres), `havewa_havewa-storage` (documents, logo),
`havewa_caddy-data` (certificates).

## Backups

- Nightly at 03:30 UTC: `/etc/cron.d/havewa-backup` → `deploy/backup.sh`, log in
  `/var/log/havewa-backup.log`. 14-day local retention.
- Every `update.sh` and `restore.sh` run also backs up first.
- Restore: `bash /opt/havewa/deploy/restore.sh <stamp>` (stamp from `ls /opt/havewa/backups`).
  Undo a restore: `BACKUP_DIR=/opt/havewa/backups/pre-restore bash /opt/havewa/deploy/restore.sh <stamp>`.
- DB dump and storage archive are taken one after the other, not as one snapshot.

## Access and security

- SSH: `root` with key `~/.ssh/havewa_hetzner_ed25519` only. Password and
  keyboard-interactive login disabled (`/etc/ssh/sshd_config.d/10-havewa.conf`).
- Hetzner firewall `havewa`: 22/tcp from the admin's IP only; 80, 443 and ICMP open.
  Postgres (5432) and the app (3000) are not reachable from outside.
- fail2ban and unattended-upgrades are enabled.
- TLS: Let's Encrypt via Caddy, renewed automatically.

**SSH times out?** The admin's IP probably changed. Update the rule:

```bash
hcloud firewall replace-rules havewa --rules-file - <<EOF
[{"direction":"in","protocol":"tcp","port":"22","source_ips":["$(curl -s https://api.ipify.org)/32"]},
 {"direction":"in","protocol":"tcp","port":"80","source_ips":["0.0.0.0/0","::/0"]},
 {"direction":"in","protocol":"tcp","port":"443","source_ips":["0.0.0.0/0","::/0"]},
 {"direction":"in","protocol":"icmp","source_ips":["0.0.0.0/0","::/0"]}]
EOF
```

## DNS

`crmware.pt` is served by `ns5`/`ns6.sitedns.pt`, managed in that provider's panel:
`A realestate → 2.28.113.150`. Verify with `dig +short realestate.crmware.pt @ns5.sitedns.pt`.

## Common operations

```bash
ssh -i ~/.ssh/havewa_hetzner_ed25519 root@2.28.113.150
cd /opt/havewa
docker compose -f docker-compose.registry.yml ps
docker compose -f docker-compose.registry.yml logs -f --tail 100 app
docker compose -f docker-compose.registry.yml exec db psql -U havewa havewa
```

Scripts piped over `ssh … 'bash -s'` break when they call `docker compose exec`:
it reads the rest of the script from stdin. Copy the script to the server and run it there.

## Rebuilding from scratch

1. `hcloud context create havewa` (API token, Read & Write).
2. Create SSH key, firewall (rules above) and server:
   `hcloud server create --name havewa --type cx23 --image ubuntu-24.04 --location nbg1 --ssh-key havewa --firewall havewa`.
3. Point the `realestate` A record at the new IPv4.
4. On the server: `apt-get install -y unattended-upgrades fail2ban rsync`,
   `curl -fsSL https://get.docker.com | sh`, add the sshd drop-in above.
5. Copy `docker-compose.registry.yml`, `Caddyfile` and `deploy/*.sh` to `/opt/havewa`;
   create `.env` from `.env.prod.example` with fresh secrets and a pinned `HAVEWA_TAG`.
6. Wait until DNS resolves, then `docker compose -f docker-compose.registry.yml up -d`.
   Caddy obtains the certificate on start; repeated failures hit Let's Encrypt rate limits.
7. **Immediately** open `https://realestate.crmware.pt/setup` and create the admin — until
   then anyone can claim the instance. Or set `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env`
   before the first start to skip the wizard.
8. Install the backup cron line (see Backups).

Tear down: `hcloud server delete havewa` (billed hourly until deleted), then remove the DNS record.

## Landing page visits (#33)

Caddy logs only requests to `/marketing` to `/data/access-marketing.log` (volume `caddy-data`) —
without IP address, headers, cookies or query string; rotated daily, files kept 90 days. Bots cannot be filtered
out (no user agent), so the count is an upper bound. Requests per day:

```bash
ssh -i ~/.ssh/havewa_hetzner_ed25519 root@2.28.113.150 \
  'docker exec havewa-caddy sh -c "cat /data/access-marketing.log; zcat /data/access-marketing-*.log.gz 2>/dev/null"' \
  | jq -r '.ts | floor | strftime("%Y-%m-%d")' | sort | uniq -c
```

Leads: count contact requests on crmware.pt with `referrer: https://realestate.crmware.pt`
(target ≥ 5 in the 90 days after publication).

The Caddyfile is not updated by `deploy/update.sh` (it only restarts the app): after a change,
validate it, copy it to `/opt/havewa/Caddyfile`, then recreate the container — `up -d` alone keeps
the old config (unchanged service; the single-file bind mount still points at the replaced file):

```bash
docker run --rm -e DOMAIN=realestate.crmware.pt -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose -f docker-compose.registry.yml up -d --force-recreate --no-deps caddy
```

## Demo stack (realestate-demo)

`https://realestate-demo.crmware.pt` runs a second stack on the same server for sales demos: same
image, its **own** database (`havewa_demo`) and document storage, so the main devbox data is never
touched. Files: `docker-compose.demo.yml`, `deploy/demo-reset.sh`, `deploy/demo/realestate-demo.caddy`.

- Services are named `demo-app` / `demo-db` (not `app` / `db`): only the app joins the main
  network `havewa_default`, where service names are DNS aliases next to the main stack.
- Memory caps: app 512 MB, database 256 MB. The database port is published on `127.0.0.1:5433`
  only, for the seed.
- The main Caddyfile imports `/opt/havewa/sites/*.caddy`; an empty folder changes nothing.

**One-time setup** (DNS: A record `realestate-demo` → `2.28.113.150`):

```bash
# 2 GB swap (none by default; avoids OOM kills with two stacks)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

mkdir -p /opt/havewa-demo /opt/havewa/sites
# copy docker-compose.demo.yml + deploy/demo-reset.sh → /opt/havewa-demo/
# copy deploy/demo/realestate-demo.caddy → /opt/havewa/sites/
# copy the new Caddyfile + docker-compose.registry.yml → /opt/havewa/, then recreate Caddy
cat > /opt/havewa-demo/.env <<ENV
HAVEWA_TAG=$(grep ^HAVEWA_TAG /opt/havewa/.env | cut -d= -f2)
DEMO_DOMAIN=realestate-demo.crmware.pt
DEMO_DB_PASSWORD=$(openssl rand -hex 24)
DEMO_AUTH_SECRET=$(openssl rand -hex 32)
CRMWARE_DEMO_PASSWORD=
ENV
chmod 600 /opt/havewa-demo/.env
```

The owner sets `CRMWARE_DEMO_PASSWORD` (≥ 12 characters) in that file; it is never printed or
committed. Log-ins for the demo users are listed in `docs/crmware-demo.md`.

**Reset and seed** (after each presentation, or after changing `HAVEWA_TAG`):

```bash
bash /opt/havewa-demo/demo-reset.sh
```

It deletes the demo volumes, starts the stack, waits for the migrations, runs
`prisma/seed-crmware-demo.ts` with the same image from the host (`NODE_ENV=development`,
`ALLOW_DEMO_SEED=1`, database `127.0.0.1:5433/havewa_demo`) and then `--validate`. It never runs
a compose command on the main stack.
