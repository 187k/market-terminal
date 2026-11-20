# Crypto Market Intelligence Platform

Collects market data from seven crypto exchanges (Bybit, Binance, MEXC, Hyperliquid, Bitget, BingX, Gate), runs five analytical scanners, sends their signals to Telegram and shows everything in a web dashboard. It is an analytical tool only: it never places orders.

**Status: Stages 1–5 complete; Stage 6 (final testing) done on the development PC, the 24 h server soak is pending.** All seven exchanges stream normalised market data for the 100 largest crypto assets. The five scanners (Fair Price, Open Interest, Funding Rate, Cross-Exchange Spread, TWAP / DCA) run in the engine, record signals, and send them to Telegram. The dashboard updates over a WebSocket and has the five working windows with filters, detailed views, signal history, a settings editor per scanner, a per-coin view, and a view-only **terminal** (candlestick chart, order book and trades of one instrument).

Design documents:

- [docs/stage-1-analysis.md](docs/stage-1-analysis.md): API analysis and architecture.
- [docs/stage-3-exchanges.md](docs/stage-3-exchanges.md): connectors as built, field availability per exchange, resolved and open questions.
- [docs/stage-4-scanners.md](docs/stage-4-scanners.md): **description of each bot**: formulas, settings, messages, limitations, verification.
- [docs/stage-5-dashboard.md](docs/stage-5-dashboard.md): the dashboard: realtime protocol, windows, filters, detailed views, settings editor, coin details, API.
- [docs/terminal.md](docs/terminal.md): the view-only terminal: chart, order book, trades, data sources and refresh rates.
- [docs/stage-6-testing.md](docs/stage-6-testing.md): final testing: what was verified, measured performance, open items.
- [docs/deployment.md](docs/deployment.md): **production deployment**: HTTPS, backups, restore, updates, retention.
- [docs/deployment-proxmox.md](docs/deployment-proxmox.md): step by step onto a home Proxmox server (VM, Docker, git remote, LAN or HTTPS access).

## Requirements

- Node.js 22.12 or newer (developed on 22.22)
- Docker Desktop (for PostgreSQL and Redis, and for running the full stack)

## Quick start (local development)

```bash
cp .env.example .env        # then set DASHBOARD_PASSWORD and SESSION_SECRET
npm install                 # also generates the Prisma client
npm run infra:up            # PostgreSQL on 127.0.0.1:5433, Redis on 127.0.0.1:6379
npm run db:deploy           # apply database migrations
npm run dev                 # collector + engine + api + web, with prefixed logs
```

Open http://localhost:5173 and sign in with `DASHBOARD_USER` / `DASHBOARD_PASSWORD` from `.env`. Stop with Ctrl+C. `npm run dev -- api web` starts only some of the processes.

## Full stack in Docker

```bash
docker compose --profile app up -d --build
```

Open http://localhost:8080. This builds the images, runs migrations once (`migrate` service) and starts `collector`, `engine`, `api` and `web` (nginx serving the dashboard and proxying `/api`). `docker compose --profile app down` stops everything; the database survives in the `pgdata` volume.

All published ports bind to `127.0.0.1`, so nothing is reachable from the network while the platform is local.

For a server, add the production override (HTTPS via Caddy, backups, log rotation): see [docs/deployment.md](docs/deployment.md).

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build
```

## Scripts

| Command                           | What it does                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Run all processes in watch mode                                                                               |
| `npm test`                        | Run all tests (Vitest)                                                                                        |
| `npm run typecheck`               | Type-check every workspace                                                                                    |
| `npm run build`                   | Compile every workspace to `dist/`                                                                            |
| `npm run infra:up` / `infra:down` | Start / stop PostgreSQL and Redis containers                                                                  |
| `npm run db:migrate`              | Create and apply a migration after editing `schema.prisma` (dev)                                              |
| `npm run db:deploy`               | Apply pending migrations                                                                                      |
| `npm run db:generate`             | Regenerate the Prisma client                                                                                  |
| `npm run format`                  | Format with Prettier                                                                                          |
| `npm run verify`                  | Check the running system: freshness, cross-exchange prices, field sanity, every signal recomputed (read-only) |
| `npm run soak -- --minutes 1440`  | Sample health, resources and Telegram outcomes over time; writes `soak/*-summary.md`                          |
| `npm run test:live`               | Opt-in tests against the real exchanges (public endpoints)                                                    |

## Architecture

Three backend processes share Redis (live state, heartbeats, sessions, pub/sub) and PostgreSQL (history and settings):

```
exchanges ──WS/REST──▶ collector ──▶ Redis ◀── engine (five scanners → signals → Telegram)
                           │           ▲
                           ▼           │
                       PostgreSQL ◀── api (Fastify) ◀──▶ web (React dashboard)
```

| Process     | Role                                                  | Current state                                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collector` | Exchange connectors, normalisation, connection health | Seven connectors, instrument universe, live state with freshness and validation; publishes market snapshots and health every second                                                                                                                                                             |
| `engine`    | Scanners and Telegram delivery                        | Five scanners, signal lifecycle (dedupe, cooldown, edits), Telegram, signal history in PostgreSQL                                                                                                                                                                                               |
| `api`       | REST API and WebSocket for the dashboard, login       | Health, auth, system status, events, market data, universe, scanner status, signals and history, coin details, scanner settings, terminal data, realtime topics on `/ws`. For the terminal it requests candles and order books from the exchanges' public REST APIs while an instrument is open |
| `web`       | Dashboard                                             | Five scanner windows (status, metrics, main signals, latest updates, filters), detailed views with history and settings, coin view, exchange health, event log, sortable market table, view-only terminal                                                                                       |

### Market data flow

```
connector (per exchange)                 collector                                   Redis
  REST bootstrap + periodic sync ─┐
  WebSocket streams ──────────────┼─▶ normalised updates ─▶ MarketState ──1 s──▶ mip:market:<exchange>
  REST polls (OI, BingX index) ───┘      (12 fields)        validate, drop        mip:health:exchanges
                                                            out-of-order,         mip:universe, mip:instruments
CoinGecko ─▶ universe (top N, price-checked mapping) ─▶ tracked symbols per exchange
```

1. On start each connector loads its tradable crypto USDT perpetuals and a REST snapshot.
2. The universe service ranks assets by CoinGecko market cap and maps them to instruments, accepting an instrument only if its price agrees with the other exchanges and with CoinGecko (this catches ticker collisions and wrong multipliers). The ranking is stored in PostgreSQL, refreshed daily and reused after a restart.
3. Each connector streams only the universe's instruments. The collector keeps the latest value of every field, judges its freshness (connection drops, per-field age limits) and publishes evaluated snapshots to Redis once per second.
4. The API serves those snapshots; if the collector stops publishing, every value is reported as stale.

Details per exchange (fields, sources, filters, limits): [docs/stage-3-exchanges.md](docs/stage-3-exchanges.md).

Each process writes a heartbeat to Redis every 5 s with a 15 s expiry, so a crashed process shows up as missing in the dashboard.

### Project structure

```
apps/
  collector/     process: connectors → Redis / PostgreSQL
  engine/        process: market view, scanners/, signal engine, Telegram notifier,
                 trade feed, Hyperliquid TWAP watcher
  api/           process: Fastify REST API, login, realtime WebSocket (/ws)
  web/           React + Vite dashboard
packages/
  core/          shared types, config validation, logging, backoff, shutdown handling
  bus/           Redis client, key names, heartbeats, health snapshots
  connectors/    base layer, supervisor, CoinGecko client, one folder per exchange:
                   <exchange>/parse.ts (pure normalisation), index.ts (connector),
                   fixtures/ (recorded real payloads), *.test.ts
  analytics/     pure calculation functions (deviations, funding, OI, VWAP, profit)
  db/            Prisma schema, migrations, client
apps/collector/src/
  market-state.ts   live values, freshness, validation
  universe/         CoinGecko ranking, instrument mapping, persistence
docker/          nginx config for the web image
tools/           dev runner, payload recorder, live-test runner
docs/            analysis and design documents
```

`packages/core/src/types` holds browser-safe types shared by the backend and the dashboard (`@mip/core/types`).

### Exchange connection base layer (`packages/connectors`)

Everything a concrete connector needs, so exchange code only deals with message formats:

- **`RateLimiter`**: sliding-window limiter with several windows per exchange (e.g. per-second and per-minute), request weights, priorities, and a global pause after HTTP 429 or a ban. Uses 80 % of each published limit by default.
- **`RestClient`**: timeouts, bounded retries with jittered backoff (GET only by default), `Retry-After` handling, error classification (`rate_limited`, `banned`, `client`, `server`, `timeout`, `network`, `decode`, `exchange`), per-exchange status policies (e.g. Bybit's 403 = 10-minute ban), detection of errors inside HTTP 200 bodies, and a hook for request signing.
- **`ManagedWebSocket`**: heartbeats (application-level or protocol ping), replies to server pings (BingX), GZIP decoding, stale-data detection, reconnect with jittered exponential backoff, and planned rotation that opens the new connection before closing the old one (for Binance's 24 h limit).
- **`SubscriptionManager`**: spreads topics over as few connections as the exchange allows, batches subscribe requests by count and size, paces them, and re-subscribes a connection's own topics after every reconnect.
- **`BaseConnector`** and **`ConnectorSupervisor`**: tracked-symbol bookkeeping, periodic REST tasks, aggregated health per exchange, and isolation so one failing exchange is retried without affecting the others. After a ban the supervisor waits as long as the exchange asked; REST limiters are shared per exchange across restarts so a restarted connector inherits any pause.

A concrete connector is one folder: `parse.ts` maps payloads onto the normalised fields, `index.ts` declares its capabilities (which fields it provides, how, and how fresh they must be) and wires REST and WebSocket. Adding an exchange = one folder plus one entry in `registry.ts`.

### Data rules

- Missing data is never replaced by a made-up value: fields are either available (with a timestamp) or unavailable with a reason (`Field<T>` in `@mip/core`): not provided by the exchange, needs an API key, not received yet, stale, rejected by validation, or not implemented.
- Fixed units everywhere: prices per contract base unit, sizes and open interest (one side) in base units, funding as a fraction per interval. `InstrumentInfo.multiplier` converts "1000PEPE"-style contracts to the asset.
- High-frequency data stays in memory and Redis; PostgreSQL receives batched writes only.
- Secrets never reach the logs: API keys, passwords, tokens and auth headers are redacted by the logger.

## Configuration

All settings come from environment variables (`.env` locally, the container environment in Docker). See [.env.example](.env.example) for the full list. Each process validates its variables at start-up and lists every missing or invalid one without printing their values.

| Variable                                                                                        | Used by                           | Notes                                                                                                                              |
| ----------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                  | collector, api, migrations        | Local default points at the container on port 5433                                                                                 |
| `REDIS_URL`                                                                                     | all                               |                                                                                                                                    |
| `LOG_LEVEL`, `LOG_PRETTY`                                                                       | all                               | JSON logs when `LOG_PRETTY=false`                                                                                                  |
| `EXCHANGES_ENABLED`                                                                             | collector                         | Comma-separated subset of the seven exchanges                                                                                      |
| `API_HOST`, `API_PORT`                                                                          | api                               | `127.0.0.1` locally; Docker sets `0.0.0.0` inside the container                                                                    |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD`                                                          | api                               | Single dashboard login                                                                                                             |
| `SESSION_SECRET`, `SESSION_TTL_HOURS`, `COOKIE_SECURE`                                          | api                               | Sessions live in Redis; restarting Redis logs everyone out                                                                         |
| `UNIVERSE_SIZE`, `UNIVERSE_RANKING`                                                             | collector                         | Default 100 assets by `market_cap`; `volume` ranks by perp turnover                                                                |
| `UNIVERSE_REFRESH_HOURS`, `UNIVERSE_MAX_PRICE_DEVIATION`                                        | collector                         | Default 24 h and 0.15 (15 %)                                                                                                       |
| `COINGECKO_API_KEY`, `COINGECKO_API_PLAN`                                                       | collector                         | Optional; without a key the public API is used (~5 calls/min)                                                                      |
| `<EXCHANGE>_API_KEY` / `_SECRET` (`BITGET_API_PASSPHRASE`)                                      | collector                         | Optional, read-only only. Used for Binance max leverage                                                                            |
| `MEXC_REST_URL`, `MEXC_WS_URL`                                                                  | collector (REST also engine, api) | Leave empty; only for networks that block MEXC's documented hosts                                                                  |
| `TERMINAL_BOOK_REFRESH_MS`, `TERMINAL_CANDLE_SYNC_MS`                                           | api                               | Terminal: order book every 2 s, newest candles every 10 s, only while an instrument is open ([docs/terminal.md](docs/terminal.md)) |
| `TELEGRAM_CHAT_ID`, `TELEGRAM_<BOT>_BOT_TOKEN` / `_TOPIC_ID`                                    | engine                            | One chat (forum), one topic and bot per scanner; empty = record without sending                                                    |
| `TRADES_ENABLED`, `TRADES_MIN_NOTIONAL_USD`, `MARKET_SNAPSHOT_RETENTION_DAYS`                   | collector                         | Trade stream for the TWAP detector (default min $500); snapshot history (7 days)                                                   |
| `CONNECTION_EVENT_RETENTION_DAYS`, `SIGNAL_RETENTION_DAYS`                                      | collector, engine                 | Connection events kept 30 days; resolved signals 90 days (minimum 8)                                                               |
| `DOMAIN`, `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `BACKUP_INTERVAL_HOURS`, `BACKUP_INCLUDE_SNAPSHOTS` | production override               | HTTPS host name; database backups ([docs/deployment.md](docs/deployment.md))                                                       |
| Scanner thresholds and filters                                                                  | engine                            | Stored in PostgreSQL; edited in the dashboard (Settings) or `PUT /api/scanners/:id/settings`                                       |

## Testing

`npm test` runs unit and component tests. Notable coverage:

- WebSocket client against a local server: reconnect after drops (including five in a row), stale detection, heartbeats, server-ping replies, GZIP frames, rejected handshakes, gap-free rotation, clean stop.
- Subscription sharding, batching, pacing and per-connection re-subscription.
- Rate limiter windows, weights, priorities, pauses and aborts.
- REST client retries, 429 / ban handling, timeouts, network errors, body-level errors.
- Supervisor isolation and retry; batched event writes surviving a database outage.
- API login, sessions, cookie tampering, login throttling, health checks.
- Config validation and log redaction.
- **Normalisation of every exchange on recorded real payloads** (`packages/connectors/src/<exchange>/fixtures/`), plus each connector run end to end against a local replay of that traffic: subscribe, normalise, re-subscribe after a dropped connection, change topics without reconnecting.
- Live state: merging deltas, freshness rules, connection interruption, out-of-order drops, validation.
- Dashboard backend: the realtime hub, `/ws` authentication and Origin checks, coin details, settings merge and JSON Schema.
- Every scanner formula, the signal lifecycle (confirmation, edits, resolve, cooldown, restart without duplicates), the Telegram notifier against a fake Bot API, each scanner on synthetic and recorded real data, order-book and trade parsing for all seven exchanges. Details in [docs/stage-4-scanners.md](docs/stage-4-scanners.md).
- Universe selection: ranking, exclusions, multiplier mapping, ticker collisions, stale reference prices, volume fallback.

**Live tests** (opt-in, real exchanges, public endpoints only):

```bash
npm run test:live
```

For each exchange this streams BTC and ETH, checks every field the connector promises over WebSocket, then cuts all its connections and checks that they reconnect, re-subscribe and deliver fresh data. `npm run test:live -- bybit gate` runs a subset.

**Re-recording fixtures** when an exchange changes its API: `npm run record -- <exchange> [seconds]` writes trimmed REST responses and WebSocket messages to the connector's `fixtures/` folder.

## Technical decisions

- **npm workspaces** rather than pnpm: nothing extra to install locally or in Docker. Internal packages export TypeScript sources under a `source` condition for development and tests, and compiled `dist/` for production.
- **TypeScript 7**, **Fastify 5**, **React 19 + Vite 8**, **Vitest 5**, **ioredis 6**, **pino 10**, **zod 4**.
- **Prisma 7.10** (stable) with the `pg` driver adapter. Prisma 8 is still a release candidate. Prisma 7 reads the database URL from `packages/db/prisma.config.ts`.
- **PostgreSQL 18** and **Redis 8** in containers. Redis runs without persistence because it only holds data that is rebuilt within seconds.
- **Dashboard realtime:** the API pushes changes over `/ws`; each topic carries the same payload as a REST route, and the dashboard polls those routes while the socket is down. The API reads Redis once per second per followed topic instead of adding a second publishing path (details in [docs/stage-5-dashboard.md](docs/stage-5-dashboard.md)).
- **WebSocket first, REST where no stream exists**: open interest on Binance and BingX, BingX index price and funding, MEXC funding interval. REST also bootstraps and re-syncs instruments every 15 min.
- **Hand-written parsers** on the hot path (about 2,500 updates/s for 100 assets) instead of schema validation per message; values are validated per field in the live state.
- **Binance top-5 depth every 500 ms** instead of the real-time book ticker, which sent ~1,000 messages/s for just three symbols.
- **Terminal chart:** [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/) 5.2 (Apache-2.0). Candle history and order books come from the exchanges' public REST APIs on demand (shared rate limiters and bans); the forming candle follows the WebSocket-fed last price between syncs ([docs/terminal.md](docs/terminal.md)).

## Troubleshooting

- **Port 5432 already in use**: the project's PostgreSQL uses host port 5433 (`POSTGRES_PORT`) to avoid clashing with a local PostgreSQL install.
- **`Invalid configuration`** on start: the message lists each missing or invalid variable; compare `.env` with `.env.example`.
- **Dashboard shows a process as missing**: its heartbeat has not been written for 15 s; check that process's logs (`docker compose logs collector`).
- **Binance "down" with HTTP 418**: the IP is banned (the message says until when). On shared IPs such as VPN or Cloudflare WARP exits this can be caused by other users. The collector waits for the ban to end instead of retrying, and remembers it across restarts (Redis key `mip:pause:<exchange>`), because requests during a ban make Binance extend it. Use a server with its own IP.
- **MEXC "Access Denied" / HTTP 403**: some networks are refused by `contract.mexc.com`, for example Cloudflare WARP exits. If MEXC works without the VPN, exclude its hosts from the tunnel instead of changing code. With WARP: Preferences → Advanced → Split tunnels → add `contract.mexc.com` and `api.mexc.com`, or run `warp-cli tunnel host add contract.mexc.com` and `warp-cli tunnel host add api.mexc.com`. Then restart the collector. Otherwise set `MEXC_WS_URL` to a mirror that works from that network.
- **Telegram "chat not found"** (the scanner's Telegram badge shows `error`): the bot is not a member of the chat in `TELEGRAM_CHAT_ID`, or the ID is wrong. Add every bot to the group (forum) with permission to post, check the ID (supergroups start with `-100`), then restart the engine. A rejected bot stays off until the engine restarts.
- **First start takes about 90 s**: without a CoinGecko key the ranking is loaded at the public rate limit. Later starts reuse the stored ranking.
- **Creating a migration from PowerShell**: `npm run db:migrate -- --name x` loses `--name` in PowerShell and Prisma then waits for input. Run `npx prisma migrate dev --name x` inside `packages/db` (or use Git Bash), then `npm run db:generate`.
- **Negative "Delay" in the exchange table**: the local clock is behind the exchanges. Freshness is unaffected (it uses local receive times), but enable time synchronisation.
