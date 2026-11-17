# Stage 6: final testing

Date: 2026-11-18, on the development PC (Windows 11, Docker Desktop, Cloudflare WARP). Spec: `prompt.md` §8, Stage 6. This records what was verified, how, the results, and what is left for the production server.

Two tools were added for this stage and for the server. Both are read-only: no exchange or Telegram traffic.

- `npm run verify` (`tools/verify-live.ts`): freshness of every exchange; each asset's price per coin on every exchange against the cross-exchange median; field sanity; every open and recent signal recomputed from its stored inputs with `@mip/analytics`; history coverage. Exits 1 on a hard failure.
- `npm run soak -- --minutes N` (`tools/soak.ts`): samples exchange health, process heartbeats, scanner runs, container CPU and memory, Redis memory, `/api/health` latency, and the Telegram outcome of new signals. Writes `soak/<start>.jsonl` and a summary.

## 1. Integrations

| Integration                 | Result                                                                                                                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seven exchanges             | All seven `ok` and fully fresh (`npm run verify`, 04:03 local): Bybit 92/92, Binance 88/88, MEXC 88/88, Hyperliquid 73/73, Bitget 92/92, BingX 90/90, Gate 96/96 instruments.                                                                                                                  |
| MEXC through WARP           | Fixed without code: WARP split-tunnel host exclusions for `contract.mexc.com` and `api.mexc.com`. **Verified that they apply to Docker Desktop containers**: MEXC went from 0/88 to 88/88.                                                                                                     |
| Telegram                    | All five bots are administrators of the forum group and can read it (`getChat`). The configured chat ID was wrong ("chat not found") and was corrected. First real messages delivered (TWAP). The other topics: see §6.                                                                         |
| Dashboard (REST, WebSocket) | Checked in the browser in Stage 5. **Polling fallback** checked now: with every WebSocket made to fail in the tab and the API restarted, the badge showed **polling** and the data kept refreshing over REST every 2 s. With WebSockets allowed again it was back to **live** within 16 s. |
| PostgreSQL backups          | The `backup` service wrote a dump in 1.5 s (220 KB without snapshot data). **Restore drill:** restored into a scratch database in 0.3 s with identical row counts (100 signals, 10,633 connection events, 619 instruments, 4 migrations); snapshot data empty as designed; scratch database dropped. |

## 2. Calculation correctness (live data)

`npm run verify` against the running system:

- **Prices across exchanges:** 615 instruments of 96 assets, price per coin (contract price ÷ multiplier) against the median of all exchanges. Largest gap 0.36 % (FLR on Gate); none above 0.5 %. A wrong multiplier or mapping would show as a gap of 10× or more.
- **Field sanity**, fresh values on every exchange: bid < ask, last within 2 % of mark, funding interval 1/2/4/8 h, |funding| < 3 % per interval, OI > 0, next funding within 9 h. **No violations.**
- **Signals recomputed from their stored inputs** with the same `@mip/analytics` functions: fair price 52 checks, OI 30, funding 234, spread 4, TWAP 28. **0 mismatches.** These checks confirm the engine fed the right fields, in the right units (per-coin prices, base-unit OI, real funding intervals), to the right formula.
- **OI 4 h window:** covered (no "warming up" warning). 146 of the last 245 minutes were stored because the PC slept from 01:03 to 02:43 (Windows Kernel-Power events 42 and 1). This is not a software gap.
- **Funding settlements observed end to end:** 86 of 146 funding legs in current signals carry the last settled rate read from the snapshot history, e.g. Bybit LITUSDT settled 20:00 UTC at 0.0050 %.

Unit tests cover every formula (`packages/analytics`) and every scanner on synthetic and recorded real data (Stage 4).

## 3. Connection stability

- Stage 3: all seven exchanges reconnected within 0.8–2.9 s after their connections were cut (`npm run test:live`). Two soaks of 45 and 24 minutes passed.
- **Exchange ban handling, observed live** (Binance 418 on the shared WARP IP, paused until 05:45:49):
  - The collector and engine send no Binance REST requests during the ban. The ban persists in Redis across restarts.
  - A collector restarted during the ban waits for it to end before loading Binance's instruments ("waiting for the exchange's ban / rate limit to end"). Binance therefore stays offline until then.
  - The engine's spread scanner reports Binance order books as unavailable and labels the result preliminary. Until a fix in Stage 5 it waited on the ban and stalled every scanner.
- Soak on the development PC: §5.

## 4. Performance

Measured on the development PC with 100 assets (619 instruments), all seven exchanges:

| Measure                          | Value                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Market updates                   | about 2,500 per second in total (Bitget about 850, BingX 425, Gate 435, Hyperliquid 290, Binance 270, Bybit 260, MEXC 35) |
| Scanner run time (p50 / p95 / max) | fair price 0.1 / 0.3 / 0.3 ms; OI 0.4 / 7 / 7 ms; funding 2 / 4 / 107 ms; spread 0.6 / 111 / 426 ms (order-book fetches); TWAP 38 / 54 / 56 ms |
| `/api/health` latency            | p50 7 ms, p95 13 ms                                                                                    |
| Redis memory                     | 35 MB                                                                                                  |
| PostgreSQL                       | 58 MB in total; per-minute snapshots about 175 bytes per instrument-minute, about 150 MB per day, capped near 1.1 GB by the 7-day retention |
| Containers (memory, CPU of one core) | see §5                                                                                              |

## 5. Soak on the development PC

To be filled in when the soak finishes.

## 6. Telegram

- **Setup problems found and fixed:**
  - The configured chat ID did not belong to the group the bots were in ("chat not found" for all five). It was replaced with the group's ID read from the bots' own updates.
  - The first TWAP bot returned 502 Bad Gateway for every Bot API call while the others worked; the user replaced it.
- **Delivery** for signals opened after the fix (from 03:56 local): funding 1, open interest 1, TWAP 4 messages sent, 0 failed. One TWAP message was edited after a significant change, and the OI message got its "resolved" edit. A failed edit marks the signal `failed`, and none did.
- **Not yet seen:** a fair-price or spread message. Those scanners have not opened a signal since the fix, so their topic IDs are unconfirmed.
- Signals that failed during the misconfiguration are not re-sent. This is by design: a message posted hours late would mislead.
- Pacing (1 message per 1.1 s and 18 per minute per bot), 429 `retry_after`, "message is not modified" and rejected tokens are covered by tests against a fake Bot API. So are the new 5xx retry and the no-retry-on-timeout rule.

## 7. Production configuration

`docker-compose.prod.yml` with `docker/Caddyfile` and `docker/backup.sh`; operating guide in [deployment.md](deployment.md).

- `docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app config --quiet` is valid. Published ports: Caddy 80/443 (and 443/udp) only. PostgreSQL and Redis stay on 127.0.0.1, the dashboard container has no host port, the API gets `COOKIE_SECURE=true`, and every service has log rotation (10 MB × 5).
- Missing `DOMAIN` or `POSTGRES_PASSWORD` stops `docker compose` with a message naming the variable.
- The API logs `insecure setting: …` in production for an example or short dashboard password (< 12), a short or example session secret (< 32), `COOKIE_SECURE=false`, or the default database password. Locally it currently reports the last two, as expected on localhost.
- **Not run here:** Caddy with a real certificate (needs a public DNS name and open ports 80/443).

## 8. Fixed in this stage

- **No retention for `connection_events` and `signals`.** Connection events are now kept 30 days (`CONNECTION_EVENT_RETENTION_DAYS`, purged hourly by the collector). Resolved signals are kept 90 days (`SIGNAL_RETENTION_DAYS`, minimum 8 because restarts restore 7 days, purged hourly by the engine). Open signals are never deleted.
- **Telegram 5xx lost messages.** A 502 from the Bot API marked a signal's message as failed for good. The notifier now retries Telegram 5xx and failed connections up to 3 times (2, 4 and 8 s). It does not retry a timed-out request, which Telegram may already have posted.
- **The engine ignored `MEXC_REST_URL`** for order books. It now reads it.
- **Documentation error about multipliers.** CLAUDE.md said to multiply prices by the multiplier for a per-coin price, and the coin view's footnote said the same. The code divides prices and multiplies sizes, which is correct; both texts are corrected.

## 9. Left for the production server

- A 24 h soak (`npm run soak -- --minutes 1440`). The PC sleeps when idle, so long runs here are not meaningful.
- Caddy issuing and renewing the certificate for the real domain; the dashboard over HTTPS with `COOKIE_SECURE=true`.
- Telegram: a message in every topic, an edit after a significant change, and the "resolved" edit.
- Copying backups off the server (rsync or object storage), which depends on the hosting.
