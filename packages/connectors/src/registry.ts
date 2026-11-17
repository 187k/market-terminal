import type { ExchangeCapabilities, ExchangeId } from '@mip/core';
import type { ConnectorFactory } from './base/connector.js';
import { BINANCE_CAPABILITIES, BinanceConnector } from './binance/index.js';
import { BINGX_CAPABILITIES, BingxConnector } from './bingx/index.js';
import { BITGET_CAPABILITIES, BitgetConnector } from './bitget/index.js';
import { BYBIT_CAPABILITIES, BybitConnector } from './bybit/index.js';
import { GATE_CAPABILITIES, GateConnector } from './gate/index.js';
import { HYPERLIQUID_CAPABILITIES, HyperliquidConnector } from './hyperliquid/index.js';
import { MEXC_CAPABILITIES, MexcConnector } from './mexc/index.js';

/** Concrete connectors. Adding an exchange = one folder + one entry in each map. */
export const CONNECTOR_FACTORIES: Partial<Record<ExchangeId, ConnectorFactory>> = {
  bybit: (ctx) => new BybitConnector(ctx),
  binance: (ctx) => new BinanceConnector(ctx),
  mexc: (ctx) => new MexcConnector(ctx, ctx.endpoints),
  hyperliquid: (ctx) => new HyperliquidConnector(ctx),
  bitget: (ctx) => new BitgetConnector(ctx),
  bingx: (ctx) => new BingxConnector(ctx),
  gate: (ctx) => new GateConnector(ctx),
};

/** Which fields each exchange provides and how (static per connector). */
export const CONNECTOR_CAPABILITIES: Partial<Record<ExchangeId, ExchangeCapabilities>> = {
  bybit: BYBIT_CAPABILITIES,
  binance: BINANCE_CAPABILITIES,
  mexc: MEXC_CAPABILITIES,
  hyperliquid: HYPERLIQUID_CAPABILITIES,
  bitget: BITGET_CAPABILITIES,
  bingx: BINGX_CAPABILITIES,
  gate: GATE_CAPABILITIES,
};
