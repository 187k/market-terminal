# Stage 4 — Scanners, signals and Telegram

Date: 2026-11-17. The five bots run in the `engine` process. Each one evaluates the live market view (from the collector) on its own interval, produces candidates, and hands them to one shared signal engine that handles deduplication, cooldowns, updates, persistence and Telegram delivery. Every key parameter is a setting stored in PostgreSQL and editable at runtime (the dashboard's Settings tab, or `PUT /api/scanners/:id/settings`).

All signals are analytical. LONG / SHORT / BUY / SELL are directions of the observed situation, never trading recommendations, and every message says so.

## 1. Shared machinery

```
collector ──Redis──▶ engine: market view (1 s) ─┬─ Fair Price      (every 1 s)
   │                       snapshot history ────┼─ Open Interest   (30 s)
   │  per-minute snapshots ▶ PostgreSQL ────────┼─ Funding         (15 s)
   │  public trades ▶ Redis Stream ─────────────┼─ Spread          (2 s, + order books on demand)
   └─────────────────────────────────────────────┴─ TWAP / DCA      (15 s, + Hyperliquid TWAP orders)
                                                          │ candidates
                                                          ▼
                                    signal engine: confirm → open → update → resolve → cooldown
                                          │ PostgreSQL (signals)   │ Redis (live)   │ Telegram
```

- **Market view.** Every second the engine reads the collector's evaluated snapshots. A value that is stale, missing or rejected is never used, so stale data cannot produce a signal. If the collector stops publishing, everything is treated as stale.
- **Signal lifecycle** (`apps/engine/src/signals.ts`):
  - A candidate must persist for `confirmSec` before it opens. This filters single-tick noise.
  - An open signal's Telegram message is edited only when its main figure changes by `significantChangePct`, and at most once per `minUpdateIntervalSec`.
  - It resolves after its condition has been absent for `resolveAfterSec`; the message is then edited to "Resolved".
  - If the same signal reappears within `cooldownMinutes`, it reopens the same record and message instead of announcing again.
  - Open signals are reloaded from PostgreSQL after a restart, so nothing is announced twice.
- **Telegram** (`apps/engine/src/notifier.ts`):
  - One chat (forum supergroup) with five topics, one bot per scanner (grammY, send-only).
  - Each bot is paced below Telegram's group limits: 1 message / 1.1 s and 18 / min. On HTTP 429 it waits for the `retry_after` Telegram returns.
  - Pending edits of the same message are merged.
  - Tokens are checked at start (`getMe`); a rejected token disables that bot with a reason.
  - When a bot is not configured, signals are still recorded, and their Telegram state says why nothing was sent.
- **History.** The collector writes one snapshot per instrument per minute to `market_snapshots` (fresh values only; retention `MARKET_SNAPSHOT_RETENTION_DAYS`, default 7). The engine keeps the last 9 h in memory and reloads it after a restart.
- **Trades.** The collector subscribes to public trades on all seven exchanges and forwards those of at least `TRADES_MIN_NOTIONAL_USD` (default $500) through the Redis Stream `mip:trades`. Hyperliquid TWAP slices are always forwarded. On start the engine re-reads the last hour from the stream.
- **Common settings** (every scanner):
  - Filters: `exchanges`, `includeAssets` / `excludeAssets`, `minTurnover24hUsd`.
  - Lifecycle: `confirmSec`, `resolveAfterSec`, `cooldownMinutes`, `minUpdateIntervalSec`, `significantChangePct`.
  - Notifications: `notifyTelegram`, `notifyResolved`.

## 2. Bot 1 — Fair Price Scanner

- **Formula:** deviation = (last − mark) / mark × 100. Below fair → LONG, above → SHORT. It also computes fair vs index = (mark − index) / index × 100.
- **Executable check** (`requireExecutable`, on by default): the order book must still offer the deviation. For LONG the ask must be below mark, for SHORT the bid above mark, by at least `minExecutableEdgePct`. A last price on an illiquid contract can be minutes old; this filters such cases.
- **Filters:**
  - `minDeviationPct` 0.5 %
  - `minTopOfBookUsd` $1,000 at the best level you would take
  - `maxSpreadPct` 2 %
  - 24 h turnover $1 M
- **Message:** link to the exchange; market, fair and index prices (Hyperliquid's oracle is labelled as such); both deviations, with a warning above `fairIndexWarnPct`; the executable price; liquidity at the best level; spread; turnover; funding, interval and time to settlement; max leverage (or why it is missing); risk level.
- **Risk level** is a count of adverse conditions: wide spread, thin book, fair far from index, extreme funding, very large deviation, low volume. 0–1 is low, 2 medium, 3 or more high.

## 3. Bot 2 — Open Interest Scanner

- **Windows** 5 m, 30 m, 1 h and 4 h, each against the snapshot nearest *t − window*: within ±90 s, or ±10 % for long windows. Without such a snapshot the window is `warming up` or `no data`. Values are never interpolated.
- **Change** is computed on base units, so price moves do not show up as OI moves: % = (current − previous) / previous × 100, plus Δ coins and Δ USD (Δ coins × mark). Price change over the same window comes from the same snapshot.
- **Thresholds** per window (growth / decline %): 5 m 3 / 3, 30 m 8 / 6, 1 h 12 / 8, 4 h 25 / 15. Also `minOiUsd` $2 M and `minTopOfBookUsd` $1,000. Growth and decline signals can be switched separately. The strongest window relative to its threshold leads the signal.
- **Scenarios:** price ↑ OI ↑ / price ↓ OI ↑ / price ↑ OI ↓ / price ↓ OI ↓, each with a neutral reading. Every message notes that each contract has a long and a short side.
- **Caveats shown in messages:**
  - Binance OI is polled every 30 s, and BingX OI every 60 s converted from USDT notional.
  - The long/short ratio is not collected in this version.
  - After a cold start the longer windows warm up (no exchange backfill yet). The scanner status shows how much history exists.

## 4. Bot 3 — Funding Rate Scanner

- **Normalisation:** funding 24 h = rate × 24 / interval, with each contract's live interval (1 h on Hyperliquid, 4 h or 8 h elsewhere, and it changes). It is never assumed to be 8 h.
- **Extremes:** |24 h funding| ≥ `extreme24hPct` (0.3 %). The message says who pays whom.
- **Arbitrage:** per asset, long where 24 h funding is lowest and short where it is highest, if the difference is ≥ `minDifference24hPct` (0.15 %). The message shows the daily amount per $10k, and warns when the legs settle on different schedules or use different quote currencies.
- **Current vs last settled:** exchanges publish one live rate (the estimate for the upcoming settlement). The last settled rate is *observed*: the last rate in the minute snapshots before the next-funding time moved forward. It is labelled as observed and is "not observed yet" until the engine has seen a settlement.
- Every message lists all exchanges with rate, interval, 24 h figure, time to next settlement and last settled rate. It states that current rates are estimates until settlement.

## 5. Bot 4 — Cross-Exchange Spread Scanner (perp–perp)

- **Normalisation:** prices are per asset unit (multiplier applied, e.g. 1000PEPE vs PEPE). USDT and USDC quotes may be compared (`allowMixedQuotes`), with the basis flagged.
- **Gross spread:** buy at the lowest ask, sell at the highest bid on another exchange. gross = (bid_sell − ask_buy) / ask_buy × 100. Both quotes must be fresh within `maxQuoteSkewMs` (3 s) of each other.
- **Mapping guard:** gaps above `maxPlausibleSpreadPct` (5 %) are quarantined as probable mapping problems and shown as a scanner warning, never as a signal.
- **Net calculation** (the specified steps) for `positionUsd` ($10k):
  - Coins = position / ask.
  - Purchase cost and sale proceeds use **VWAP from the order books**, fetched on demand for candidates only.
  - Subtract both taker fees (`takerFees`; base-tier defaults per exchange).
  - Subtract funding over `holdingHours` (8 h): long pays its rate, short receives its rate.
  - The result is net profit and net %.
- **Signals** when net ≥ `minNetSpreadPct` (0.1 %) after a gross pre-filter of `minGrossSpreadPct` (0.3 %).
- **Labels:** results are labelled *preliminary* when fees are defaults (always, until account fees are configured), the book is unavailable (top-of-book used), the book is thinner than the position, or funding is missing.
- **Message contents:**
  - buy and sell venues and prices (VWAP), position, cost, proceeds, gross, fees, funding and net
  - slippage, average price and each venue's deviation from it
  - both legs' bid/ask, mark, index, funding (per interval and per 24 h) and 24 h volume
  - compatibility checks and risk
  - "deposit / withdrawal not needed for perp–perp", and that it is a basis position

## 6. Bot 5 — TWAP / DCA / Large Trade Detector

Two kinds of signal, labelled differently:

- **Exchange-confirmed (Hyperliquid).** Trades with an all-zero transaction hash are TWAP slices (Hyperliquid docs). The taker wallet is the TWAP owner.
  - The engine follows up to 10 such wallets through the documented `userTwapHistory` subscription. That gives the order's total size, duration, randomisation, reduce-only flag and status (active / completed / cancelled), and how many TWAPs the wallet has run.
  - While an order is active, Hyperliquid reports no progress, so the message shows the observed slices and the share of the scheduled time elapsed. The exchange's executed size and percentage are used once it reports a final state.
  - Wallet addresses are public on-chain data; nothing is inferred.
- **Heuristic (all exchanges).** "Algorithmic assumption" with a confidence score.
  - Fills of one taker order (same time and side) are merged into one execution.
  - The largest group of similar-size executions on one side (`sizeTolerancePct` 15 %) needs at least `minSlices` (10) over at least `minDurationSec` (180 s), worth `minNotionalUsd` ($25k).
  - Confidence = 0.4 × timing regularity (1 − coefficient of variation of intervals) + 0.2 × size similarity + 0.2 × number of executions + 0.2 × one-sidedness of the window's volume.
  - Reported from `minConfidence` 0.6.
  - Status is active while executions continue (within 3 × the median interval), completed otherwise.
  - Order size is unknown on these exchanges; the executed volume is shown as a lower bound. Wallet and history: not available.
- **Message:** direction, executed volume and order size where known, status, timing, average execution price, price change since the start, market cap (CoinGecko), 24 h turnover, the pattern metrics, and per-exchange caveats. Binance publishes aggregated trades; MEXC deals are aggregated.

## 7. API

| Endpoint | |
|---|---|
| `GET /api/scanners` | status of each scanner: enabled, last run and duration, evaluated, active, signals in 24 h, Telegram state with reason, warnings |
| `GET /api/signals?scanner=&status=active\|resolved&limit=&before=` | signals; active ones from the engine's live state, history from PostgreSQL |
| `GET /api/scanners/:id/settings` | current settings and defaults |
| `PUT /api/scanners/:id/settings` | `{ enabled?, settings? }`; merged with the current values (nested objects key by key since Stage 5), validated (problems listed per field), applied by the engine within a second |

Stage 5 added `/ws`, `GET /api/signals/live`, `asset` / `exchange` filters, coin details and the settings JSON Schema: see [stage-5-dashboard.md](stage-5-dashboard.md) §8. The settings are now edited in the dashboard.

## 8. Verification

- **Unit and scenario tests:**
  - every formula (`packages/analytics`)
  - the signal lifecycle (confirmation, edits, resolve, cooldown reopen, restart without duplicates, disabled or failed delivery)
  - the Telegram notifier against a fake Bot API (topics, HTML, 429 retry_after, "not modified", rejected token)
  - each scanner on synthetic cases, plus Fair Price and Funding on a recorded real market view
  - OI windows and warm-up
  - funding normalisation across 1 h / 4 h / 8 h and settlement detection
  - spread profit steps, VWAP, multipliers, funding direction, quarantine and the preliminary flag
  - TWAP detection that separates regular TWAPs from random and same-lot flow, with Hyperliquid confirmation
  - order-book and trade parsing for all seven exchanges on recorded payloads
- **Live (2026-11-17, Docker stack):**
  - All five scanners ran against seven exchanges. Fair Price checked 619 instruments in under 1 ms per run.
  - Funding reported real extremes and spreads.
  - A threshold change through the API took effect within a second; signals opened, resolved and were stored.
  - The TWAP detector found an exchange-confirmed Hyperliquid TWAP: a $3.0 M reduce-only HYPE sell over 120 min, from a wallet with 16 TWAPs in its history.
  - After an engine restart the trades, history and open signals were restored without re-announcing.
- **Not verified live:**
  - Telegram delivery: no bot tokens yet. It is covered by tests against a fake Bot API.
  - The 4 h OI window: it needs 4 h of uninterrupted history.
  - A funding settlement observed end to end.
