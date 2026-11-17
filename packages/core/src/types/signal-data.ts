import type { ExchangeId } from './exchanges.js';
import type { OiWindow } from './scanners.js';

/**
 * Scanner-specific details stored in `SignalDto.data`. The engine builds them, the Telegram
 * formatter and the dashboard render them. Signals stored before a field was added may lack it,
 * so readers must tolerate missing optional data.
 */

/** Heuristic risk level: 0–1 reasons = low, 2 = medium, 3+ = high. */
export interface RiskAssessment {
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

export interface FairPriceData extends Record<string, unknown> {
  exchange: string;
  symbol: string;
  asset: string;
  url: string | null;
  last: number;
  mark: number;
  index: number | null;
  indexKind: 'index' | 'oracle';
  bid: number | null;
  ask: number | null;
  deviationPct: number;
  executableEdgePct: number | null;
  fairVsIndexPct: number | null;
  fairIndexWarning: boolean;
  spreadPct: number | null;
  topOfBookUsd: number | null;
  turnover24h: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  nextFundingTime: number | null;
  maxLeverage: number | null;
  maxLeverageNote: string | null;
  quote: string;
  risk: RiskAssessment;
}

/**
 * The four market scenarios of the OI scanner (price × OI direction):
 * 1 = price ↑ OI ↑, 2 = price ↓ OI ↑, 3 = price ↑ OI ↓, 4 = price ↓ OI ↓.
 */
export type OiScenarioId = 1 | 2 | 3 | 4;

export type OiWindowResult =
  | {
      available: true;
      changePct: number;
      changeBase: number;
      changeUsd: number;
      previous: number;
      previousTs: number;
      priceChangePct: number | null;
      scenario: OiScenarioId | null;
    }
  | { available: false; reason: 'warming_up' | 'no_snapshot' };

export interface OpenInterestData extends Record<string, unknown> {
  exchange: string;
  symbol: string;
  asset: string;
  url: string | null;
  direction: 'UP' | 'DOWN';
  primaryWindow: OiWindow;
  windows: Record<OiWindow, OiWindowResult>;
  openInterest: number;
  openInterestUsd: number;
  price: number;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  turnover24h: number | null;
  /** Not collected in this version; available from REST on Bybit, Binance, Bitget and Gate only. */
  longShortRatio: null;
  oiNote: string | null;
}

export interface FundingSettlement {
  /** Settlement time (the nextFundingTime that passed). */
  at: number;
  /** Last live rate observed before that settlement (minute snapshots). */
  rate: number;
}

export interface FundingLegData {
  exchange: ExchangeId;
  symbol: string;
  url: string | null;
  quote: string;
  rate: number;
  intervalHours: number;
  rate24h: number;
  nextFundingTime: number | null;
  lastSettled: FundingSettlement | null;
  mark: number | null;
  turnover24h: number | null;
}

export interface FundingData extends Record<string, unknown> {
  kind: 'extreme' | 'arbitrage';
  asset: string;
  /** Every exchange with fresh funding for this asset, highest 24 h first. */
  legs: FundingLegData[];
  /** extreme: the leg concerned. */
  leg?: FundingLegData;
  /** arbitrage: long the lowest, short the highest 24 h funding. */
  long?: FundingLegData;
  short?: FundingLegData;
  difference24h?: number;
  mixedQuotes?: boolean;
}

/** One exchange's view of the asset, prices per asset unit (multiplier applied). */
export interface SpreadLeg {
  exchange: ExchangeId;
  symbol: string;
  url: string | null;
  quote: string;
  multiplier: number;
  contractSize: number;
  bid: number;
  ask: number;
  /** Raw contract prices (per base unit). */
  rawBid: number;
  rawAsk: number;
  bidSizeAsset: number | null;
  askSizeAsset: number | null;
  mark: number | null;
  index: number | null;
  indexKind: 'index' | 'oracle';
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  funding24h: number | null;
  turnover24h: number | null;
  quoteTs: number;
}

export interface SpreadExecution {
  /** VWAP prices per asset unit for the position; null when the book could not be fetched. */
  buyVwap: number | null;
  sellVwap: number | null;
  buyComplete: boolean;
  sellComplete: boolean;
  /** Slippage vs best price, percent. */
  buySlippagePct: number | null;
  sellSlippagePct: number | null;
  error: string | null;
}

/** Same shape as `ProfitBreakdown` in `@mip/analytics` (which computes it). */
export interface SpreadProfit {
  purchaseCost: number;
  saleProceeds: number;
  grossProfit: number;
  fees: number;
  fundingCost: number;
  netProfit: number;
  /** Net profit as percent of the purchase cost. */
  netPct: number;
}

export interface SpreadData extends Record<string, unknown> {
  asset: string;
  buy: SpreadLeg;
  sell: SpreadLeg;
  legs: SpreadLeg[];
  grossPct: number;
  netPct: number;
  positionUsd: number;
  qty: number;
  breakdown: SpreadProfit;
  buyFeeRate: number;
  sellFeeRate: number;
  holdingHours: number;
  execution: SpreadExecution;
  averagePrice: number;
  /** Each leg's mid vs the average of all mids, percent. */
  deviations: { exchange: ExchangeId; pct: number }[];
  /** Why the result is only an estimate (empty = full calculation). */
  preliminary: string[];
  compatibility: string[];
  risk: RiskAssessment;
}

export interface TwapData extends Record<string, unknown> {
  kind: 'heuristic' | 'confirmed';
  label: string;
  exchange: ExchangeId;
  symbol: string;
  asset: string;
  url: string | null;
  side: 'BUY' | 'SELL';
  status: 'active' | 'completed' | 'cancelled' | 'unknown';
  slices: number;
  firstTs: number;
  lastTs: number;
  executedNotional: number;
  executedQty: number;
  vwap: number;
  priceNow: number | null;
  priceChangePct: number | null;
  /** Heuristic: executed so far (a lower bound). Confirmed: the TWAP order's total size × price. */
  orderNotional: number | null;
  /** Executed share reported by the exchange; only known once the order finished or was stopped. */
  executedPct: number | null;
  /** Active confirmed TWAP: share of its scheduled duration that has elapsed (time-based, not fills). */
  elapsedPct: number | null;
  /** Where executedNotional comes from: the exchange's final figure, or slices we observed. */
  executedSource: 'exchange' | 'observed';
  confidence: number | null;
  wallet: string | null;
  twap: { minutes: number; randomize: boolean; reduceOnly: boolean; startedAt: number } | null;
  /** Confirmed only: how many TWAP orders this wallet has in its history. */
  walletTwapCount: number | null;
  marketCapUsd: number | null;
  turnover24h: number | null;
  metrics: {
    cvInterval: number | null;
    cvSize: number | null;
    medianIntervalMs: number | null;
    oneSided: number | null;
  };
  note: string | null;
}
