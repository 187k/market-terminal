# Stage 1 — Technical Analysis and Design

Date: 2026-11-16. Status: **scope decisions recorded in section 9.** Stages 2 and 3 are built; the [?] items below are resolved or re-assessed in [stage-3-exchanges.md](stage-3-exchanges.md) (sections 5–6), which also holds the field availability table as implemented.

Sections 1–8 describe the full market (~5,400 instruments). Section 9 records the decisions that narrow the first version and what they change.

## 0. How this was verified

| Tag | Meaning |
|---|---|
| **[L]** | Verified live: an unauthenticated REST call or WebSocket subscription was made from this machine on 2026-11-15/16 and the real response inspected. |
| **[D]** | Stated in the exchange's official documentation (read on 2026-11-16). |
| **[O]** | Observed live but not documented (may change without notice). |
| **[?]** | Not verified. Must be checked in Stage 3 before anything relies on it. |

Scope of the live checks: USDT-margined perpetuals on all seven exchanges (REST + WebSocket). All seven were reachable from this machine without authentication. WebSocket probes ran for ~9 seconds each, so they prove channels and payloads, **not** long-run stability.

Not verified in this stage: spot market data (except where noted), Bitget's newer UTA (v3) public API, behaviour over 24 h+, behaviour from other network regions.

---

## 1. Data availability by exchange (USDT perpetuals)

Legend: **WS** = pushed over WebSocket · **REST** = polling only · **bulk** = one call returns all symbols · **per-sym** = one call per symbol · **❌** = not available from public API · **🔑** = exists but needs an API key.

| Metric | Bybit | Binance | MEXC | Hyperliquid | Bitget | BingX | Gate |
|---|---|---|---|---|---|---|---|
| Last price | WS [L] | WS [L] | WS [L] | WS (trades / mid) [L] | WS [L] | WS [L] | WS [L] |
| Mark / fair price | WS [L] | WS, all symbols in one stream [L] | WS `fairPrice` [L] | WS `markPx` [L] | WS [L] | WS per-sym (1 s) or REST bulk [L] | WS [L] |
| Index price | WS [L] | WS [L] | WS [L] | **No index.** `oraclePx` is the analogue [L][D] | WS [L] | **REST only** (bulk `premiumIndex`); the WS mark stream carries mark only [L] | WS [L] |
| Best bid / ask | WS [L] | WS, all symbols in one stream [L] | WS per-sym; REST bulk [L] | WS per-sym `bbo` [L] | WS [L] | WS per-sym; REST bulk [L] | WS per-sym [L] |
| Order book depth | WS 1/50/200/1000 [D] | WS 5/10/20 + diff [L][D] | WS [D] | WS / REST, max 20 levels per side [D] | WS books 1/5/15/full [L][D] | WS 5/10/20/50/100 [L][D] | WS [D] |
| Open interest (current) | WS, base coin + USD [L] | **REST per-sym only. No WS stream, no bulk call** [L][D] | WS / REST bulk, in **contracts** [L][D] | WS / REST bulk, base coin [L] (unit not stated in docs) | WS / REST bulk, base coin [L][D] | **REST per-sym only**; value looks like **USDT notional** [L] (unit [?]) | WS / REST bulk, in **contracts** [L] |
| OI history (for backfill) | REST, 5 min+, back to listing [L][D] | REST, 5 min+, **last 1 month only** [L][D] | ❌ | ❌ | ❌ (none in docs) | ❌ | REST + WS `contract_stats` [L] |
| Funding rate | WS [L] | WS [L] | WS / REST [L] | WS [L] | WS [L] | REST bulk [L] | WS [L] |
| Funding interval | WS `fundingIntervalHour` [L] | REST `fundingInfo` — lists **only symbols with non-default settings**; the rest default to 8 h [L][D] | REST `collectCycle` [L] | Fixed 1 h [D] | REST bulk [L] | REST bulk [L] | WS + REST [L] |
| Next funding time | WS [L] | WS [L] | REST / WS per-sym [L][D] | Hourly; given by `predictedFundings` [L] | WS [L] | REST bulk [L] | REST [L] |
| Separate "predicted next" rate | ❌ single field [D] | ❌ single field [D] | ❌ single field | REST `predictedFundings` (first perp dex only) [L][D] | ❌ single field | ❌ single field | Field exists but is marked deprecated in WS docs [D] |
| Funding caps | WS [L] | REST (adjusted symbols) [L] | REST [L] | 0.5 %/h [D] | REST [L] | REST [L] | REST [L] |
| Max leverage | REST [L] | **🔑** (`leverageBracket` rejects unauthenticated calls) [L][D] | REST [L] | REST [L] | REST [L] | **❌** not in public contract data [L] | REST [L] |
| Long / short ratio | REST per-sym [L] | REST per-sym, 30 days [L][D] | ❌ | ❌ | REST per-sym, **1 req/s** [L][D] | ❌ | REST + WS (`lsr_account`) [L] |
| 24 h volume | WS [L] | WS / REST [L] | WS [L] | WS [L] | WS [L] | WS [L] | WS [L] |
| Public trades with taker side | WS, + block-trade flag [L] | WS `aggTrade` (aggregated, 100 ms) [L] | WS (aggregated by default) [L][D] | WS, **with both wallet addresses and tx hash** [L][D] | WS [L] | WS [L] | WS (sign of size) [L] |
| Other participants' TWAP orders | ❌ | ❌ | ❌ | **Yes, per wallet** (`userTwapSliceFills`, `userTwapHistory`) [D] | ❌ | ❌ | ❌ |
| Default maker / taker fee | 🔑 [L] | 🔑 [L] | REST [L] | config [?] | REST [L] | REST [L] | REST [L] |
| Deposit / withdraw status | 🔑 [L] | 🔑 [L] | 🔑 [L] | n/a (on-chain) | **public** [L] | 🔑 [L] | **public** [L] |
| Contract size handling | base coin | base coin | contracts × `contractSize` | base coin | base coin | base coin | contracts × `quanto_multiplier` |
| Tradable USDT perps (live count) | 821 | 522 (+237 "TradFi" perps) | 1,067 | 179 (main dex) | 885 (421 flagged RWA) | 931 | 1,051 |

Market cap is not an exchange metric. Only incidental sources exist (Gate spot `market_cap`, Binance `CMCCirculatingSupply` in OI history) [L]. Full coverage needs an external provider such as CoinGecko — a decision for you.

**Functionality that cannot be built from public data alone**

1. Max leverage on Binance and BingX → shown as `unavailable` unless a read-only API key is supplied (Binance) / not at all (BingX).
2. Long/short ratio on MEXC, Hyperliquid, BingX → `unavailable`.
3. OI history on MEXC, Hyperliquid, Bitget, BingX → the 30 min / 1 h / 4 h windows only fill up as our own snapshots accumulate; after a cold start those windows show `unavailable (warming up)`.
4. Deposit/withdraw status on Bybit, Binance, MEXC, BingX without API keys.
5. Real account fee tier on any exchange → defaults from public metadata or config; every profit figure is labelled *preliminary*.
6. TWAP order size, executed %, status, wallet address, participant history on the six centralised exchanges. These are available **only on Hyperliquid**. On the others the detector is purely heuristic and those fields are `unknown`.

---

## 2. Per-exchange specifics and limits

### Bybit (V5)
- REST 600 requests / 5 s per IP; exceeding returns 403 and a ban of at least 10 minutes [D].
- WS `wss://stream.bybit.com/v5/public/linear`; ping every 20 s; ≤ 500 new connections / 5 min; no topic-count limit for linear, but one subscribe request ≤ 21,000 characters; spot is limited to 10 topics per request [D].
- **Ticker is snapshot + delta**: a field missing from a delta means "unchanged". The connector must merge deltas into state and resync after reconnect [L][D].
- REST returns both `openInterest` and `singleOpenInterest`; the first is exactly 2× the second on every symbol checked [O] → the headline figure appears to count both sides.
- Funding interval per symbol: 445 at 8 h, 374 at 4 h, 2 at 1 h [L].

### Binance (USDⓈ-M)
- **WebSocket URLs were restructured.** Streams now live under `wss://fstream.binance.com/public` (book ticker, depth) and `/market` (aggTrade, mark price, tickers, liquidations). The legacy unrouted URL was scheduled for removal on 2026-04-23 [D]; live test: it still connects but delivered only book-ticker data — aggTrade and mark price were silent [L]. Old tutorials and libraries fail silently here.
- 1,024 streams per connection, 10 client messages / s, forced disconnect after 24 h, server ping every 3 min [D].
- REST weight 2,400 / min per IP, shared between USDⓈ-M and COIN-M; HTTP 429 then 418 with bans from 2 minutes to 3 days [D].
- **Open interest**: no WS stream, no bulk call. 522 symbols = 522 weight per sweep → a 30–60 s sweep is affordable. History endpoint has its own limit of 1,000 requests / 5 min [D].
- `!markPrice@arr@1s` carried 747 instruments in one message [L] — the stream includes the 237 `TRADIFI_PERPETUAL` contracts.
- Liquidation stream pushes only the largest liquidation per 1,000 ms [D].

### MEXC
- Futures WS `wss://contract.mexc.com/edge` (JSON; Protobuf optional) [D]. The all-symbols channel `sub.tickers` pushes every 2 s and has **no bid/ask, OI or funding**; the per-symbol `sub.ticker` has everything [L][D].
- REST bulk ticker (1,158 rows incl. bid/ask, OI, funding) is limited to 10 requests / 2 s [L][D] → cheaper than 1,067 WS subscriptions, whose limit is not documented [?].
- `funding_rate` without a symbol returned all 1,158 rows including interval and next settlement [O]; the docs describe only the per-symbol form (20 requests / 2 s).
- Trades are aggregated by default; `compress=false` requests individual trades [D] — required for the TWAP detector, to verify.
- OI (`holdVol`) is in contracts; multiply by `contractSize` (0.0001 for BTC, 10 for some alts) [L][D].
- Ping rule and subscription limits could not be read from the current docs (several pages returned 403 to automated fetches) [?]. One of four connection attempts failed during the handshake [L].
- Spot WS is **Protobuf-only**, max 30 subscriptions per connection, 24 h lifetime [D].

### Hyperliquid
- Everything public via `POST https://api.hyperliquid.xyz/info`, no key. REST 1,200 weight / min per IP; `metaAndAssetCtxs` costs 20. WS: **max 10 connections, 1,000 subscriptions, 30 new connections / min**, 10 unique users across user-specific subscriptions [D].
- 179 live perps × (asset context + bbo + trades) = 537 subscriptions → fits in the 1,000 budget, but leaves little for order books.
- No index price. `oraclePx` is a weighted median of CEX prices updated about every 3 s; mark price is a median that itself includes other exchanges' perp prices [D]. Mark-vs-last deviations therefore mean something different here.
- Funding is paid hourly; the published rate is the hourly rate (the formula is defined on an 8 h basis and paid as 1/8 per hour); cap 0.5 %/h; paid on oracle price, not mark [D].
- Quote/collateral is USDC, not USDT.
- Public trades carry `users: [buyer, seller]` and `hash` [L][D]. Docs state TWAP fills carry a zero hash; zero-hash trades were visible in the public stream [L] → TWAP slices can very likely be recognised market-wide, then confirmed per wallet. Confirmation calls are rate-limited (weight 20 + per-item surcharge).
- Naming: `kPEPE`, `kSHIB`, `kBONK` … = 1,000 units. Builder-deployed markets (`xyz:AAPL` etc.) sit in separate "dexes" and need the `dex` parameter; `predictedFundings` covers only the first dex [D].
- Spot pairs are named `@1`, `@2` … and use wrapped assets [L] — not directly comparable with CEX spot.
- No documented heartbeat; an application-level `ping` returned `pong` [L].

### Bitget (Classic V2)
- The Classic API is "in maintenance mode"; Bitget recommends the UTA API. No retirement date is published [D]. V2 public REST and WS work today [L].
- WS `wss://ws.bitget.com/v2/ws/public`; send `ping` every 30 s (server drops after 2 min); max 1,000 subscriptions per connection (**< 50 recommended**), **240 subscribe requests / hour / connection**, 100 connections per IP, subscribe payload ≤ 4,096 bytes [D].
- Ticker channel is per symbol (no all-symbols form) but carries mark, index, funding, next funding time, OI, bid/ask [L]. REST bulk ticker has the same minus next funding time; limit 20 requests / s [L][D].
- Trade channel changes on **2026-11-17**: only `update` messages, no initial snapshot [D].
- Long/short endpoints are limited to 1 request / s → usable on demand for signal candidates only, not as a full sweep.
- Spot coin list (deposit/withdraw status, networks, contract addresses) is public, 3 requests / s [L][D].

### BingX (Swap V2)
- Docs render only in a real browser; read that way.
- WS `wss://open-api-swap.bingx.com/swap-market`: **every frame is GZIP-compressed**; server sends text `Ping` every 5 s and expects `Pong`; **200 topics per socket, 60 sockets per IP** [D][L]. No all-symbols stream.
- Market REST group limit: 500 requests / 10 s per IP [D].
- `premiumIndex` bulk (980 rows) returns mark, index, funding, interval, next funding time, caps [L]. Bulk ticker returns last + bid/ask [L].
- **Open interest requires a symbol** (error 109400 without one) [L]. BTC returned 697,754,824 — USDT notional, not coins [L]; unit is not stated in the docs read [?]. 931 calls per sweep.
- 353 of 1,333 contracts have a non-trading status code → filter on `status = 1` [L]. Symbol families `NCFX…`, `NCS…` are forex / stocks / commodities.

### Gate (API v4)
- Docs now on gate.com; `api.gateio.ws` and `fx-ws.gateio.ws` work [L]. Public REST limit reported as 200 requests / 10 s per endpoint [D, from a summarised section — verify].
- Sizes are in **contracts** everywhere (tickers, trades, book). Multiply by `quanto_multiplier` (0.0001 BTC … 100 for small-price alts) [L].
- **15 contracts have `enable_decimal = true`** (fractional contract counts). Without the `X-Gate-Size-Decimal: 1` header sizes are rounded down to integers [D] → silent precision loss if missed.
- `tickers.total_size` is exactly 2× `contracts.position_size` on every symbol checked [O] — same two-sided question as Bybit.
- `futures.contract_stats` over WS delivers OI, OI in USD, long/short ratios and liquidation sums per interval [L].
- Server pings; application-level `futures.ping` also works [L][D].

---

## 3. Data accuracy and calculation notes

### 3.1 Instrument identity (the largest correctness risk for cross-exchange work)
- **Same ticker ≠ same asset.** Tickers collide across exchanges; assets get renamed.
- **Multiplier prefixes differ**: `1000PEPE` / `kPEPE`; `1MBABYDOGE` (Binance, Bitget) / `1000000BABYDOGE` (Bybit, MEXC, BingX); `10000SATS` / `1000SATS` [L].
- **Quote currency differs**: Hyperliquid is USDC-based; everything else here is USDT. A USDT/USDC basis of a few basis points is material against spreads of 0.1–0.5 %.
- **Non-crypto perps** are now a large share of listings (Binance 237, Bitget 421 RWA, BingX NCFX/NCS, MEXC, Gate, Hyperliquid builder dexes). They trade on market-hours schedules and have different index sources.

Design response: a canonical instrument registry `(asset, multiplier, quote, kind)` built from exchange metadata, plus a hand-maintained override file (aliases, exclusions), plus a runtime guard — if two "matching" instruments differ in price by more than a configurable bound after multiplier normalisation, the pair is quarantined and reported as a mapping problem, never as an arbitrage signal.

### 3.2 Fair price scanner
- Formula as specified: `(last − mark) / mark × 100`, plus `(mark − index) / index × 100`.
- Last price on an illiquid contract can be minutes old. A deviation computed from it is not actionable. Proposal: report the specified last-vs-mark figure **and** an executable figure (ask vs mark for LONG, bid vs mark for SHORT), and require a fresh last-trade timestamp.
- Mark price definitions differ per exchange (Hyperliquid's includes other venues' prices). Thresholds must be configurable per exchange.
- Hyperliquid: "index" column = oracle price, labelled as such.

### 3.3 Open interest
- Normalise to **base-coin units** first: contracts × contract size (MEXC, Gate); BingX notional ÷ mark price (flagged `derived`, adds price noise).
- Percentage change is computed on base units, so price moves do not masquerade as OI moves. USD change = Δ(base units) × current mark.
- One-sided vs two-sided counting is unresolved for five exchanges [?]. Percentage changes are unaffected; **absolute OI must not be compared or summed across exchanges** until the convention per exchange is confirmed.
- Windows need a snapshot at `t − Δ` within a tolerance; otherwise the value is `null` with reason. Backfill from REST history on Bybit, Binance, Gate.
- Binance and BingX OI arrive by polling (30–120 s), so the 5-minute change there is built from few points.

### 3.4 Funding
- `funding_24h = rate × 24 / interval_hours`. The interval is **per symbol and changes** (exchanges shorten it during extremes); it must be refreshed, never assumed to be 8 h.
- Every exchange except Hyperliquid publishes a single live rate field; the docs do not label it "settled" or "estimated" [D]. Working interpretation, to confirm in Stage 3 by comparing against funding-history endpoints at settlement: the live field is the estimate for the upcoming settlement; "current vs predicted" is implemented as *last settled (history)* vs *live estimate*.
- Funding-arbitrage output must show that legs settle at different times (hourly vs 4 h vs 8 h) and that rates are estimates until settlement.

### 3.5 Cross-exchange spread
- Buy at the **ask** of the cheap venue, sell at the **bid** of the expensive one. `gross = (bid_sell − ask_buy) / ask_buy`. Net subtracts both taker fees, VWAP slippage for the position size, and expected funding where applicable.
- Both quotes must be fresh within a small window; otherwise no signal.
- Order-book depth for ~5,400 instruments cannot be subscribed. Two tiers: top-of-book for everything; depth fetched on demand only for pairs that pass the gross threshold, then VWAP.
- A perp–perp spread is a basis position, not a transferable arbitrage; the message must say so. Spot legs need transfer status, which is public only on Bitget and Gate.

### 3.6 TWAP / large-trade detector
- Centralised exchanges: heuristic only — regularity of inter-trade intervals, similarity of sizes, one-sided signed volume against a rolling baseline, duration. Output is labelled *algorithmic assumption* with a confidence score.
- Binance and MEXC aggregate trades, which changes what "one trade" means; per-exchange calibration is required.
- Hyperliquid: zero-hash trades + wallet addresses → per-wallet TWAP state from the API, labelled *exchange-confirmed*.
- Trade streams for all ~5,400 instruments is the heaviest load in the system; a configurable watchlist (top-N by volume) is proposed.

### 3.7 General
- All exchange values arrive as strings or floats; normalised model keeps `number` (float64) for analytics plus exchange and local receive timestamps. Missing = `null` + reason code, never a substitute value.
- Staleness is judged per field (a ticker can be fresh while its OI is 90 s old).

---

## 4. Architecture

### 4.1 Verdict on the proposed stack
Sound; no replacement recommended. Adjustments:

| Topic | Recommendation |
|---|---|
| Processes | Three: `collector` (connectors + normalisation + live state), `engine` (analytics + five scanners + Telegram), `api` (Fastify REST + dashboard WebSocket). Static web build served separately. |
| Redis | Latest normalised state (flushed in coalesced batches, ≤ 1 s), pub/sub between processes, cooldown/dedupe keys, short rolling windows. |
| PostgreSQL | Settings, instrument registry, signal history, snapshots. Time-series tables partitioned by day with a retention job; bulk writes through raw SQL (`pg`), Prisma for everything else. TimescaleDB is optional and not needed initially. |
| WebSocket client | `ws` library with a shared base class: heartbeat variants, reconnect with jittered backoff, subscription sharding across connections, resubscribe pacing, 24 h rotation. |
| Hot-path validation | Hand-written validators in connectors (zod per message is too slow at these rates); zod for config and REST payloads. |
| Monorepo | pnpm workspaces; Vitest; pino logging. |
| "WebSocket instead of REST polling" | Kept as the default, with a documented exception: on MEXC, BingX and Bitget one bulk REST call per second returns every symbol, which is far lighter than ~900 subscriptions under tight per-connection limits. WS is still used there for trades, depth and watchlist symbols. |
| Dashboard access | The spec has no authentication. The dashboard changes bot settings, so it needs at least a single-user login. |

### 4.2 Component diagram

```
                    ┌──────────────────────── collector ─────────────────────────┐
 Exchanges ──WS────▶│ connectors/{bybit,binance,mexc,hyperliquid,bitget,bingx,gate}│
           ──REST──▶│   base: ws-client · rest-client + rate limiter · sharding    │
                    │ normalise → validate → instrument registry → live state      │
                    │ freshness tracker · 1-min snapshots · connection health      │
                    └───────────────┬──────────────────────────┬──────────────────┘
                         coalesced state + events        batched snapshots
                                    ▼                          ▼
                                 Redis  ◀──────────────▶  PostgreSQL
                                    ▲                          ▲
                    ┌───────────────┴────────── engine ────────┴──────────────────┐
                    │ analytics (pure functions): deviation · OI change · funding  │
                    │   normalisation · VWAP · net spread · pattern heuristics     │
                    │ scanners: fair-price · open-interest · funding · spread · twap│
                    │ signal engine: thresholds · dedupe · cooldown · lifecycle    │
                    │ notifier: grammY · per-scanner destination · send/edit queue │
                    └───────────────┬─────────────────────────────────────────────┘
                                    ▼
                    ┌──────────── api (Fastify) ────────────┐        ┌──── web ────┐
                    │ REST: signals, settings, instruments,  │◀──────▶│ React + Vite │
                    │ health · WS gateway: batched deltas    │        │ 5 windows    │
                    └────────────────────────────────────────┘        └─────────────┘
```

Rules that keep it extensible: scanners depend only on the normalised model and on `analytics`; connectors know nothing about scanners; adding an exchange = one connector folder + registry entries; adding a scanner = one folder registered with the signal engine and one dashboard window.

---

## 5. Performance risks

1. **Quote firehose.** Binance's all-symbols book ticker alone ran at ~100 messages/s in a quiet minute and rises by an order of magnitude in volatile ones. Mitigation: latest-wins maps flushed on a timer; no per-message Redis or DB writes; collector can be split per exchange by configuration.
2. **Subscription ceilings.** BingX 200 topics/socket; Hyperliquid 1,000 subscriptions total; Bitget 240 subscribe requests/hour; MEXC spot 30 per connection. Needs a sharding/budget manager in the base connector.
3. **REST sweeps.** Binance OI (522 calls), BingX OI (931 calls), long/short ratios. Needs a weighted token-bucket limiter per exchange with priorities and backoff on 429/403.
4. **Reconnect storms.** Resubscribing thousands of topics after a drop can itself breach limits (Binance 10 msg/s, Hyperliquid 30 connections/min). Batched, paced resubscription.
5. **Snapshot volume.** 5,400 instruments × 1-minute snapshots ≈ 7.8 M rows/day. Keep the 4 h window in memory/Redis; persist with daily partitions and short retention; downsample older data.
6. **Depth for VWAP** — on demand only.
7. **Dashboard fan-out** — thousands of rows at 1 Hz: server-side topic filtering, batched deltas, virtualised tables.
8. **Telegram limits** (roughly 1 message/s per chat, 20/min per group): outbound queue, cooldowns, message edits instead of new messages, digest mode during bursts.
9. **Forced 24 h disconnects** (Binance, MEXC spot): planned rotation with overlap.

---

## 6. Proposed directory structure

```
market-bot/
├─ docker-compose.yml  ·  .env.example  ·  pnpm-workspace.yaml  ·  tsconfig.base.json
├─ docs/                     analysis, architecture, per-exchange notes, per-bot notes
├─ prisma/                   schema.prisma, migrations (incl. raw SQL for partitions)
├─ packages/
│  ├─ core/                  domain types, null-with-reason, config schema, logger, clock
│  ├─ connectors/
│  │  ├─ base/               ws-client, rest-client, rate-limiter, subscription sharding
│  │  └─ bybit/ binance/ mexc/ hyperliquid/ bitget/ bingx/ gate/
│  │        rest.ts · ws.ts · normalize.ts · symbols.ts · fixtures/ · *.test.ts
│  ├─ market-data/           instrument registry, live state, freshness, snapshots, bus
│  ├─ analytics/             pure calculation functions + unit tests
│  ├─ scanners/
│  │  ├─ engine/             thresholds, dedupe, cooldown, signal lifecycle, history
│  │  └─ fair-price/ open-interest/ funding/ spread/ twap/
│  ├─ notifier/              grammY, formatters, outbound queue
│  └─ db/                    Prisma client, repositories, time-series writer
├─ apps/
│  ├─ collector/             process 1
│  ├─ engine/                process 2
│  ├─ api/                   process 3
│  └─ web/                   React + Vite dashboard
└─ tools/                    live probe scripts, traffic recorder for replay tests
```

---

## 7. Development phases

| Phase | Content | Exit check |
|---|---|---|
| 1 | This analysis. | Your decision on architecture and the open questions. |
| 2 | Monorepo, Docker Compose (Postgres, Redis), core types, logging, config; base WS and REST clients with reconnect, heartbeat, rate limiting. | Unit tests; reconnect test against a local socket server that drops connections. |
| 3a | Bybit + Binance connectors; instrument registry v1; live state; freshness; minimal health endpoint. | Normalisation tests on recorded real payloads; opt-in live integration tests; 24 h soak. |
| 3b | Gate, Bitget, then MEXC, BingX, Hyperliquid. Resolve every [?] in this document. | Same as 3a per exchange; updated availability table. |
| 4.1 | Signal engine + Telegram notifier + Fair Price scanner. | Calculation unit tests; replay test on recorded traffic; live notifications. |
| 4.2 | Snapshot store + backfill + Open Interest scanner. | Window/tolerance tests; four-scenario classification tests. |
| 4.3 | Funding scanner. | Normalisation tests across 1 h / 4 h / 8 h; settlement comparison. |
| 4.4 | Registry v2, on-demand depth, VWAP, fees → Spread scanner. | Net-profit tests; mismatch-guard tests. |
| 4.5 | Trade pipeline, heuristics, Hyperliquid confirmation → TWAP detector. | Detector tests on recorded sequences; confidence calibration. |
| 5 | Dashboard: five windows, settings, filters, history, connection status. | End-to-end check in the browser. |
| 6 | Soak and load tests, production Compose, documentation. | 48 h run without data gaps; README and docs complete. |

A small connection-status page is pulled forward into phase 3a because it makes connector debugging much faster.

---

## 8. Key technical risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | Wrong instrument matching across exchanges | False arbitrage signals | Registry + overrides + price-ratio guard + quarantine |
| 2 | Unit and convention differences (contracts, notional, two-sided OI, USDC vs USDT) | Wrong OI/spread numbers | Normalise in connectors; fixtures per exchange; no cross-exchange absolute OI until confirmed |
| 3 | Silent API changes (Binance URL split, Bitget Classic in maintenance mode, Bitget trade channel change 2026-11-17, MEXC Protobuf) | Data stops without errors | Per-stream freshness alarms; connector isolation; changelog review per release |
| 4 | Stale or thin quotes | Non-executable signals | Per-field freshness; executable-price confirmation; liquidity filters |
| 5 | Rate-limit bans (Bybit 10 min, Binance up to 3 days) | Exchange blackout | Central limiter with headroom; backoff; never retry-loop on 4xx |
| 6 | Subscription limits prevent full coverage | Missing instruments | Bulk REST hybrid; watchlists; sharding |
| 7 | OI windows empty after restart on four exchanges | Scanner blind for up to 4 h | Persist snapshots; reload on start; explicit warm-up state |
| 8 | TWAP heuristic false positives | Noise | Confidence score; conservative defaults; clear "assumption" labelling |
| 9 | Hosting region blocked by an exchange | Connector unusable | Choose region deliberately; per-exchange enable flag |
| 10 | Undocumented behaviours relied upon ([O] items) | Breakage | Each has a documented fallback |

---

## 9. Decisions recorded on 2026-11-16 (first version)

| Topic | Decision | Consequence |
|---|---|---|
| Dashboard access | One username and password; local use for now. | Credentials from `.env`, session cookie. No roles, no user management. |
| API keys | Read-only keys will be provided. | Used for Binance max leverage and for account fee tiers. Kept in `.env`, never committed, never logged. Keys must have no trade or withdrawal permission. |
| Instrument universe | The 100 largest crypto assets. | At most ~700 instruments (100 assets × up to 7 exchanges) instead of ~5,400. |
| Spot | Out of scope; perp–perp only. | Bot #4 compares perpetuals only. Deposit/withdraw status is not needed in this version. The "instrument" field is always Perpetual. |
| TradFi / RWA perps | Excluded. | Filtered by exchange flags where they exist (Binance `TRADIFI_PERPETUAL`, Bitget `isRwa`) and by an exclusion list elsewhere. Hyperliquid builder dexes are not loaded. |
| Market cap | CoinGecko. | Needs a CoinGecko API key. Plan limits not verified in this stage [?]. |
| Hosting | A region where all seven exchanges are reachable. | No per-region workarounds. |
| Telegram | One chat with five topics, one bot per topic. | Five bot tokens, one chat id, five topic ids. Send-only; all settings live in the dashboard. |

### Working definition of "100 largest" (default, configurable)
Rank by CoinGecko market cap among crypto assets that have a USDT perpetual on at least one of the seven exchanges; stablecoins and wrapped/staked duplicates are removed by an exclusion list; the list is refreshed daily. Both the size (N) and the ranking method (market cap or aggregated 24 h perp volume) are settings.

CoinGecko symbols are not unique, so assets are tied to exchange tickers by CoinGecko id through the instrument registry and its override file, not by ticker text.

### What the smaller universe changes in sections 4–5
- **WebSocket-first is feasible on every exchange.** The bulk-REST exception for MEXC, BingX and Bitget is no longer the default; it stays as a fallback path. Sharding is still required (BingX allows 200 topics per socket).
- **REST sweeps shrink**: Binance and BingX open interest drop to ~100 calls per sweep each.
- **Bot #5 can cover the whole universe**; no separate watchlist is needed.
- **Snapshots**: ~700 instruments × 1-minute ≈ 1 M rows/day. Daily partitions with retention remain, but volume is no longer a concern.
- The connector base still implements sharding, pacing and budgets so the universe can grow later without rework.

### Still open after these decisions
- Whether BingX exposes max leverage through an authenticated endpoint [?].
- Every other [?] in sections 1–3 (to be resolved in Stage 3).
