# Stage 3 — Exchange connectors

Date: 2026-11-17. All seven connectors are implemented, tested on recorded real payloads and verified live (streaming, field coverage, recovery from dropped connections). This document records what each connector actually uses, which Stage 1 questions were resolved, and what is still open.

Tags as in Stage 1: **[L]** verified live · **[D]** documented · **[O]** observed, undocumented · **[?]** still unverified.

## 1. Normalised model

Every connector maps its payloads onto the same twelve fields (`packages/core/src/types/market.ts`). Units are fixed:

| Field | Unit / meaning |
|---|---|
| `last`, `mark`, `index`, `bid`, `ask` | quote currency per **base unit** of the contract (e.g. per one "1000PEPE"); `InstrumentInfo.multiplier` converts to the asset |
| `bidSize`, `askSize` | base units (contracts already multiplied out) |
| `openInterest` | **one side** (long = short), base units |
| `fundingRate` | fraction per funding interval (0.0001 = 0.01 %) |
| `fundingIntervalHours`, `nextFundingTime` | hours; Unix ms |
| `turnover24h` | 24 h traded value in quote currency (USDC on Hyperliquid) |

Missing values are never filled in. Each field the collector publishes is either available (value + time) or unavailable with a reason: `not_provided`, `requires_api_key`, `not_received`, `stale`, `invalid`, `not_implemented`.

**Freshness** is judged per field from each connector's declared capabilities:
- a value delivered by a connection that later dropped is `stale` until fresh data arrives on the new connection;
- `change` fields (pushed only when they change) stay valid while messages for that symbol keep arriving **on the same connection**, with a backstop (5 min; 60 s on Binance) against a silently dead subscription. Activity is tracked per connection so one busy stream cannot vouch for another, silent one;
- a REST snapshot (bootstrap, 15-min re-sync) only fills gaps in fields a WebSocket maintains; it never takes over a field whose stream is up. Otherwise rarely-changing values (funding interval) were relabelled as REST data and aged out, because change-only streams do not resend them (found in the soak test, fixed, covered by tests);
- `interval` fields (polled, or pushed on a timer) go stale after their `maxAgeMs`;
- the API reports every value as stale if the collector has not published for 5 s.

**Validation** rejects non-finite numbers, non-positive prices, negative sizes, |funding| > 10 % per interval, intervals outside (0, 24] h and next-funding times outside [now − 6 h, now + 7 d]. Rejected values are counted per exchange and shown in the dashboard.

**Out-of-order protection**: within one connection, an update older (by exchange time) than the stored value is dropped, e.g. during a planned connection rotation. Timestamps from different sources are not compared: a REST response carries its response time while a WebSocket snapshot carries the time the value last changed, and comparing them discarded fresh snapshots of quiet contracts (found live, fixed, covered by a test).

## 2. Field availability as implemented

`ws` = WebSocket push · `rest` = REST poll · `derived` = computed from documented rules · `—` = not available (reason in the cell).

| Field | Bybit | Binance | MEXC | Hyperliquid | Bitget | BingX | Gate |
|---|---|---|---|---|---|---|---|
| last | ws | ws (24 h ticker, ≤ 2 s, on change) | ws | ws (latest trade) | ws | ws | ws |
| mark | ws | ws (1 s) | ws `fairPrice` | ws `markPx` | ws | ws | ws |
| index | ws | ws (1 s) | ws | ws **oracle price** (no index exists) | ws | rest `premiumIndex` 5 s | ws |
| bid / ask | ws | ws top-5 depth, ≤ 500 ms, on change | ws | ws `bbo` | ws | ws `bookTicker` | ws `book_ticker` |
| bid / ask size | ws | ws | — not in the ticker; depth stream not subscribed | ws | ws | ws | ws (contracts × multiplier) |
| open interest | ws `singleOpenInterest` | rest, per symbol, 30 s | ws `holdVol` × contractSize | ws | ws `holdingAmount` | rest, per symbol, 60 s, **notional ÷ mark** | ws `total_size` / 2 × multiplier |
| funding rate | ws | ws (1 s) | ws | ws (hourly rate) | ws | rest 5 s | ws |
| funding interval | ws | rest `fundingInfo` (default 8 h) | rest 60 s | derived: 1 h | rest 15 min | rest 5 s | ws |
| next funding | ws | ws | rest 60 s | derived: next full hour | ws | rest 5 s | ws |
| 24 h turnover | ws | ws | ws | ws (USDC) | ws | ws | ws |
| max leverage | instruments | **needs API key** | contract detail | meta | contracts | — not public | contracts |
| Quote | USDT | USDT | USDT | **USDC** | USDT | USDT | USDT |

## 3. Instrument filters (crypto USDT perpetuals only)

| Exchange | Rule | Tradable after filter (2026-11-17) |
|---|---|---|
| Bybit | `LinearPerpetual`, `Trading`, USDT, `symbolType` ∈ {"", "innovation"} (excludes stock 238, ETF 59, commodity, forex) | 516 |
| Binance | `PERPETUAL`, `TRADING`, USDT-margined, `underlyingType = COIN` (excludes 237 TradFi, index, pre-market) | 519 |
| MEXC | `futureType = 1`, `state = 0`, not hidden, USDT. No machine-readable TradFi flag found [?] | 1,070 |
| Hyperliquid | main dex only, not `isDelisted` (builder dexes are not loaded) | 179 |
| Bitget | `perpetual`, `normal`, USDT, `isRwa ≠ YES` (excludes 422 RWA) | 464 |
| BingX | `status = 1`, USDT, not prefixed NCFX / NCCO / NCSK / NCSI (forex, commodities, stocks, indices: 741) | 550 |
| Gate | `trading`, not delisting, not pre-market, `contract_type = ""` (excludes stocks 453, indices, commodities, forex, metals) | 559 |

Non-crypto contracts that slip through a filter (MEXC) cannot enter the universe unless their ticker matches a top-N crypto asset **and** passes the price check below.

## 4. Instrument universe

- Ranking: CoinGecko market cap (`/coins/markets`), excluding the categories stablecoins, wrapped, bridged, liquid staking, liquid restaking and tokenised commodities. Top N = 100 (configurable), refreshed daily, stored in PostgreSQL and reused after a restart.
- Mapping: by asset code after removing multiplier prefixes (`1000PEPE`, `1MBABYDOGE`, `kPEPE` → PEPE). An instrument counts only if (1) its asset price is within 15 % of the median across exchanges and (2) that median is within 15 % of CoinGecko's price, or within 50 % when the CoinGecko data is over an hour old. One instrument per exchange per asset.
- Fallbacks: CoinGecko down → last stored ranking (with a warning); nothing stored → rank by summed 24 h perp turnover (no market cap).
- Result on 2026-11-17: 100 assets → 620 instruments, 0 mapping problems. Per exchange: Bybit 92, Binance 88, MEXC 87, Hyperliquid 75, Bitget 92, BingX 89, Gate 96.
- Without an API key CoinGecko answered HTTP 429 (Retry-After 60 s) after 5 rapid calls [L]; the client paces itself at 5 calls / 65 s, so the first build takes about 90 s. A Demo key raises the configured limit to 30 / min (per CoinGecko's plan description; not verified with a key).

## 5. Stage 1 questions: resolved

| Question | Answer |
|---|---|
| Bybit OI: why is `openInterest` 2× `singleOpenInterest`? | Docs: `openInterest` = both sides, `singleOpenInterest` = one side [D]. We use one side. |
| Gate OI: `total_size` = 2× `position_size`? | Yes on every contract checked [L]; docs define `position_size` as total long position [D]. One side = `total_size` / 2. |
| Binance funding interval for unlisted symbols | `fundingInfo` lists only adjusted symbols [D]; others are 8 h. |
| Binance WebSocket routing | `/public` for book data, `/market` for mark price and tickers [D][L]. The all-market streams now merge UM and COIN-M (`st` field) [D]; we use per-symbol streams, which are unaffected. |
| Binance book ticker volume | ~1,000 messages/s for three symbols [L]; replaced by top-5 depth every 500 ms. |
| Binance per-symbol 24 h ticker | Pushes at most every 2 s and **only on change** [L]; treated as a change-driven stream. |
| MEXC ping rule | Ping every 10–20 s; closed after 1 min without one [D]. |
| MEXC REST host | Docs give `https://api.mexc.com` for futures [D] (default now). |
| MEXC bulk funding rates | `/contract/funding_rate` without a symbol returns all contracts [L, undocumented]; per-symbol fallback implemented. |
| MEXC ticker timing | Pushes about every 2–3 s per symbol; values are ~2.4 s old on arrival (exchange timestamp vs receive time) [L]. |
| Hyperliquid OI unit | Base coin; BTC ≈ 36.8 k, the same order as other venues' one-sided figures [L]. |
| Hyperliquid next funding | `predictedFundings` returned a `nextFundingTime` already in the past for Hyperliquid itself [L]; the documented hourly schedule is used instead. |
| BingX non-crypto contracts | Four prefix families: NCFX 42, NCCO 27, NCSK 658, NCSI 14 [L]. |
| Bitget trade channel change (2026-11-17) | Not relevant yet: trades are not subscribed in Stage 3 (TWAP detector, Stage 4.5). |

## 6. Still open

| Item | Status / handling |
|---|---|
| BingX open-interest unit | Not stated in the docs read. BTC returned 6.9 × 10⁸; as coins that is impossible, as contracts × 0.0001 it would be 69 k BTC (more than Bybit), as USDT notional 10.7 k BTC. Treated as USDT notional ÷ mark, labelled `derived` [O]. |
| Bitget `holdingAmount`: one side? | Magnitude (BTC ≈ 37 k) matches other venues' one-sided figures; not confirmed in the docs [?]. |
| MEXC subscription limits per connection | Not documented [?]; 50 topics per connection used. |
| Gate `X-Gate-Size-Decimal` on WebSocket | Sent on REST and on the WS handshake; whether WS honours it is unverified [?] (affects 15 contracts with fractional sizes). |
| Funding: live rate = estimate for the next settlement? | To be checked against funding history at a settlement (Stage 4.3). |
| Max leverage: Binance | Needs a read-only key (signing implemented and tested with the documented example; not run live, no key yet). BingX: not public. |
| Absolute OI across exchanges | Still not comparable until Bitget and BingX conventions are confirmed; percentage changes are unaffected. |

## 7. Live findings on this development machine

- **Network:** outbound traffic goes through Cloudflare WARP (`warp=on`, Singapore exit). Binance had banned two WARP exit IPs with HTTP 418 (about 3.4 h) because of other users' traffic; our own requests were a few hundred weight. MEXC refuses `contract.mexc.com` (REST 403 "Access Denied", WS 403) from these exits; `api.mexc.com` (REST) and `contract.mexc.co` (WS, not documented as an API host) work. A server with its own IP will not have these problems. `MEXC_REST_URL` / `MEXC_WS_URL` exist only for such networks.
- **Bans are respected, also across restarts:** REST limiters are shared per exchange across connector restarts; after a ban the supervisor waits for the exchange's Retry-After before trying again; and the ban end is stored in Redis (`mip:pause:<exchange>`), so a restarted collector sends nothing until it has passed. This last part was added after the soak: Binance extended a WARP ban from 81 minutes to about 5.7 hours after several process restarts each sent one request into the active ban.
- **Clock:** this PC's clock is ~0.25 s behind the exchanges (measured against Bybit server time). Freshness uses local receive times only, so validity is unaffected; the dashboard's "Delay" column includes the offset. Enable time synchronisation on the server.
- **Recovery:** `npm run test:live` cut every connection of every exchange; all reconnected, re-subscribed and delivered every promised field again within 0.8–2.9 s. The collector also recovered on its own from two sleep/wake cycles of this PC.
- **Load (100-asset universe):** about 2,500 normalised updates per second across the seven exchanges; Bitget is the busiest (~850/s).

### Soak tests (2026-11-17, PC kept awake)

| Run | Duration | Result |
|---|---|---|
| 1 | 45 min, sampled every minute | Every exchange `ok` in every sample; 0 reconnects; 0 values rejected. Bitget, BingX, Gate, MEXC 100 % fresh. Found two freshness bugs: the 15-min REST re-sync took over Bybit fields maintained by the stream (funding interval / next funding went stale), and Binance's top-5 book can go > 10 s without a push. Both fixed. |
| 2 | 24 min (spans one 15-min re-sync) | Bybit, MEXC, Bitget, BingX, Gate 100 % fresh throughout; 0 reconnects; 0 rejected. Hyperliquid 74/74 after a 20 s subscription warm-up (now ~15 s). Binance: WS data 100 % fresh; at 02:09 the WARP exit IP was banned again (HTTP 418, 81 min) at ~100 requests/min of our own against a 2,400 limit, so open interest correctly turned `stale` while REST was paused. |

A 24 h soak has not been run: this PC sleeps when idle, and an earlier overnight run turned out to be ~10 minutes of activity between two sleep periods (it did show that every connector recovers on its own after the PC wakes). The 24 h run belongs on the server.
