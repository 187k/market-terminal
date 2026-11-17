# Stage 5: web dashboard

This document covers the dashboard as built: realtime updates, the five working windows, detailed views, settings, filters, signal history and coin details. The spec is `prompt.md` §4 and §8.

## 1. Realtime updates (`/ws`)

The API serves a WebSocket at `/ws` (`apps/api/src/realtime.ts`). nginx and the Vite dev proxy forward it.

- **Authentication.** The session cookie is checked when the socket opens and every 60 s after. Close code **4401** means the session is missing or ended, so the browser can tell "log in again" from a network problem. A browser `Origin` whose hostname differs from the `Host` header is closed with **4403** (cross-site WebSocket hijacking guard; the session cookie is also `SameSite=Lax`).
- **Protocol.** The client sends `{"type":"subscribe","topics":[...]}` and `{"type":"unsubscribe","topics":[...]}`. The server sends `hello`, then `{"type":"data","topic","data"}` and `{"type":"error","topic","message"}`. Types are in `packages/core/src/types/api.ts`.
- **Topics.** Each one delivers exactly the payload of its REST route, so the dashboard can poll the same data when the socket is down:

  | Topic               | Payload                 | REST equivalent           | Read every |
  | ------------------- | ----------------------- | ------------------------- | ---------- |
  | `status`            | `SystemStatus`          | `GET /api/system/status`  | 1 s        |
  | `scanners`          | `ScannersResponse`      | `GET /api/scanners`       | 2 s        |
  | `signals`           | `LiveSignalsResponse`   | `GET /api/signals/live`   | 1 s        |
  | `events`            | `ConnectionEventDto[]`  | `GET /api/system/events`  | 5 s        |
  | `markets:<exchange>`| `MarketsResponse`       | `GET /api/markets/:ex`    | 1 s        |
  | `asset:<code>`      | `AssetDetailResponse`   | `GET /api/assets/:asset`  | 2 s        |

- **Hub.** One read per topic per interval however many clients follow it, only while someone does. A payload is pushed only when it differs from the previous one; a new subscriber gets the last payload at once. Reads never overlap. A failing read is reported to subscribers and logged once per outage, then retried.
- **Limits.** 16 topics per connection, 4 KB client messages, pushes skipped for a client with more than 1 MB buffered, ping every 30 s (a client that misses two is dropped).
- **Why periodic reads rather than Redis pub/sub:** the collector rewrites the market snapshots once per second and the engine its signal mirror on change. Reading Redis once per second per topic gives the same latency without a second publishing path in the collector and engine.
- **Fallback.** While the socket is not open the dashboard polls the REST routes (2–5 s). The top bar shows **live**, **connecting** or **polling**.

## 2. Main page: five working windows

Each window (`apps/web/src/components/ScannerWindow.tsx`) has:

- **Name and operating status:** running, disabled, error, stalled (no run for 2 min), engine down, starting. Hover for details.
- **Key metrics:** active signals (matching / all when filters are on), signals in 24 h, instruments or assets checked in the last run, Telegram state with reason.
- **Warnings** from the scanner (history warming up, invalid stored settings, missing data).
- **Main signals:** the five most significant open signals (largest absolute figure; net spread for spreads), with asset, exchanges, headline figure, analytical direction and age. The asset opens the coin view.
- **Latest updates:** the newest openings, significant updates and resolutions.
- **Buttons:** Filters (inline filter bar), Settings and Details (the detailed view).

## 3. Filters (view only)

The filter bar (`FilterBar.tsx`, logic in `apps/web/src/filters.ts`) filters what a window and its detailed view show. It does not change detection or Telegram; those use the scanner settings. Filters are saved per window in the browser (`localStorage`, key `mip.filters.v1`) and work without storage.

| Filter        | Meaning                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Exchanges     | Signals that involve any selected exchange (both legs count for spreads and funding differences)            |
| Pair          | Part of the asset code or symbol                                                                            |
| Min 24h turnover | Instrument turnover; cross-exchange signals use the smaller leg                                           |
| Min size      | Fair price: top-of-book notional. Open interest: OI × mark. TWAP: executed volume. None for funding and spreads (no single size figure is stored). |

A signal whose turnover or size is unknown is hidden while that minimum is set, because it cannot be shown to pass; the window says how many were hidden that way.

## 4. Detailed view

`ScannerDrawer.tsx` opens over the page (full screen on phones; Escape or the backdrop closes it).

- **Active:** every open signal in a sortable table: common columns (asset, exchanges, direction, opened, updates, Telegram) and scanner columns (`apps/web/src/signalView.tsx`). Click a row for everything stored with the signal (`SignalDetails.tsx`):
  - Fair price: last, mark, index or oracle, bid/ask, deviation, executable edge, fair vs index (warning), book spread, top of book, turnover, funding and next settlement, max leverage, risk and its reasons.
  - Open interest: all four windows with OI change (%, base, $), price change and scenario, or why a window has no value (warming up, no snapshot).
  - Funding: every exchange's rate, interval, 24 h value, next settlement and last settled rate; the long/short legs for differences; mixed USDC/USDT quotes flagged.
  - Spread: both legs, gross and net, the profit breakdown (purchase, sale, fees, funding), VWAP execution and slippage, why it is preliminary, compatibility notes, risk, and every exchange's prices.
  - TWAP: confirmed vs heuristic stated first, side, status, slices, timing, executed volume and its source, VWAP, price change, order size or lower bound, wallet and TWAP parameters (Hyperliquid), pattern metrics and confidence.
- **History:** resolved signals from PostgreSQL, newest first, 50 per page ("Load more" uses the `before` cursor), filterable by exchange and asset on the server; sortable; rows expand like Active.
- **Settings:** see §5.

Every detail view ends with "Analytical signal, not a trading recommendation."

## 5. Settings editor

`SettingsForm.tsx` edits one scanner: enabled, Telegram on/off, filters (exchanges, include/exclude assets, minimum turnover, minimum OI or top of book, maximum book spread), detection thresholds, nested thresholds (OI windows, spread taker fees) and the signal lifecycle.

- The form is built from the **JSON Schema** the API returns with the settings (`settingsJsonSchema` in `packages/core/src/scanner-settings.ts`, from the same zod schema the engine uses): types, bounds, allowed exchanges. Labels, units and help text live in the web app.
- Changed values are highlighted with their default. **Reset to defaults** fills the form; nothing is stored until **Save**.
- Saving sends `PUT /api/scanners/:id/settings`. The server merges nested objects key by key (`mergeSettings`), validates, stores, and the engine applies the change within about a second. Validation problems are shown next to their field.
- Disabling a scanner stops detection; its open signals then resolve after the usual `resolveAfterSec` (they used to stay "active" until it was enabled again).

## 6. Coin details

`GET /api/assets/:asset` (`apps/api/src/assets.ts`) and the `AssetDrawer.tsx` view, opened from any asset name or the ⓘ in the market table:

- Universe entry (rank, market-cap rank and cap) or "not in the monitored universe".
- The asset's instrument on every exchange with live values; the universe mapping is used when the asset is monitored (it is price-checked), the instrument metadata otherwise. An exchange whose snapshot is older than 5 s is listed and its values shown as stale. Prices are per contract base unit with the multiplier shown.
- Open signals of every scanner for the asset (expandable details) and the 30 most recent resolved ones.
- The last 24 h of minute snapshots, one point every 15 min: mark price and open interest sparklines per exchange (gaps where values were missing). Cached 60 s per asset, since snapshots change once a minute.

## 7. Market table

The market-data table now updates over `markets:<exchange>`, sorts by any column (unavailable values last; the choice is saved in the browser), and links each instrument to its coin view.

## 8. API added in this stage

| Endpoint                         | Notes                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /ws`                        | §1                                                                                      |
| `GET /api/signals/live`          | active and recently resolved signals of every scanner (≤ 20 resolved per scanner)       |
| `GET /api/signals?asset=&exchange=` | new filters on the existing route; both validated                                    |
| `GET /api/assets/:asset`         | coin details (§6); asset codes `[A-Za-z0-9._-]{1,30}`                                   |
| `GET /api/scanners/:id/settings` | now also returns `schema` (JSON Schema)                                                 |
| `PUT /api/scanners/:id/settings` | nested objects are merged, so a partial update keeps the keys it leaves out            |

## 9. Shared types

The scanner payloads stored in `SignalDto.data` (`FairPriceData`, `OpenInterestData`, `FundingData`, `SpreadData`, `TwapData` and their parts) moved from the engine to `packages/core/src/types/signal-data.ts`, so the engine and the dashboard compile against the same definitions. `OI_WINDOWS` moved to `types/scanners.ts` for the same reason.

## 10. Other changes in this stage

- Telegram requests time out after 20 s (grammY's default is 500 s). A hanging `getMe` had held up engine startup for minutes.
- `DepthFetcher` (order books for the spread scanner) fails at once while the exchange's REST access is paused, and after 10 s otherwise. During a Binance ban it used to wait on the paused rate limiter, which blocked the whole engine tick, so no scanner ran until the ban ended. The spread is now shown as preliminary with "order book unavailable" instead.

## 11. Verification

- Tests: the realtime hub (one read per topic, change detection, stop when unsubscribed, failure reporting), `/ws` end to end in-process (4401 without a session, 4403 for a foreign Origin, data and unknown-topic errors), coin-detail building (universe vs metadata mapping, stale snapshots, history sampling, code validation), settings merge and JSON Schema, the runner resolving a disabled scanner's signals, and the Telegram timeout.
- The web app has no automated tests. It was checked in the browser against the running Docker stack on 2026-11-18, at desktop and phone width. HANDOFF.md §9 lists what was checked and what was not.
