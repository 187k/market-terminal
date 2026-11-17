/** The exchanges the platform integrates with. Order is the display order. */
export const EXCHANGE_IDS = ['bybit', 'binance', 'mexc', 'hyperliquid', 'bitget', 'bingx', 'gate'] as const;

export type ExchangeId = (typeof EXCHANGE_IDS)[number];

export const EXCHANGE_NAMES: Readonly<Record<ExchangeId, string>> = {
  bybit: 'Bybit',
  binance: 'Binance',
  mexc: 'MEXC',
  hyperliquid: 'Hyperliquid',
  bitget: 'Bitget',
  bingx: 'BingX',
  gate: 'Gate',
};

export function isExchangeId(value: string): value is ExchangeId {
  return (EXCHANGE_IDS as readonly string[]).includes(value);
}
