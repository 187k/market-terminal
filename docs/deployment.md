# Production deployment

How to run the platform on a server. The production setup is the normal `docker-compose.yml` plus the override `docker-compose.prod.yml`, which adds:

- **HTTPS** through Caddy, with automatic Let's Encrypt certificates (`docker/Caddyfile`).
- **Backups** of PostgreSQL on a schedule (`docker/backup.sh`).
- **Log rotation** for every container (10 MB × 5 files).
- **Secure cookies** (`COOKIE_SECURE=true` forced on the API).
- **Required values:** it refuses to start without `POSTGRES_PASSWORD` and `DOMAIN`.

Only Caddy listens on the network (ports 80 and 443). PostgreSQL (5433) and Redis (6379) stay bound to `127.0.0.1` for administration, and the dashboard container has no host port.

## 1. Server requirements

- Linux with Docker Engine and Docker Compose v2.24 or later (the override uses `!reset`).
- **All seven exchanges reachable without a VPN.** Check from the server before deploying; shared VPN exits (Cloudflare WARP) get Binance 418 bans and MEXC 403s. No inbound ports other than 80 and 443.
- A DNS name (`DOMAIN`) pointing to the server, so Caddy can obtain a certificate.
- Resources measured on the development PC (see [stage-6-testing.md](stage-6-testing.md)): about 1 GB of RAM for all containers, under one CPU core on average. 2 vCPU and 4 GB RAM leave comfortable headroom. Disk: per-minute snapshots take about 175 bytes per instrument-minute including indexes. With the default 100 assets (about 620 instruments) that is roughly 150 MB per day, capped near 1.1 GB by the 7-day retention. Add backups on top.
- An accurate clock (`systemd-timesyncd` or `chrony`). Freshness uses local receive times, but the dashboard's delay column and Telegram times read better with a synchronised clock.

## 2. Configure

```bash
git clone <repository> mip && cd mip
cp .env.example .env
```

Edit `.env`. In production set at least:

| Variable                                          | Value                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `NODE_ENV`                                        | `production`                                                                              |
| `LOG_PRETTY`                                      | `false`                                                                                   |
| `DOMAIN`                                          | the dashboard's public host name                                                          |
| `POSTGRES_PASSWORD`                               | a strong password, **before the first start** (PostgreSQL stores it when the volume is created; changing it later needs `ALTER USER`) |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD`            | the single dashboard login; 12+ characters                                                |
| `SESSION_SECRET`                                  | 32+ random characters, e.g. `openssl rand -base64 48`                                     |
| `TELEGRAM_CHAT_ID`, `TELEGRAM_*_BOT_TOKEN`, `TELEGRAM_*_TOPIC_ID` | one forum supergroup, one bot and topic per scanner; every bot added to the group with permission to post |
| Exchange keys                                     | optional, **read-only** (no trading, no withdrawals)                                      |
| `MEXC_REST_URL`, `MEXC_WS_URL`                    | leave empty on a server                                                                   |
| `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `BACKUP_INTERVAL_HOURS`, `BACKUP_INCLUDE_SNAPSHOTS` | defaults: `./backups`, 14 days, every 24 h, snapshots excluded |

The API logs `insecure setting: …` at startup for a weak dashboard password or session secret, `COOKIE_SECURE=false`, or the default database password. Check its log after the first start.

Protect the file: `chmod 600 .env`.

## 3. Start

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build
```

The first start builds the images, applies migrations (`migrate` service), and builds the instrument universe. That takes about 90 s without a CoinGecko key. Caddy requests the certificate on the first HTTPS request.

Tip: `export COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml` lets every later `docker compose --profile app …` command use both files.

## 4. Check

1. `docker compose ps`: all services up; `api` healthy; `migrate` exited with 0.
2. Open `https://<DOMAIN>` and log in. The top bar shows **live** (WebSocket) and three green process badges.
3. Exchange connections: all seven `ok` within a minute or two.
4. Each scanner window: `running`, Telegram `ok`. A Telegram `error` names the reason ("chat not found" = the bot is not in the group or the chat ID is wrong; restart the engine after fixing).
5. `npm run verify` on the server (needs Node 22 and `npm ci`; reads Redis and PostgreSQL on localhost): every hard check passes.
6. Run the soak monitor for 24 h: `npm run soak -- --minutes 1440` (see [stage-6-testing.md](stage-6-testing.md)).

## 5. Backups and restore

The `backup` service writes `mip-<UTC time>.dump` (pg_dump custom format) to `BACKUP_DIR` every `BACKUP_INTERVAL_HOURS` and deletes dumps older than `BACKUP_KEEP_DAYS`. Per-minute market snapshots are left out by default: they are a rolling 7-day window that refills by itself, and they are most of the database. The OI scanner needs 4 h of them after a restore before its longest window works again. Copy the backup directory off the server (rsync, object storage); a backup on the same disk does not survive a disk failure.

Manual backup:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app run --rm -e BACKUP_ONCE=true backup
```

Restore (stops writers first, replaces the data):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app stop collector engine api
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres pg_restore -U mip -d mip --clean --if-exists < backups/mip-<time>.dump
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d
```

Redis holds nothing that needs a backup (live state, sessions, heartbeats; it runs without persistence). Restarting it logs the dashboard user out.

## 6. Updates

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build
```

Migrations run automatically before the app containers start. After editing `.env`, recreate the affected containers with `up -d <service>`; `restart` keeps the old environment.

Restarts are safe for signals: open signals are restored from PostgreSQL and never announced twice. Exchange bans recorded in Redis (`mip:pause:<exchange>`) are honoured across restarts. A collector restarted **during** a ban waits for the ban to end before loading that exchange's instruments, so the exchange stays offline until then. Avoid restarting the collector during a ban.

## 7. Data retention

| Data                       | Kept                                | Setting                           |
| -------------------------- | ----------------------------------- | --------------------------------- |
| Per-minute market snapshots | 7 days                             | `MARKET_SNAPSHOT_RETENTION_DAYS`  |
| Connection events          | 30 days                             | `CONNECTION_EVENT_RETENTION_DAYS` |
| Resolved signals           | 90 days (minimum 8)                 | `SIGNAL_RETENTION_DAYS`           |
| Universe snapshots         | latest builds only                  | (fixed)                           |
| Backups                    | 14 days                             | `BACKUP_KEEP_DAYS`                |
| Container logs             | 50 MB per container                 | `docker-compose.prod.yml`         |

## 8. Security notes

- The platform never trades. Exchange keys, if any, must be read-only.
- Secrets live only in `.env` on the server. Logs redact known secret keys.
- The dashboard has a single login, throttled after 10 failed attempts per IP in 5 minutes. Caddy passes the real client IP. Put the dashboard behind an additional allow-list (firewall, VPN, Caddy `remote_ip` matcher) if it should not be reachable from the whole internet.
- The WebSocket checks the session cookie on connect and every minute, and refuses browser connections from another origin.
