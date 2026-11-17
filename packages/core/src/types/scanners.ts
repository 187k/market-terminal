/** The five analytical modules. Each becomes one Telegram bot / topic and one dashboard window. */
export const SCANNER_IDS = ['fair-price', 'open-interest', 'funding', 'spread', 'twap'] as const;

export type ScannerId = (typeof SCANNER_IDS)[number];

/** The four specified Open Interest windows. */
export const OI_WINDOWS = ['5m', '30m', '1h', '4h'] as const;
export type OiWindow = (typeof OI_WINDOWS)[number];

export interface ScannerInfo {
  id: ScannerId;
  name: string;
  summary: string;
}

export const SCANNERS: readonly ScannerInfo[] = [
  {
    id: 'fair-price',
    name: 'Fair Price Scanner',
    summary: 'Market price vs mark / fair price, and fair vs index price.',
  },
  {
    id: 'open-interest',
    name: 'Open Interest Scanner',
    summary: 'Sharp open-interest changes over 5 m, 30 m, 1 h and 4 h.',
  },
  {
    id: 'funding',
    name: 'Funding Rate Scanner',
    summary: 'Extreme funding and cross-exchange differences, normalised to 24 h.',
  },
  {
    id: 'spread',
    name: 'Cross-Exchange Spread Scanner',
    summary: 'Perp–perp price gaps with net spread after fees and slippage.',
  },
  {
    id: 'twap',
    name: 'TWAP / DCA Detector',
    summary: 'Large orders executed as many small trades; heuristic with confidence.',
  },
];
