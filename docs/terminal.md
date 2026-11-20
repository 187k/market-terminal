# Terminal: view-only chart, order book and trades

The dashboard's **Terminal** page (`#/terminal/<exchange>/<symbol>/<interval>`) shows one instrument the way an exchange's trading screen does: candlestick chart with volume, order book, recent trades, and the instrument's live values. **It is view only.** There is no order entry, and the platform has no code that could place, change or cancel an order.

Open it from the **Terminal** tab in the top bar, the candle icon next to each symbol in the market table, or **Chart** in a coin view. The URL is shareable; the last viewed instrument and interval are remembered in the browser.

## 1. What is on the page

| Part | Content | Source |
| --- | --- | --- |
| Header | Last price (green / red on each tick), 24 h change, 24 h high / low, 24 h volume (base units), 24 h turnover, mark, index (oracle on Hyperliquid), funding with countdown and interval, open interest (one side, base units) | Live values from the collector (Redis, WebSocket-fed, with freshness); 24 h figures from the last 24 hourly candles; turnover is the exchange's own 24 h figure |
| Exchange tabs | The same asset on every exchange that lists it, with each one's last price; `×1000` marks instruments quoted per 1000 coins | The coin-view topic `asset:<code>` |
| Chart | Candles and volume, intervals 1m 5m 15m 30m 1h 4h 1D 1W, mark and index lines (toggle), log scale, crosshair legend (O H L C Vol), local-time axis, scroll left to load older candles | Exchange public kline endpoint through the API |
| Order book | 12 levels per side with cumulative size bars, last price and spread between the sides | Exchange public REST order book through the API (`DepthFetcher`, 50 levels requested) |
| Trades | The 50 newest trades with side, size and time; Hyperliquid TWAP slices marked | The collector's trade stream in Redis |

The chart is drawn with [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/) 5.2 (Apache-2.0); the TradingView logo on the chart is the attribution the licence asks for.

## 2. Where the data comes from, and how often

The terminal keeps the project's rule "WebSocket first, REST for bootstrap, gaps and periodic sync":

- **Live values and trades** come from Redis, which the collector fills from the exchanges' WebSocket streams. Nothing extra is requested for them.
- **Candle history** is requested from the exchange once when the chart opens, and again only when the user scrolls further back (300 candles per page).
- **The newest candles** (3) are re-synced from the exchange every `TERMINAL_CANDLE_SYNC_MS` (default 10 s), and right after a candle period ends so the exchange's final candle replaces the forming one (at most once per 2 s while the new candle is missing). Between syncs the forming candle's close, high and low follow the live last price (`applyLastPrice` in `@mip/analytics`); its volume stays at the exchange's figure from the last sync. A price from after the forming candle's period never opens a new candle: the next sync brings the exchange's own.
- **The order book** is requested every `TERMINAL_BOOK_REFRESH_MS` (default 2 s).
- **24 h figures** are re-requested once a minute (24 hourly candles).

All of this happens only while someone has the instrument open (the realtime hub reads a topic only while it has subscribers), and once per instrument however many browser tabs show it. Requests go through the same shared per-exchange rate limiters as the connectors, fail at once while that exchange's REST access is paused, and share bans with the collector and engine through `mip:pause:<exchange>` (the API reads and writes them every 5 s, like the engine). A failed request is not retried before its normal refresh time.

Every part of the live payload fails on its own: during a Binance ban the order book shows "unavailable: … paused until …" while candles from before the ban, live values and trades keep working. A failed order book is not shown (an old book would look current); older candles stay on the chart because they are history.

**Trades are filtered.** The collector forwards only trades of at least `TRADES_MIN_NOTIONAL_USD` (default $500) to keep the stream small; Hyperliquid TWAP slices are always kept. The trade list says so. The API keeps the last 100 such trades per instrument for 6 hours, and reads the last hour of the stream when it starts.

## 3. Candle endpoints per exchange

All public and documented [D]; response shapes recorded on 2026-11-20 (`packages/connectors/src/klines/fixtures/`, re-record with `node tools/record-klines.mjs`); paging into the past checked live on all seven for 1h and 1W [L].

| Exchange | Endpoint | Paging | Volume | Turnover | Notes |
| --- | --- | --- | --- | --- | --- |
| Bybit | `GET /v5/market/kline` | `end` | base | yes | newest first |
| Binance | `GET /fapi/v1/klines` | `endTime` | base | yes | weight 1 / 2 / 5 by page size (< 100 / < 500 / ≤ 1000) |
| MEXC | `GET /api/v1/contract/kline/{symbol}` | time range in seconds | contracts × contract size | yes (`amount`) | the documented `open` is the previous close; `realOpen` is not used |
| Hyperliquid | `POST /info` `candleSnapshot` | time range | base | no | weight 20 + 1 per 60 candles; at most the newest 5,000 candles exist; weekly candles start on Thursday [L] |
| Bitget | `GET /api/v2/mix/market/candles` | `endTime` | base | yes | `1Dutc` / `1Wutc` so days start at 00:00 UTC; weekly pages are short (13 candles) [L] |
| BingX | `GET /openApi/swap/v3/quote/klines` | `endTime` | **base units, inferred** [?] | no | the docs do not state the unit of `volume`; it matches base units in recorded data; shown as a note under the chart |
| Gate | `GET /api/v4/futures/usdt/candlesticks` | `from` / `to` in seconds | contracts × contract size | yes (`sum`) | `limit` cannot be combined with `from` / `to`, so older pages use a range; weekly interval is `7d`, starting on Thursday [L] |

Candles are validated before they are shown (positive prices, high ≥ low, non-negative volume); implausible rows are dropped, never repaired.

## 4. Units and display

- Prices are per instrument base unit, as the exchange quotes them: `1000PEPEUSDT` on Bybit is the price of 1000 PEPE. The header says so for such instruments, and the exchange tabs mark them `×1000`.
- Sizes (book, trades, volume) are in base units; MEXC and Gate contracts are converted with the contract size.
- Price precision follows the instrument's tick size. Hyperliquid publishes no tick size; its prices are shown with five significant figures, which is Hyperliquid's documented price rule.
- Hyperliquid quotes in USDC and its "index" is an oracle price; the header and chart label it **Oracle**.
- Times on the chart axis are local time (the offset is shown under the chart). The chart library draws UTC, so timestamps are shifted by the browser's UTC offset at page load.

## 5. API

| Endpoint | Notes |
| --- | --- |
| `GET /api/terminal/:exchange/:symbol?interval=5m` | `TerminalLiveResponse`: instrument, live fields, newest candles, 24 h figures, book, trades, per-part errors. Realtime topic `terminal:<exchange>:<symbol>:<interval>` (read every 1 s while followed) |
| `GET /api/terminal/:exchange/:symbol/candles?interval=&limit=&before=` | `CandlesResponse`: up to 300 candles opening before `before` (ms), oldest first; 404 for an instrument outside the monitored universe, 502 with the exchange's error (for example a ban) |

Symbols are validated (`[A-Za-z0-9._-]{1,40}`), and only tracked instruments (the monitored universe) are served. Types: `packages/core/src/types/terminal.ts`.

## 6. Code

| Where | What |
| --- | --- |
| `packages/connectors/src/klines/` | `KlineFetcher`, per-exchange requests and parsers, fixtures and tests |
| `packages/connectors/src/public-rest.ts` | Public REST hosts and limits shared by the order-book and candle fetchers |
| `packages/analytics/src/candles.ts` | `applyLastPrice`, `summarizeCandles`, `spreadPct` |
| `packages/bus/src/trade-feed.ts` | `TradeBuffer` / `TradeFeed` (moved from the engine; the API uses them too) |
| `apps/api/src/terminal.ts` | `TerminalSource`: caching and throttling per instrument, ban sharing |
| `apps/web/src/components/TerminalPage.tsx`, `CandleChart.tsx`, `OrderBook.tsx`, `route.ts` | The page, the chart, book and trades, hash routing |

## 7. Limitations

- No drawing tools or indicators; the page is for looking at the market, not for analysis tooling.
- The trade list shows only trades above the collector's filter (§2).
- Only instruments of the monitored universe can be opened (live values, trades and the price-checked mapping exist only for them).
- Bitget's weekly history is short per request, and Bybit's weekly history for some contracts ends earlier than other exchanges'.
- The web app has no automated tests; the terminal was checked in the browser (HANDOFF.md).
