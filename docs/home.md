# Home page: market overview

The dashboard opens on **Home** (`#/`, the first tab in the top bar). It gives the state of the whole crypto market and of the monitored coins at a glance. The scanner windows moved to the **Dashboard** tab (`#/dashboard`); the **Terminal** tab is unchanged.

Added on 2026-11-21 at the user's request. The user chose the content: coin cards for the 20 largest coins, a whole-market bar, perpetual figures per coin, top movers with a market map, and signal and exchange health.

## 1. What is on the page

| Part | Content | Source |
| --- | --- | --- |
| Market bar | Total market cap and its 24 h change, 24 h spot volume, BTC and ETH dominance, CoinGecko's Fear & Greed reading (when sent), open interest and 24 h turnover of the monitored perpetuals, median 24 h funding | CoinGecko `/global`; perpetual totals from the monitored exchanges |
| Largest coins | 20 cards (top 20 of the universe by CoinGecko market-cap rank): name, ticker, rank, price, 24 h change, 7 d change, 7-day price chart, market cap, 24 h volume, median funding (24 h), open interest and its 24 h change; a dot shows whether the CoinGecko figures are current (green), out of date (amber) or missing (grey), and the footer shows their age | CoinGecko `/coins/markets`; perpetual figures from the exchanges |
| Top movers | The 5 biggest gainers and losers among the universe coins over 1 h, 24 h or 7 d (switch in the panel; remembered in the browser) | CoinGecko price change |
| Signals and exchanges | Per scanner: state, open signals, signals in the last 24 h (click opens the scanner's detailed view); the 7 latest signal updates of all scanners; each exchange's connection state with fresh / streamed instruments | The `scanners`, `signals` and `status` topics the dashboard already uses |
| Market map | One tile per universe coin, area by market cap, colour by price change over the chosen period (full colour at ±2 % for 1 h, ±8 % for 24 h, ±20 % for 7 d) | CoinGecko |
| All monitored coins | Sortable table: rank, price, 1 h / 24 h / 7 d change, 7-day chart, market cap, 24 h volume, median funding (hover: lowest and highest exchange), premium vs index, open interest, OI 24 h change, number of exchanges | CoinGecko and the exchanges |

Clicking a coin anywhere opens the existing coin view (live values per exchange, signals, links to the terminal). Problems with the data (a failed CoinGecko request, an exchange without current data, no 24 h OI history yet) are listed in an amber box at the top. A dash always means unknown, never zero.

## 2. Where the data comes from, and how often

**CoinGecko (spot figures).** The collector polls CoinGecko for the home page (`MarketOverviewPoller`, `apps/collector/src/overview.ts`) every `OVERVIEW_REFRESH_SEC` (default 120 s):

- `GET /api/v3/coins/markets?vs_currency=usd&ids=<universe ids>&sparkline=true&price_change_percentage=1h,24h,7d` (250 ids per request; the default universe of 100 needs one) [D];
- `GET /api/v3/global` [D].

The poll uses the collector's existing CoinGecko client, so it shares the rate limiter (and the keyless budget of about 5 calls per minute) with the universe build. Its requests have low priority, so a universe build always goes first, and they are never retried: the next poll is the retry. Each part keeps its last good result with the time it was fetched; a failure records the error and leaves the old figures in place, labelled as old. An outage is logged once. The result is written to Redis (`mip:overview`, kept 6 h so the page can show the last figures as stale after the collector stops). The API calls CoinGecko figures stale after three missed polls (6 min by default) and the page marks them amber.

Coins are matched to the universe by CoinGecko id, never by ticker (tickers are not unique). A universe ranked by perpetual turnover (CoinGecko unavailable at build time, or `UNIVERSE_RANKING=volume`) has no CoinGecko ids, so the page then shows no coin figures and says why.

**Exchanges (perpetual figures).** The API computes them from the collector's live snapshots in Redis (`buildPerpOverview` in `apps/api/src/overview.ts`, math in `perpAggregate` in `@mip/analytics`). Only fresh values count; an exchange whose snapshot is older than 5 s is left out and named in the notes. The 24 h OI comparison reads the per-minute snapshots nearest 24 h ago from PostgreSQL (within ±10 min, never interpolated), at most once a minute.

**Delivery.** Two realtime topics, each with the same payload as its REST route:

| Topic | REST route | Re-read | Polling while the WebSocket is down |
| --- | --- | --- | --- |
| `overview` | `GET /api/overview` | every 5 s, pushed only when it changed (once per collector poll) | 15 s |
| `perps` | `GET /api/overview/perps` | every 5 s | 5 s |

## 3. Formulas

| Figure | Formula |
| --- | --- |
| Premium | median over exchanges of (mark − index) / index × 100. Hyperliquid has no index; its oracle price is used. |
| Funding 24 h | rate × 24 / interval × 100 per exchange with each contract's live interval (never an assumed 8 h), then the median. Lowest and highest are shown when at least two exchanges report funding. |
| Open interest | Σ over exchanges of open interest (one side, base units) × mark, in the quote currency (USDT; USDC on Hyperliquid). |
| OI 24 h change | (Σ OI × multiplier now − Σ OI × multiplier 24 h ago) / Σ OI × multiplier 24 h ago × 100, over the exchanges that have both values, so contract units and price moves do not count. |
| Perp turnover | Σ 24 h turnover over exchanges. |
| Market-bar totals | Σ of the coins' open interest and turnover; median of the coins' median funding. |
| Movers | CoinGecko price change of the universe coins, largest positive and largest negative. |
| Market map | Squarified treemap (`apps/web/src/treemap.ts`) by CoinGecko market cap. |

## 4. Evidence, labels and limitations

- **Response shapes** recorded on 2026-11-21 from the keyless API (`packages/connectors/src/coingecko/fixtures/`, re-record with `node tools/record-coingecko.mjs`, two requests).
- **Fear & Greed [O].** `/global` returned `fear_and_greed_index: { value, sentiment }` on 2026-11-21, but the field is not in CoinGecko's documented schema as far as checked. It is parsed only when present; the tile disappears otherwise, and its tooltip says it is undocumented.
- **The 7-day chart has no timestamps.** CoinGecko's `sparkline_in_7d` is a plain list of about 168 hourly prices, so the chart is drawn by point index. A series with an invalid point is dropped rather than drawn with the gap closed.
- **Spot and perpetual figures are not compared with each other.** CoinGecko's price is an aggregate that is minutes old; a "basis" against a live perpetual price would show a gap that is not there. The premium uses each exchange's own index instead.
- **Open interest across exchanges** includes Bitget and BingX, whose units are inferred, not documented [?] (docs/stage-3-exchanges.md). The tooltips say so.
- **No coin logos.** They would make every browser load images from CoinGecko's CDN.
- **Quotes.** CoinGecko figures are USD. Perpetual figures are in USDT, or USDC on Hyperliquid, and are added up as they are.

## 5. Configuration

| Variable | Process | Default | Meaning |
| --- | --- | --- | --- |
| `OVERVIEW_REFRESH_SEC` | collector | 120 | Seconds between CoinGecko polls (60–3600). Each poll costs 2 calls, plus one per 250 universe coins beyond the first 250. With a CoinGecko Demo key (`COINGECKO_API_KEY`) 60 s is comfortable. |

The number of cards (20), movers (5) and the colour scale of the market map are constants in the web app (`HomePage.tsx`, `Heatmap.tsx`).
