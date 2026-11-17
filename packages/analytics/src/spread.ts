/** One order-book level: price and size in base units. */
export type Level = readonly [price: number, size: number];

export interface VwapResult {
  /** Volume-weighted average price of the filled part. */
  vwap: number;
  filledQty: number;
  /** False when the visible book holds less than the requested quantity. */
  complete: boolean;
}

/** Walks the book (best level first) to fill `qty` base units. Null if the book is empty. */
export function vwap(levels: readonly Level[], qty: number): VwapResult | null {
  if (!(qty > 0) || levels.length === 0) return null;
  let remaining = qty;
  let cost = 0;
  for (const [price, size] of levels) {
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(size, remaining);
    cost += take * price;
    remaining -= take;
    if (remaining <= 1e-12) break;
  }
  const filledQty = qty - Math.max(remaining, 0);
  if (filledQty <= 0) return null;
  return { vwap: cost / filledQty, filledQty, complete: remaining <= 1e-12 };
}

/** Gross spread when buying at `buyPrice` and selling at `sellPrice`, percent of the buy price. */
export function grossSpreadPct(buyPrice: number, sellPrice: number): number | null {
  if (!(buyPrice > 0) || !Number.isFinite(sellPrice)) return null;
  return ((sellPrice - buyPrice) / buyPrice) * 100;
}

export interface ProfitInput {
  /** Asset units bought on one venue and sold on the other. */
  qty: number;
  buyPrice: number;
  sellPrice: number;
  buyFeeRate: number;
  sellFeeRate: number;
  /** Expected funding paid (positive) or received (negative) over the holding period, quote currency. */
  fundingCost?: number;
}

export interface ProfitBreakdown {
  purchaseCost: number;
  saleProceeds: number;
  grossProfit: number;
  fees: number;
  fundingCost: number;
  netProfit: number;
  /** Net profit as percent of the purchase cost. */
  netPct: number;
}

/**
 * The specified steps: coins → purchase cost → sale proceeds → gross profit → minus both
 * taker fees → minus funding. Slippage is included by passing VWAP prices, not top-of-book.
 */
export function profit(x: ProfitInput): ProfitBreakdown {
  const purchaseCost = x.qty * x.buyPrice;
  const saleProceeds = x.qty * x.sellPrice;
  const grossProfit = saleProceeds - purchaseCost;
  const fees = purchaseCost * x.buyFeeRate + saleProceeds * x.sellFeeRate;
  const fundingCost = x.fundingCost ?? 0;
  const netProfit = grossProfit - fees - fundingCost;
  return {
    purchaseCost,
    saleProceeds,
    grossProfit,
    fees,
    fundingCost,
    netProfit,
    netPct: purchaseCost > 0 ? (netProfit / purchaseCost) * 100 : 0,
  };
}
