/**
 * Opt-in integration tests against the real exchanges: `npm run test:live`
 * (sets LIVE_TESTS=1). For each exchange: load markets, stream BTC and ETH, check that every
 * field the connector promises over WebSocket arrives, then cut the connections as a network
 * failure would and check that they reconnect, re-subscribe and deliver fresh data again.
 *
 * MEXC_REST_URL / MEXC_WS_URL are honoured for networks where MEXC's documented hosts are blocked.
 */
import { describe, expect, it } from 'vitest';
import { EXCHANGE_IDS, type ExchangeId, type MarketField, type MarketUpdate } from '@mip/core';
import type { ExchangeConnector, MarketSink } from './base/connector.js';
import { CONNECTOR_CAPABILITIES, CONNECTOR_FACTORIES } from './registry.js';
import { silentLogger, waitFor } from './test-support/servers.js';

const LIVE = process.env.LIVE_TESTS === '1';
const only = process.env.LIVE_EXCHANGES?.split(',').filter(Boolean);

function endpointsFor(exchange: ExchangeId) {
  if (exchange !== 'mexc') return undefined;
  const e = {
    ...(process.env.MEXC_REST_URL ? { restUrl: process.env.MEXC_REST_URL } : {}),
    ...(process.env.MEXC_WS_URL ? { wsUrl: process.env.MEXC_WS_URL } : {}),
  };
  return Object.keys(e).length > 0 ? e : undefined;
}

describe.skipIf(!LIVE)('live exchanges', () => {
  for (const exchange of EXCHANGE_IDS.filter((e) => !only || only.includes(e))) {
    it(`${exchange}: streams every promised field and recovers from a dropped connection`, async () => {
      const updates: MarketUpdate[] = [];
      const sink: MarketSink = { market: (_e, u) => updates.push(u), instruments: () => undefined };
      const endpoints = endpointsFor(exchange);
      const connector: ExchangeConnector & { dropConnections(reason?: string): void } = CONNECTOR_FACTORIES[
        exchange
      ]!({
        logger: silentLogger,
        sink,
        ...(endpoints ? { endpoints } : {}),
      }) as never;
      try {
        const boot = await connector.loadMarkets();
        expect(boot.instruments.length).toBeGreaterThan(50);
        const pick = (asset: string) => boot.instruments.find((i) => i.asset === asset)?.symbol;
        const symbols = [pick('BTC'), pick('ETH')].filter((s): s is string => Boolean(s));
        expect(symbols).toHaveLength(2);

        const wsFields = (
          Object.entries(CONNECTOR_CAPABILITIES[exchange]!) as [MarketField, { source: string }][]
        )
          .filter(([, c]) => c.source === 'ws')
          .map(([f]) => f);
        const seenSince = (since: number) => {
          const seen = new Set<MarketField>();
          for (const u of updates)
            if (u.connection && u.symbol === symbols[0] && u.receivedAt >= since)
              for (const f of Object.keys(u.values)) seen.add(f as MarketField);
          return seen;
        };

        connector.setTracked(symbols);
        const started = Date.now();
        await connector.start();
        await waitFor(
          () => wsFields.every((f) => seenSince(started).has(f)),
          45_000,
          `${exchange} WS fields`,
        );

        const dropped = Date.now();
        connector.dropConnections('live recovery test');
        await waitFor(
          () => connector.health().connections.every((c) => c.state === 'open' && c.reconnects >= 1),
          60_000,
          `${exchange} reconnected`,
        );
        await waitFor(
          () => wsFields.every((f) => seenSince(dropped + 1).has(f)),
          45_000,
          `${exchange} data after reconnect`,
        );
        const health = connector.health();
        expect(health.state).toBe('ok');
        console.log(
          `${exchange}: ${symbols.join(', ')}; ${updates.filter((u) => u.connection).length} WS updates; ` +
            `reconnected after ${health.connections.map((c) => c.reconnects).join('/')} drop(s) ` +
            `in ${(Date.now() - dropped) / 1000} s including fresh data`,
        );
      } finally {
        await connector.stop();
      }
    }, 240_000);
  }
});
