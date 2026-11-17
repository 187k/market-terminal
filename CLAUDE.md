# CLAUDE.md

These are the standing instructions for working on this repository.

Other documents:

- [HANDOFF.md](HANDOFF.md): current state, open issues and next steps. Read it first in a new session.
- [prompt.md](prompt.md): the specification.
- [README.md](README.md) and [docs/](docs/): design and per-stage details.

## Project

**Crypto Market Intelligence Platform.**

- Real-time market data for crypto perpetuals from seven exchanges: Bybit, Binance, MEXC, Hyperliquid, Bitget, BingX and Gate.
- The data is normalised into one model.
- Five analytical scanners run on it: Fair Price, Open Interest, Funding Rate, Cross-Exchange Spread and TWAP/DCA.
- Each scanner posts to its own Telegram bot and topic.
- A dark React dashboard shows everything.

Work is done in stages (`prompt.md` §8). Run the tests and verify the result after each stage.

## Non-negotiable rules

1. **Analytics only.** Never implement placing, amending or cancelling orders, transfers, or withdrawals. Never call a private trading endpoint. Exchange keys are optional and **read-only**; use them only for endpoints that require a key (Binance max leverage, account fee tiers).
2. **No fictitious data.** Missing data is `Field<T>` unavailable with a reason (`packages/core/src/types/availability.ts`), or `null` with an explanation. Never fill gaps, interpolate, or assume defaults that could pass for real data. An "unknown" shown honestly beats a plausible guess.
3. **No invented API capabilities.** Use only documented endpoints. Where an undocumented behaviour is relied on, label it `[O]` in the docs, give it a fallback, and state it in the scanner output.
4. **Label confirmed vs assumed.** Exchange-confirmed data (for example a Hyperliquid TWAP) and heuristics (with a confidence score) must be visibly different. LONG / SHORT / BUY / SELL are analytical directions and never recommendations, and every Telegram message says so.
5. **No duplicated business logic.**
   - Calculations live in `@mip/analytics` as pure functions with unit tests.
   - Shared types and settings schemas live in `@mip/core`.
   - Redis key names live only in `@mip/bus/keys.ts`.
6. **Everything important is configurable without code changes.**
   - Infrastructure and secrets go in env variables, validated by zod in `packages/core/src/config.ts` and documented in `.env.example`.
   - Scanner thresholds and filters go in the DB, using the zod schemas in `packages/core/src/scanner-settings.ts` with defaults.
7. **Respect exchanges.** Use the shared per-exchange rate limiters. Honour Retry-After and bans; bans persist in `mip:pause:<ex>`. Never add retry loops on 4xx, and never send requests during a ban. Use WebSocket first and REST only for bootstrap, gaps and periodic sync. Code on the engine tick (scanners) must never wait for a paused limiter: fail fast and report the data as missing (see `DepthFetcher`), because one wait blocks every scanner for the length of the ban.
8. **Don't rewrite working components without need** (spec working rule 9). Keep the architecture simple.

## Business and financial rules

**Units.** These are fixed in `packages/core/src/types/market.ts`; never mix them:

- Prices are quote currency per contract **base unit**. `InstrumentInfo.multiplier` is asset units per base unit: **divide** a price by it and **multiply** a size by it to get per-asset values (1000PEPE: price ÷ 1000, size × 1000; see `legOf` in the spread scanner).
- Sizes and open interest are in base units. **OI is one side.**
- Funding is a fraction per interval. `fundingIntervalHours` is the contract's live interval; never assume 8 h.
- Times are Unix ms.

**Formulas.** The spec formulas are implemented in `@mip/analytics`:

- deviation % = (last − mark) / mark × 100. Below mark means LONG, above means SHORT. Fair vs index = (mark − index) / index × 100.
- OI change % = (current − previous) / previous × 100, measured on base units against the snapshot nearest _t − window_. Never interpolate.
- funding 24 h = rate × 24 / intervalHours.
- Spread: buy at the cheaper venue's ask and sell at the dearer venue's bid. Use VWAP from real order books for the position size. Subtract both taker fees, then funding over the holding period, to get net.
  - Gross and net are reported separately.
  - A result is labelled **preliminary** whenever fees are defaults, books are missing or thin, or funding is missing.
  - Compare only compatible instruments: perp vs perp, multiplier-normalised, and quotes flagged when they are mixed USDT and USDC.

**Exchange differences.** Hyperliquid quotes in USDC and has an oracle price, not an index (`indexKind: 'oracle'`). Show these differences; don't hide them.

**Staleness.** A stale, missing or invalid value must never produce a signal.

## Architecture

Processes:

| Process          | Responsibility                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/collector` | Connectors, universe, live state and freshness. Publishes to Redis every 1 s. Writes per-minute snapshots and connection events to Postgres. Forwards trades to a Redis Stream.                                             |
| `apps/engine`    | Market view, then the scanners, then the `SignalEngine` (lifecycle, deduplication, cooldown), then Postgres, Redis and the `TelegramNotifier`. Also makes on-demand order-book calls and runs the Hyperliquid TWAP watcher. |
| `apps/api`       | Fastify REST API and the single-user cookie session. Reads Redis and Postgres.                                                                                                                                              |
| `apps/web`       | React + Vite dashboard (nginx in Docker).                                                                                                                                                                                   |

Packages:

| Package               | Contents                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/core`       | Types (`@mip/core/types` is browser-safe: no Node imports), config, settings schemas, logger, backoff, shutdown |
| `packages/bus`        | Redis client, keys and channels, typed read/write helpers                                                       |
| `packages/analytics`  | Pure math with no I/O and no dependencies                                                                       |
| `packages/connectors` | Base layer, supervisor, registry, per-exchange folders, CoinGecko, depth                                        |
| `packages/db`         | Prisma schema, migrations and client                                                                            |

**Dependency rules:**

- Connectors know nothing about scanners.
- Scanners depend only on `MarketView` (`apps/engine/src/view.ts`), `@mip/analytics` and `@mip/core`.
- The web app imports only `@mip/core/types`.
- Business logic stays out of UI components and API routes.

**Adding an exchange:**

1. Create `packages/connectors/src/<ex>/`:
   - `parse.ts`: pure normalisation
   - `index.ts`: connector plus `*_CAPABILITIES`
   - `fixtures/`, recorded with `npm run record -- <ex>`
   - tests
2. Add one entry in each map in `registry.ts`.
3. Add the id to `EXCHANGE_IDS`.
4. Add an order-book config in `depth/index.ts`.
5. Add a default fee in `DEFAULT_TAKER_FEES`.

**Adding a scanner:**

1. Add the id to `SCANNER_IDS` / `SCANNERS`.
2. Add a settings schema in `scanner-settings.ts` and register it in `SCANNER_SETTINGS_SCHEMAS`.
3. Create `apps/engine/src/scanners/<id>.ts` implementing `ScannerDefinition`, and register it in `apps/engine/src/main.ts`.
4. Add the Telegram env vars in `config.ts`, `TELEGRAM_ENV_PREFIX` and `.env.example`.
5. Dashboard: put the signal payload type in `packages/core/src/types/signal-data.ts`; add the scanner to `headline`, `SCANNER_COLUMNS`, `SIZE_METRIC`, `exchangesOf` and `turnoverOf` in `apps/web/src/signalView.tsx`, a section in `SignalDetails.tsx`, and labels for new settings in `META` in `SettingsForm.tsx`. The window itself is generic.

**Adding a workspace package:** update the root `package.json` (workspaces and build order), `vitest.config.ts` aliases, and the `Dockerfile` (both the `package.json` COPY and the `dist` COPY).

## Coding style

- TypeScript strict, with `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (use `import type`) and ESM `NodeNext`. Relative imports carry a **`.js` suffix**.
- Prettier: 110 columns, single quotes, trailing commas, LF line endings. Indentation is 2 spaces (`.editorconfig`). Run `npm run format` before finishing.
- Use `#private` class fields. Keep functions small and pure where possible. Inject `now` for testability instead of calling `Date.now()` deep inside logic.
- Use hand-written parsers on the hot path (thousands of updates/s); zod is for config, settings, request bodies and REST payloads.
- Logging: pino child loggers with `component` / `exchange` / `scanner`. Log once per outage, not once per retry. **Never log secrets** (the logger redacts known keys; don't defeat it).
- Comments explain _why_ (exchange quirks, units, decisions). JSDoc on exported types and settings fields; settings JSDoc doubles as documentation.
- Tests sit next to the code as `*.test.ts` (Vitest). Exchange fixtures are **recorded real payloads, never hand-made**; do not edit them by hand. Tests must not reach real exchanges, except `live.test.ts`, which is opt-in via `npm run test:live`.
- User-visible text (dashboard, Telegram, docs): plain, specific English.

## Database (PostgreSQL + Prisma 7)

- The schema is `packages/db/prisma/schema.prisma`. The DB URL comes from `packages/db/prisma.config.ts` (Prisma 7 does not read it from the schema). The generated client lives in `packages/db/src/generated/` (gitignored), and `npm install` and `npm run db:generate` regenerate it.
- Change the schema only through a new migration. Never edit an applied migration. On Windows create migrations from Git Bash: `cd packages/db && npx prisma migrate dev --name <name>`. PowerShell drops `--name` and Prisma hangs.
- Column types: timestamps are `@db.Timestamptz(3)`. `BigInt` ids become strings in DTOs (see `signalRowToDto`).
- **High-frequency data does not go to Postgres.** Live values stay in memory and Redis. Postgres gets batched writes (per-minute snapshots, connection events, signal changes; unchanged active signals at most every 30 s). Every growing table has a retention setting (`MARKET_SNAPSHOT_RETENTION_DAYS`, `CONNECTION_EVENT_RETENTION_DAYS`, `SIGNAL_RETENTION_DAYS`); a new time-series table needs one too, purged hourly by the process that writes it.
- Scanner settings are JSON validated by `parseScannerSettings`.
  - Unknown keys are dropped and missing keys get defaults, so a new setting only needs a schema field with a default.
  - An invalid stored value falls back to the default and is reported as a scanner warning.

## Redis

- All keys and channels are defined in `packages/bus/src/keys.ts`. Never write a raw key string anywhere else.
- Redis runs **without persistence**. Store only what can be rebuilt within seconds (live state, heartbeats, sessions, signal mirrors, trade stream, ban pauses). Anything that must survive goes to Postgres.
- Readers must treat a market snapshot older than `SNAPSHOT_MAX_AGE_MS` (5 s) as stale (`withReaderFreshness`).

## API (Fastify)

- Routes live under `/api`. Every route except `/api/health` and `/api/auth/login` uses `preHandler: requireAuth`.
- Errors are `{ error: code, message }`. Validation failures return 400, adding `problems: string[]` where useful.
- Clamp `limit`-style query values and validate ids (`isExchangeId`, `isScannerId`).
- Request and response types shared with the web app go in `packages/core/src/types/` (`api.ts`, `signals.ts`). Keep them browser-safe.
- Routes depend on small source interfaces (`StatusSource`, `MarketSource`, `ScannerSource`) so they can be tested without Redis or Postgres (`server.test.ts`).
- Settings changes go through `PUT /api/scanners/:id/settings`. It validates, upserts, then publishes `mip:events:settings`, and the engine applies the change within about 1 s.
- `/ws` is the dashboard realtime socket (`apps/api/src/realtime.ts`). Every topic delivers exactly the payload of a REST route, because the dashboard polls that route while the socket is down. Add topics in `topicResolver` (`server.ts`); protocol types live in `packages/core/src/types/api.ts`. Close codes: 4401 = log in again, 4403 = foreign Origin.
- The settings form is generated from `settingsJsonSchema()`, so types and bounds stay in `scanner-settings.ts`. `PUT` settings deep-merges nested objects (`mergeSettings`).
- Dashboard state that is only a viewer convenience (filters, sort order) may use `localStorage`, guarded with try/catch; anything that must persist goes through the API.

## Security and secrets

- Secrets live only in `.env` (gitignored) or the container environment. **Never print `.env` values**: dashboard password, session secret, Telegram tokens, API keys. Refer to variables by name. To check whether something is set, print names with `<set>` / `<empty>`.
- Never ask the user to paste keys into chat; they go into `.env`. Exchange keys must have no trade or withdrawal permission.
- Published Docker ports bind to `127.0.0.1`. Set `COOKIE_SECURE=true` only behind HTTPS.
- Test credentials may be entered only into the app on localhost.

## Run, test, build

```bash
npm install                  # also generates the Prisma client
npm run infra:up             # Postgres on 127.0.0.1:5433, Redis on 127.0.0.1:6379
npm run db:deploy            # apply migrations
npm run dev                  # collector + engine + api + web (http://localhost:5173); `npm run dev -- api web` for a subset
npm test                     # Vitest, all workspaces (live tests skipped)
npm run test:live            # opt-in, real exchanges, public endpoints; `-- bybit gate` for a subset
npm run typecheck            # every workspace
npm run build                # compile to dist/ in dependency order
npm run format               # Prettier (format:check to verify)
npm run verify               # read-only check of the running system: prices, fields, every signal recomputed
npm run soak -- --minutes 60 # sample health, resources, Telegram outcomes; summary in soak/
docker compose --profile app up -d --build   # full stack on http://localhost:8080
docker compose --profile app up -d --build engine   # rebuild one service after code changes
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build   # production (docs/deployment.md)
```

- After editing `.env`, recreate the container: `docker compose --profile app up -d <service>`. `restart` keeps the old environment.
- `tools/verify-live.ts` and `tools/soak.ts` run with tsx and import the workspace packages (`@mip/bus` readers, `@mip/analytics` formulas), so they hold no key names or formulas of their own. Keep it that way. They must stay read-only: no exchange or Telegram traffic.
- Fixture tools: `npm run record -- <exchange> [seconds]` (REST and WS payloads), `node tools/record-trades.mjs [seconds]` (trade messages), and `node tools/record-view.mjs` (the engine's market view; reads the Docker Redis `mip-redis-1`, so the collector must be running in Docker).
- The internal packages resolve to TypeScript sources through the `source` export condition (dev and tests) and to `dist/` in production. Tests and dev never need a build.
- Before calling work done, run `npm test`, `npm run typecheck` and `npm run format:check`, and verify behaviour in the running app when it is user-visible.

## Development environment quirks

- This dev PC routes through **Cloudflare WARP**:
  - Binance may return **418 bans** on shared exit IPs. These are not caused by our request volume; wait them out and never hammer.
  - MEXC `contract.mexc.com` returns 403 from WARP exits. MEXC works without WARP from this network, so the preferred fix is a WARP split-tunnel host exclusion for `contract.mexc.com` and `api.mexc.com` (a system setting the user applies); `MEXC_WS_URL` (dev only) is the fallback.
- The PC **sleeps when idle**, so long soaks belong on the server.
- The local clock is about 0.25 s behind the exchanges. Freshness uses local receive times, so it is unaffected; the dashboard's "Delay" column includes the offset.
- The shell is Windows PowerShell 5.1 (no `&&`). Git Bash is available for POSIX commands.
- Prettier sometimes needs two passes on `apps/api/src/server.ts` before `format:check` passes.

## Files that need special care

| File                                                                              | Why                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/collector/src/market-state.ts`                                              | Freshness, validation and out-of-order rules. Subtle; each rule exists because of a live bug. Change only with a test.                                                                                        |
| `packages/connectors/src/*/parse.ts`, `*/index.ts` (`*_CAPABILITIES`)             | Unit conversions per exchange (multipliers, contract sizes, one-side OI, notional ÷ mark). Capabilities drive staleness.                                                                                      |
| `packages/connectors/src/base/rate-limiter.ts`, `rest-client.ts`, `supervisor.ts` | Ban and rate-limit behaviour. A mistake gets the IP banned for hours.                                                                                                                                         |
| `apps/collector/src/universe/select.ts`                                           | Instrument mapping and the price check. Wrong mappings create false spreads.                                                                                                                                  |
| `apps/engine/src/signals.ts`                                                      | Signal lifecycle; restarts must never re-announce.                                                                                                                                                            |
| `apps/engine/src/notifier.ts`                                                     | Telegram pacing and limits.                                                                                                                                                                                   |
| `packages/core/src/scanner-settings.ts`                                           | Defaults and bounds for every scanner. Changing a default changes live behaviour.                                                                                                                             |
| `packages/core/src/config.ts` and `.env.example`                                  | Keep them in sync.                                                                                                                                                                                            |
| `packages/bus/src/keys.ts`                                                        | Shared by every process.                                                                                                                                                                                      |
| `packages/db/prisma/schema.prisma` and migrations                                 | Migrations only.                                                                                                                                                                                              |
| `Dockerfile`, `docker-compose.yml`, `docker/nginx.conf`                           | Per-package COPY lines; ports bound to localhost.                                                                                                                                                             |
| `docker-compose.prod.yml`, `docker/Caddyfile`, `docker/backup.sh`                 | Production: only Caddy is public; required `DOMAIN` / `POSTGRES_PASSWORD`; backups exclude snapshot data by default. Validate with `docker compose -f … -f … config --quiet` (plain `config` prints secrets). |

## Git and documentation

- Commit or push **only when the user asks**. When on `main`, create a branch first.
- When behaviour, settings or data sources change, update the matching doc: `README.md`, `docs/stage-*.md`, `.env.example`.
- Keep `HANDOFF.md` current at the end of a stage or significant change. This file holds only lasting rules.
- Record exchange findings with their evidence tags: [L] live, [D] documented, [O] observed but undocumented, [?] unverified.
