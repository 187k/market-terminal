# HANDOFF — current state of the project

Snapshot date: **2026-11-20** (Stage 6 done on the development PC; the server soak is pending. Added after Stage 6: the view-only terminal and the home Proxmox deployment guide). This file describes where the project stands now. Permanent working rules are in [CLAUDE.md](CLAUDE.md). The full specification is [prompt.md](prompt.md). Design detail is in [README.md](README.md) and [docs/](docs/). Update this file when the state changes.

## 1. Purpose

The project is the "Crypto Market Intelligence Platform" from `prompt.md`:

- It collects real-time market data for USDT/USDC perpetuals from seven exchanges: Bybit, Binance, MEXC, Hyperliquid, Bitget, BingX and Gate.
- It normalises that data into one model.
- Five scanners look for market situations.
- Each scanner posts to its own Telegram bot.
- Everything is shown in a dark web dashboard.

**It is an analytical tool only.** It never places, changes or cancels orders. LONG / SHORT / BUY / SELL describe an observed situation and are not trading recommendations.

### Scope decisions (user, Stage 1, 2026-11-16)

| Topic            | Decision                                                                       |
| ---------------- | ------------------------------------------------------------------------------ |
| Dashboard access | Single local user; credentials in `.env`                                       |
| API keys         | Read-only keys, supplied by the user in `.env` (none are set yet)              |
| Universe         | The 100 largest crypto assets by CoinGecko market cap (configurable)           |
| Spread scanner   | Perp–perp only; spot is out of scope, so deposit/withdraw status is not needed |
| Instruments      | Crypto only; TradFi / RWA / stock / forex perps are excluded                   |
| Hosting          | A server from which all seven exchanges are reachable                          |
| Telegram         | One forum chat, five topics, one bot per topic                                 |

## 2. Development stages (from `prompt.md` §8)

| Stage | Content                                                                                              | State                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1     | API analysis, availability table, architecture, plan                                                 | Done: [docs/stage-1-analysis.md](docs/stage-1-analysis.md)                                       |
| 2     | Monorepo, backend/frontend skeletons, Postgres, Redis, Docker Compose, logging, connector base layer | Done                                                                                             |
| 3     | Seven exchange connectors, universe, live state with freshness and validation                        | Done: [docs/stage-3-exchanges.md](docs/stage-3-exchanges.md)                                     |
| 4     | Five scanners, signal lifecycle, Telegram notifier                                                   | Done: [docs/stage-4-scanners.md](docs/stage-4-scanners.md)                                       |
| 5     | Full dashboard: WebSocket push, settings editor, filters, history, detail views                      | Done: [docs/stage-5-dashboard.md](docs/stage-5-dashboard.md)                                     |
| 6     | Final testing: soak, load, Telegram live, production config                                          | Done on the dev PC: [docs/stage-6-testing.md](docs/stage-6-testing.md); 24 h server soak pending |
| +     | View-only terminal (chart, order book, trades); home Proxmox deployment guide (user request, 2026-11-20) | Done: [docs/terminal.md](docs/terminal.md), [docs/deployment-proxmox.md](docs/deployment-proxmox.md) |

## 3. Architecture (as built)

```
exchanges ──WS/REST──▶ collector ──▶ Redis ◀── engine (5 scanners → signals → Telegram)
                           │           ▲          │  also: on-demand order books (REST),
                           ▼           │          │  Hyperliquid userTwapHistory (WS)
                       PostgreSQL ◀── api (Fastify) ◀──▶ web (React, nginx in Docker)
```

| Process     | Main files                                                                                                                            | Does                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collector` | `apps/collector/src/main.ts`, `market-state.ts`, `universe/`, `snapshots.ts`, `trades.ts`, `event-writer.ts`                          | Runs the connectors under a supervisor and builds the universe. Keeps every field's live value with freshness and validation. Every 1 s it publishes snapshots and health to Redis. Writes per-minute snapshots and connection events to Postgres. Forwards trades to a Redis Stream. Persists exchange bans in Redis. |
| `engine`    | `apps/engine/src/main.ts`, `runner.ts`, `signals.ts`, `notifier.ts`, `scanners/*`, `history.ts`, `trades.ts`, `hl-twap.ts`, `view.ts` | Ticks every 1 s: reads the market view from Redis, runs each scanner on its own interval, and turns candidates into signals. Writes signals to Postgres and Redis and sends them to Telegram. Reloads settings when told to over pub/sub (60 s reload as fallback).                                                    |
| `api`       | `apps/api/src/server.ts`, `auth.ts`, `sessions.ts`, `status.ts`, `markets.ts`, `scanners.ts`, `assets.ts`, `realtime.ts`, `terminal.ts` | REST API and the `/ws` realtime WebSocket for the dashboard, with a single-user login and sessions stored in Redis. The realtime hub reads each followed topic once per interval and pushes changes. For the terminal: candles and order books from the exchanges' public REST APIs while an instrument is open (shared limiters, bans shared via Redis), trades from the trade stream. |
| `web`       | `apps/web/src/*`                                                                                                                      | React dashboard. One WebSocket per session (`realtime.ts`); while it is down every panel polls the matching REST route (2–5 s).                                                                                                                                                                                        |

Shared packages (npm workspaces, in build order):

| Package           | Contents                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mip/core`       | Shared types (`./types` is browser-safe), zod env schemas (`config.ts`), scanner settings schemas (`scanner-settings.ts`), pino logger with redaction, backoff, shutdown handling           |
| `@mip/bus`        | Every Redis key and channel (`keys.ts`); read/write helpers for market snapshots, instruments, universe, bans, signals, scanner status, trade stream, heartbeats, health; `TradeBuffer` / `TradeFeed` (trade stream reader used by the engine and the API) |
| `@mip/analytics`  | Pure math with no dependencies: `pctDiff`, `median`, `stdev`, `fairPriceMetrics`, `funding24h`, `bestFundingPair`, `sampleAt`, `oiChange`, `oiScenario`, `vwap`, `grossSpreadPct`, `profit`, `applyLastPrice`, `summarizeCandles`, `spreadPct` |
| `@mip/connectors` | Base layer (rate limiter, REST client, managed WS, subscription sharding, base connector, supervisor), one folder per exchange, CoinGecko client, `DepthFetcher`, `KlineFetcher`, `PUBLIC_REST` |
| `@mip/db`         | Prisma 7 schema, migrations, client factory (`pg` adapter), `signalRowToDto`                                                                                                                |

### Redis (no persistence; everything is rebuilt within seconds)

| Key                                     | Writer               | TTL / size                                             |
| --------------------------------------- | -------------------- | ------------------------------------------------------ |
| `mip:market:<ex>`                       | collector            | 60 s; readers treat a snapshot older than 5 s as stale |
| `mip:instruments`, `mip:universe`       | collector            | —                                                      |
| `mip:health:exchanges`                  | collector            | 10 s                                                   |
| `mip:proc:<name>`                       | each process         | heartbeat every 5 s, TTL 15 s                          |
| `mip:pause:<ex>`                        | collector and engine | until the ban ends                                     |
| `mip:signals:<scanner>`, `mip:scanners` | engine               | scanner status 15 s                                    |
| `mip:trades` (Stream)                   | collector            | MAXLEN ≈ 20,000 batches                                |
| `mip:sess:<id>`                         | api                  | session TTL (default 168 h)                            |
| channel `mip:events:settings`           | api                  | engine reloads settings                                |
| channel `mip:events:connection`         | collector            | —                                                      |

### PostgreSQL tables (`packages/db/prisma/schema.prisma`)

| Table                | Contents                                                             |
| -------------------- | -------------------------------------------------------------------- |
| `connection_events`  | WS/REST connection state changes                                     |
| `universe_snapshots` | Universe builds; the latest is reused at startup                     |
| `instruments`        | Registry, rewritten on each universe build                           |
| `signals`            | One row per signal lifecycle                                         |
| `scanner_settings`   | Per-scanner JSON settings plus `enabled`                             |
| `market_snapshots`   | 1 row per instrument per minute, fresh values only; retention 7 days |

Migrations: `init`, `universe_and_instruments`, `signals_and_settings`, `market_snapshots`.

## 4. Technology stack (versions in use)

- Node.js 22.22 (`>=22.12` required).
- TypeScript 7, ESM (`NodeNext`).
- npm workspaces (not pnpm, although Stage 1 proposed pnpm).
- Backend libraries: Fastify 5 with `@fastify/cookie` and `@fastify/websocket` 11.3.7, ioredis 6, pino 10, zod 4, `ws` 8, grammY 1.46 (the `Api` class only, send-only), Prisma 7.10.1 with `@prisma/adapter-pg`.
- Frontend: React 19 and Vite 8 (no router, no UI library, hand-written CSS).
- Tests: Vitest 5.
- Infrastructure: PostgreSQL 18 and Redis 8 in Docker Compose; nginx 1.29 serves the web build.
- No ESLint, no CI and no git hooks are set up. Prettier is the only formatter or linter.

## 5. Implemented features

**Data layer (Stage 3)**

- Seven connectors.
  - Each has a pure `parse.ts`, an `index.ts` that declares its capabilities and wires REST and WS, recorded real `fixtures/`, and tests that replay them end to end.
  - The field-by-field availability table is in `docs/stage-3-exchanges.md` §2.
- A normalised 12-field model. Each value is a `Field<T>`, either available or unavailable with a reason.
- Per-field freshness rules, connection-aware staleness, validation, and out-of-order protection within one connection.
- Universe: CoinGecko ranking with excluded categories, multiplier-aware mapping (`1000PEPE`, `kPEPE`) and a price-agreement check. It is stored in Postgres and has fallbacks.
- Rate limiting:
  - limiters are shared per exchange
  - Retry-After is honoured
  - bans persist across restarts via Redis
  - the engine and collector share ban state
- Live recovery test: all seven exchanges reconnected within 0.8–2.9 s. Two soaks (45 min and 24 min) passed.

**Scanners (Stage 4).** Formulas, defaults and message contents are in `docs/stage-4-scanners.md`.

| Scanner       | Interval | Notes                                                                                                                                                         |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fair Price    | 1 s      | last vs mark; executable-edge check against the book; risk level                                                                                              |
| Open Interest | 30 s     | 5 m / 30 m / 1 h / 4 h windows from per-minute snapshots; four price/OI scenarios                                                                             |
| Funding       | 15 s     | normalised to 24 h with each contract's real interval; extremes plus cross-exchange arbitrage pairs; last settled rate is observed from history               |
| Spread        | 2 s      | perp–perp; VWAP from on-demand order books; both taker fees and funding over the holding period; "preliminary" label; 5 % quarantine for implausible gaps     |
| TWAP / DCA    | 15 s     | Hyperliquid exchange-confirmed TWAPs (zero-hash slices plus `userTwapHistory`, up to 10 wallets); heuristic detector on all exchanges with a confidence score |

- Signal lifecycle: confirm → active (edits throttled) → resolved → cooling, with reopen inside the cooldown. Signals are restored from Postgres after a restart (7-day window, up to 5,000 rows), so nothing is announced twice.
- Telegram notifier:
  - one bot per scanner, posting with `message_thread_id`
  - paced at 1 message per 1.1 s and 18 per minute per bot
  - waits for `retry_after` on 429
  - merges pending edits and ignores "message is not modified"
  - checks tokens with `getMe`
  - a 401 or "chat not found" disables that bot with a reason
- Every scanner setting is stored in Postgres, validated with zod, editable through the API and applied within about 1 s.

**API routes** (all require a session except health and login):

- `GET /api/health`
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/system/status`, `GET /api/system/events?limit=`
- `GET /api/markets/:exchange`, `GET /api/universe`
- `GET /api/scanners`
- `GET /api/signals?scanner=&status=active|resolved&asset=&exchange=&limit=&before=`, `GET /api/signals/live`
- `GET /api/assets/:asset` (coin details)
- `GET /api/scanners/:id/settings` (with defaults and JSON Schema), `PUT /api/scanners/:id/settings` (nested objects merged)
- `GET /api/terminal/:exchange/:symbol?interval=`, `GET /api/terminal/:exchange/:symbol/candles?interval=&limit=&before=`
- `GET /ws` (realtime topics: `status`, `scanners`, `signals`, `events`, `markets:<ex>`, `asset:<code>`, `terminal:<ex>:<symbol>:<interval>`)

**Dashboard (Stage 5).** Details in `docs/stage-5-dashboard.md`.

- Login page; process badges; a **live / connecting / polling** badge for the WebSocket.
- Five scanner windows: status, key metrics (active, 24 h, checked, Telegram), warnings, main signals, latest updates, and **Filters / Settings / Details** buttons.
- View filters per window (exchange, pair, min 24 h turnover, scanner-specific min size), saved in the browser.
- Detailed view per scanner: sortable Active table with expandable per-scanner details, paginated History (server-side exchange/asset filter), Settings editor built from the JSON Schema.
- Coin view: live values on every exchange, open and recent signals, 24 h mark/OI sparklines.
- Exchange connection table with problems, connection event log, sortable market table with links to the coin view.
- Responsive down to phone width (checked at 375 px).

**Terminal (2026-11-20).** Details in `docs/terminal.md`.

- Page `#/terminal/<exchange>/<symbol>/<interval>` (hash routing; top-bar tabs Dashboard / Terminal; links from the market table and the coin view).
- TradingView Lightweight Charts 5.2.1 (Apache-2.0, attribution logo kept): candles and volume, 8 intervals, mark and index / oracle lines, log scale, crosshair legend, local-time axis, older pages on scroll.
- Header with live values and 24 h figures (last 24 hourly candles), exchange tabs with each exchange's last price, order book (12 levels, cumulative bars, spread), trades of at least `TRADES_MIN_NOTIONAL_USD` with Hyperliquid TWAP slices marked.
- View only: no order entry; a disclaimer on the page.

## 6. Project structure

```
apps/
  collector/src/   main.ts, market-state.ts, snapshots.ts, trades.ts, event-writer.ts, universe/{select,service}.ts
  engine/src/      main.ts, runner.ts, signals.ts, notifier.ts, format.ts, store.ts, settings.ts, view.ts,
                   history.ts, trades.ts, hl-twap.ts, scanners/{types,fair-price,open-interest,funding,spread,twap}.ts,
                   fixtures/market-view.json
  api/src/         main.ts, server.ts, auth.ts, sessions.ts, status.ts, markets.ts, scanners.ts, assets.ts, realtime.ts, terminal.ts
  web/src/         App.tsx, api.ts, hooks.ts, realtime.ts, route.ts, filters.ts, signalView.tsx, format.ts, styles.css,
                   components/{DashboardPage,ScannerWindow,ScannerDrawer,SignalDetails,SettingsForm,FilterBar,
                   AssetDrawer,Drawer,SortableTable,ExchangePanel,MarketPanel,EventsPanel,LoginPage,Badge,
                   TerminalPage,CandleChart,OrderBook}.tsx
packages/
  core/src/        config.ts, scanner-settings.ts, logger.ts, backoff.ts, process.ts, time.ts,
                   types/* (signal-data.ts holds the scanner payloads stored in SignalDto.data)
  bus/src/         keys.ts, redis.ts, heartbeat.ts, health.ts, market.ts, signals.ts, trades.ts, trade-feed.ts
  analytics/src/   basic.ts, fair-price.ts, funding.ts, open-interest.ts, spread.ts, candles.ts
  connectors/src/  base/*, supervisor.ts, registry.ts, public-rest.ts, coingecko/, depth/, klines/, test-support/,
                   {bybit,binance,mexc,hyperliquid,bitget,bingx,gate}/{parse.ts,index.ts,fixtures/,*.test.ts},
                   live.test.ts (opt-in), trades.test.ts
  db/              prisma/schema.prisma, prisma/migrations/, prisma.config.ts, src/{index,signals}.ts
tools/             dev.mjs, record.mjs, record-klines.mjs, record-trades.mjs, record-view.mjs, test-live.mjs
docker/nginx.conf  serves the web build and proxies /api and /ws to the api service
docs/              stage-1-analysis.md, stage-3-exchanges.md, stage-4-scanners.md, stage-5-dashboard.md,
                   stage-6-testing.md, deployment.md, deployment-proxmox.md, terminal.md
docker-compose.prod.yml, docker/Caddyfile, docker/backup.sh   production override (HTTPS, backups, log rotation)
tools/verify-live.ts, tools/soak.ts   read-only live verification and soak monitor (npm run verify / soak)
```

## 7. Current runtime state (checked 2026-11-18 about 05:55 local, UTC+7; Git, Docker and tests updated 2026-11-20 21:30)

- **Git:** `main` has two commits by the user ("v1") and a GitHub remote `origin`. The terminal, the Proxmox guide and the earlier Stage 6 doc edits are **uncommitted** in the working tree. `.env` is gitignored. Claude has not committed anything.
- **Docker stack** (`docker compose --profile app`, local, without the production override): api, engine and web rebuilt with the terminal on 2026-11-20 21:23; collector, postgres and redis unchanged. The dashboard is on `http://localhost:8080`. The engine restarted cleanly on the moved `TradeFeed` (251 signals restored, 333k trades replayed). API memory 89 MB.
- **Exchanges:** all seven `ok` and fully fresh, **including MEXC**: the user added WARP split-tunnel host exclusions for `contract.mexc.com` and `api.mexc.com`, and they apply to Docker Desktop containers (verified, 88/88).
  - Binance: the collector was restarted at 04:06 during a 418 ban on the shared WARP IP. It waited, sending nothing, until the ban ended at 05:45:49 and was `ok` again by 05:46:20 (87/87), by itself.
- **Telegram works.** All five bots are administrators of the forum group "Infinitick". The user replaced the TWAP bot (the old one returned 502 for every call). From 03:56 to about 05:55: 39 messages sent, 0 failed (open interest 10, funding 4, spread 2, TWAP 23). That includes edits after significant changes and "resolved" edits. **Not yet seen:** a fair-price message (no fair-price signal since the fix), so that topic ID is unconfirmed.
- **`.env`** (names only; values must never be printed): Telegram chat ID (corrected; the old value is kept as a comment), five tokens and five topic IDs. No exchange keys, no CoinGecko key, no MEXC overrides. `POSTGRES_PASSWORD` is the default `mip`, and `COOKIE_SECURE=false`; the API warns about both, which is fine locally.
- **Tests:** 336 passed and 7 skipped (opt-in live tests), in 40 files. `npm run typecheck` and `prettier --check .` are clean.
- **Soak on this PC** (04:09–05:54, `docs/stage-6-testing.md` §5): no sampling gaps; six exchanges `ok` in 210/210 samples; no process restart (except a deliberate API restart); no stalled scanner; `/api/health` p50 6 ms. **Collector memory rose 154 → 318 MB**, at a slowing rate (127 → 44 MB/h with constant instruments). Engine, API and PostgreSQL levelled off. Likely heap warm-up, but this must be confirmed on the 24 h server soak.
- **Dev network:** Cloudflare WARP (consumer client 2026.7, mode `Warp`); split tunnel excludes the default private ranges plus the two MEXC hosts. The PC slept from 01:03 to 02:43 (100-minute gap in the snapshots). The quirks are listed in CLAUDE.md.

## 8. Recent changes and decisions (with reasons)

| Decision                                                                                                                                             | Reason                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal candles and order books are requested by the **API** from the exchanges' public REST APIs, only while an instrument is open, throttled per instrument (book 2 s, newest candles 10 s and at candle close, 24 h figures 60 s) | A WebSocket kline and depth client for seven exchanges would be a large new subsystem; on-demand REST through the shared limiters costs a few requests per minute per open chart and honours bans (`mip:pause:<ex>`). |
| The forming candle follows the live last price between syncs; it never opens a new candle by itself and keeps the exchange's volume | No invented OHLCV: the exchange's own candle replaces it at the next sync. |
| The trade list shows the collector's trade stream (at least `TRADES_MIN_NOTIONAL_USD`), labelled as filtered, instead of polling recent-trade endpoints | WebSocket-sourced and already in Redis; seven more REST endpoints would be needed otherwise. |
| `TradeBuffer` / `TradeFeed` moved from the engine to `@mip/bus`; `PUBLIC_REST` / `createPublicRestClient` extracted from `DepthFetcher` | The API reuses them instead of copying; one place for public REST hosts and limits. |
| A failed order-book refresh shows no book (with the reason); candles already loaded stay | An old book would look current; candles are history and stay true. |
| Hash routing (`#/terminal/…`) and TradingView Lightweight Charts 5.2.1 | No router or server routes needed, shareable links; the library is small (Apache-2.0) and gives the requested TradingView look. |
| Production = base compose + `docker-compose.prod.yml` (Caddy for HTTPS, backup service, log rotation, forced `COOKIE_SECURE`), not a separate stack  | One stack definition; the override only adds what a server needs. Only Caddy is public.                                                                       |
| Backups exclude `market_snapshots` data by default (`BACKUP_INCLUDE_SNAPSHOTS`)                                                                      | Snapshots are a 7-day rolling window that refills by itself and most of the database (47 of 58 MB); settings, signals and the universe are what must survive. |
| Retention: connection events 30 days (collector), resolved signals 90 days with a minimum of 8 (engine), both purged hourly                          | Both tables grew without bound; restarts restore 7 days of signals for cooldowns.                                                                             |
| Telegram retries 5xx and failed connections (3 times: 2, 4, 8 s), never a timed-out request                                                          | A 502 lost messages for good; a timed-out send may have been posted, and a duplicate is worse than a missed edit.                                             |
| Weak production settings produce startup warnings (`apiSecurityWarnings`) instead of refusing to start                                               | Docker sets `NODE_ENV=production` locally too; refusing would break the local stack, which legitimately has no HTTPS.                                         |
| Verification and soak tools import the workspace packages (tsx), and are read-only                                                                   | No duplicated key names or formulas; safe to run on a live server.                                                                                            |
| Realtime: the API re-reads each followed topic every 1–5 s and pushes only changes; each topic carries the same payload as a REST route              | The collector already rewrites Redis every second; a second publishing path would add code without lowering latency. REST stays the fallback.                 |
| WS auth closes the socket with 4401 (no session) or 4403 (foreign Origin) after the upgrade instead of rejecting the handshake                       | Browsers cannot read a failed handshake's HTTP status; a close code lets the dashboard log out instead of retrying forever.                                   |
| The settings form is generated from `settingsJsonSchema()` (zod → JSON Schema); labels and units live in the web app                                 | Types and bounds stay defined once, in `scanner-settings.ts`.                                                                                                 |
| `PUT` settings merges nested objects (`mergeSettings`)                                                                                               | A partial `thresholds` / `takerFees` update used to reset the omitted keys to defaults.                                                                       |
| Signal payload types (`FairPriceData` and the others) moved to `@mip/core/types/signal-data.ts`; the engine re-exports them                          | The dashboard renders them and may only import `@mip/core/types`.                                                                                             |
| `DepthFetcher` fails at once while the exchange's REST is paused, and after 10 s otherwise                                                           | During a Binance ban the spread scanner waited on the paused limiter and blocked the whole engine tick for the length of the ban (found live on 2026-11-18).  |
| A disabled scanner's open signals resolve after `resolveAfterSec`                                                                                    | They stayed "active" for as long as the scanner was off.                                                                                                      |
| Telegram requests time out after 20 s                                                                                                                | grammY's default is 500 s; one hanging `getMe` held up engine startup for minutes.                                                                            |
| A REST snapshot only fills gaps in fields a live WS maintains, and expires after 30 s (`REST_SNAPSHOT_MAX_AGE_MS`)                                   | The 15-min re-sync relabelled stream fields as REST, and they aged out. MEXC looked "fresh" from REST while its WS was down.                                  |
| The out-of-order guard compares timestamps only within one connection                                                                                | REST response time and WS "last changed" time are not comparable; comparing them discarded fresh data.                                                        |
| Change-driven freshness is tracked per connection (`seenAt[conn]`)                                                                                   | One busy stream must not vouch for a silent one.                                                                                                              |
| Binance uses top-5 depth every 500 ms, not bookTicker                                                                                                | bookTicker sent ~1,000 messages/s for 3 symbols.                                                                                                              |
| Exchange bans are persisted in `mip:pause:<ex>` and also honoured by the engine                                                                      | Binance stretched a WARP ban from 81 min to 5.7 h because restarts kept sending requests.                                                                     |
| MEXC REST defaults to the documented `api.mexc.com`; `MEXC_REST_URL` / `MEXC_WS_URL` can override it                                                 | `contract.mexc.com` returns 403 from WARP exits.                                                                                                              |
| Universe startup uses the stored ranking at once and refreshes in the background if it is outdated; the refresh skips connectors that aren't running | CoinGecko keyless 429s blocked collector startup.                                                                                                             |
| Universe price check is against the cross-exchange median and against CoinGecko (50 % tolerance when CoinGecko data is over 1 h old)                 | A stale CoinGecko price rejected a valid mapping.                                                                                                             |
| TWAP progress uses `elapsedPct` plus observed slices while active; the exchange's executed size is used only at a final state                        | Hyperliquid reports execution only when the order finishes; "0 % executed" was wrong.                                                                         |
| The dashboard shows "loading" until the first status response (`engineAlive` / `collectorAlive` are `null`)                                          | It showed "engine down" while loading.                                                                                                                        |
| Per-minute snapshots use Prisma `createMany` plus `deleteMany` retention, with no partitions and no raw SQL                                          | ~700 instruments give about 1 M rows a day, which no longer needs Stage 1's partitioning plan.                                                                |
| Hand-written parsers on the hot path; zod only for config, settings and REST                                                                         | About 2,500 updates/s.                                                                                                                                        |
| Signals are processed per evaluation, with deduplication by `key`                                                                                    | One open signal per key; cooldown reopens the same message.                                                                                                   |
| Spread fees are base-tier defaults, so every spread is labelled _preliminary_                                                                        | Account fee tiers are unknown (no keys).                                                                                                                      |

## 9. Known bugs, issues and limitations

### Open

1. **Universe overrides are in code, not configuration** (`OVERRIDES` in `apps/collector/src/universe/select.ts`: aliases, excluded ids and a volume-mode stablecoin list).
2. **A Telegram bot disabled by "chat not found" stays disabled until the engine restarts.** This is intended (no retry storm), but after fixing the chat the engine must be restarted.
3. **A collector restarted during an exchange ban keeps that exchange offline until the ban ends**, because it needs REST to load the instrument list. Intended (requests during a ban extend it); documented in docs/deployment.md.
4. **Stale wording in the docs:** `stage-3-exchanges.md` says trades are "not subscribed in Stage 3 (Stage 4.5)", but they are subscribed. Stage 1 proposes pnpm, raw-SQL bulk writes and daily partitions; none of these were adopted.
5. **The web app has no automated tests.** It was checked by hand in the browser (Stage 5 list below, the polling fallback in Stage 6, and the terminal on 2026-11-20).
6. **BingX candle volume unit is inferred** (base units; not documented). Shown as a note under the terminal chart.

### Fixed in Stage 6

- No retention for `signals` and `connection_events` (now 90 and 30 days, configurable).
- The engine ignored `MEXC_REST_URL` for order books.
- Telegram 5xx and connection failures lost messages (now retried).
- CLAUDE.md and the coin view said to multiply prices by the multiplier; the code divides prices (and multiplies sizes), which is correct; the texts are fixed.

### Fixed in Stage 5

- A disabled scanner froze its open signals; they now resolve.
- `PUT` settings merged shallowly; nested objects now merge.
- The engine tick blocked for the length of an exchange ban; order-book fetches now fail fast.
- Telegram `getMe` could hold up engine startup; it now times out after 20 s.
- The README's "Stage 3 state" and "empty until Stage 4" wording.

### Terminal checked in the browser (2026-11-20, local dev API and web against the Docker stack, throwaway test login)

- Bybit BTCUSDT 5m; Hyperliquid ETH 1h (USDC, Oracle line, five-significant-figure prices, TWAP slices marked); Bybit 1000PEPEUSDT 15m at 375 px (no horizontal scroll, `×1000` on the exchange tabs); Gate BTC_USDT 1m (older page loaded on scroll); MEXC ETH_USDT order book (contracts converted to ETH).
- Links from the market table and the coin view; the Dashboard tab is unchanged. No console errors after login; no API warnings or errors.
- Production images rebuilt; `/api/terminal/...` answers 401 without a session through nginx. **Not done:** logging in to `localhost:8080` itself (the real dashboard password was not used), the polling fallback on the terminal page, a real exchange ban while the terminal is open (unit-tested only).

### Checked in the browser (2026-11-18, Docker stack, desktop 1440 px and phone 375 px)

- The WebSocket connects (badge **live**). Windows, metrics, main signals and latest updates update without a reload.
- Spread Details: the Active table, and row expansion with the profit breakdown and the "preliminary" reasons (Binance book unavailable during the ban, default fees).
- The Settings tab renders every group. An out-of-range value is blocked by the schema bound and nothing is saved; Discard restores the stored values. A real save was **not** done in the browser; the API tests cover it.
- Funding History: 16 resolved signals, sorting, end of history.
- Coin view (XMR): six exchanges, stale Binance REST fields labelled, open and recent signals, 24 h sparklines.
- No console errors.
- Stage 6: **polling fallback** with every WebSocket failing (stubbed in the tab, API restarted): badge **polling**, data kept refreshing over REST every 2 s. After the stub was removed, it was back to **live** within 16 s.

### Environment and data limitations (known, documented)

General dev-machine quirks (WARP, Binance 418, sleep, clock offset) are in CLAUDE.md. Their current effect:

- **No 24 h soak has been run**, because the PC sleeps. It belongs on the server (`npm run soak -- --minutes 1440`).
- **Verified live in Stage 6** (`npm run verify`): the 4 h OI window is covered, funding settlements are observed (86 of 146 legs), and every signal recomputes exactly. Telegram delivery, edits and the resolved edit work (§7).
- **Not verified:** Caddy with a real certificate (needs a domain); the fair-price Telegram topic (no signal yet); collector memory beyond 105 minutes.
- **Not collected:** long/short ratio. **Not available:** MEXC bid/ask sizes; BingX max leverage (not public); Binance max leverage (needs a key; signing is unit-tested but has never run live).
- **Inferred or unconfirmed:**
  - BingX OI unit (treated as USDT notional ÷ mark)
  - whether Bitget `holdingAmount` is one side
  - MEXC per-connection subscription limit (50 topics used)
  - whether Gate's WS honours `X-Gate-Size-Decimal`
  - absolute OI is not comparable across exchanges until the Bitget and BingX conventions are confirmed
- **Redis has no persistence.** Restarting Redis logs everyone out and empties the trade stream, so an engine started afterwards has no trades to replay.

## 10. Pending user actions and requests

1. **Server:** the user's target is a home Proxmox server. Follow docs/deployment-proxmox.md (VM, Docker, git, `.env`, SSH tunnel / LAN / Tailscale / public HTTPS); stop the PC stack first so Telegram messages are not sent twice. Then run `npm run verify` and the 24 h soak there.
2. **Commit:** never requested. If asked, create a feature branch first (`main` has no commits).
3. Optional: read-only exchange keys (Binance max leverage; account fee tiers would make spreads non-preliminary); a CoinGecko key (faster universe builds).
4. Done in Stage 6: MEXC excluded from WARP by the user (verified); Telegram chat ID fixed and the TWAP bot replaced by the user. The user asked Claude to change the WARP setting; Claude does not change system network settings, so the user ran the `warp-cli` commands.

## 11. TODO

### Stage 6 leftovers (need the server)

- 24 h soak (`npm run soak -- --minutes 1440`) and `npm run verify` on the server. Watch the collector's second-half memory growth rate in the summary: near zero = warm-up; steady = leak (take a heap snapshot).
- Caddy certificate for the real domain; dashboard over HTTPS.
- Telegram: first fair-price message (topic ID); the user confirming messages land in the right topics.
- Copy backups off the server (depends on the hosting).

### Other open items

- Universe overrides into configuration (§9.1). Web component tests (Vitest + jsdom) for the filters and the settings form.
- Account fee tiers for the spread scanner (needs read-only keys).
- Confirm the BingX / Bitget OI units.
- Long/short ratio, if wanted.
- OI backfill from exchange history endpoints, to shorten warm-up.

## 12. Next steps (suggested order)

1. Ask whether to commit the terminal and the Stage 6 doc edits (on a feature branch; `main` is the default branch).
2. Deploy on the home Proxmox server (docs/deployment-proxmox.md), then `npm run verify` and a 24 h soak there; record the results in docs/stage-6-testing.md.
3. Confirm the fair-price Telegram topic once that scanner opens a signal.

## 13. Important technical details and nuances

Units, formulas, the staleness rule, the Windows migration workaround, the Docker rebuild and recreate rules, and the WARP quirks are permanent rules, so they are in [CLAUDE.md](CLAUDE.md). This section covers how the current implementation behaves.

- **Starting the engine:**
  - It replays the last hour of trades from `mip:trades` and loads 9 h of `market_snapshots` into memory.
  - It restores open and cooling signals.
  - It reads persisted bans and pre-pauses the shared limiters.
- **Exchange traffic from the engine:** order books on demand (`DepthFetcher`, 50 levels, cached 5 s, never requested while that exchange's REST is paused, at most 10 s per book) and a Hyperliquid WS for TWAP history. Bans hit both processes.
- **Collector startup order:** load markets → select universe symbols → set tracked → forward bootstrap updates → start streams.
- **Universe refresh:** daily (`UNIVERSE_REFRESH_HOURS`); only running connectors; 60 s timeout each. Without a CoinGecko key the first build takes about 90 s (5 calls per 65 s).
- **Signal mirror in Redis:** `mip:signals:<scanner>` holds `active` plus up to 50 `recent` resolved signals. It is rewritten only when the scanner's state changed (`takeDirty`). Active signals in Postgres can lag by up to 30 s, which is why the API reads active signals from Redis and history from Postgres.
- **Realtime hub:** one read per topic per interval regardless of how many clients follow it, and only while someone does. Unchanged payloads are not re-sent. `status` always changes (`serverTime`), so it is pushed every second. Coin-view history is cached for 60 s per asset.
- **Dashboard state in the browser:** window filters (`mip.filters.v1`) and the market-table sort (`mip.marketSort.v1`) are kept in `localStorage`; everything works without it.
- **Verification tools:** `npm run verify` exits 1 on a hard failure (price gap > 5 %, signal mismatch, an exchange reported ok with a stale snapshot). `npm run soak` writes `soak/<start>.jsonl` and `soak/<start>-summary.md` (gitignored); sampling gaps in the summary mean the machine slept.
- **Production warnings:** the API logs `insecure setting: …` lines at startup (never the values).
