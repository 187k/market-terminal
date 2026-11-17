export type ExchangeErrorKind =
  /** HTTP 429 or an exchange-specific "too many requests" code. */
  | 'rate_limited'
  /** The IP has been banned (Binance 418, Bybit 403). */
  | 'banned'
  /** Our request was wrong (4xx). Retrying will not help. */
  | 'client'
  /** 5xx from the exchange. */
  | 'server'
  | 'timeout'
  /** DNS / TCP / TLS failure. */
  | 'network'
  /** Response body could not be parsed. */
  | 'decode'
  /** HTTP 200 with an error code in the body. */
  | 'exchange'
  | 'aborted';

const RETRYABLE: ReadonlySet<ExchangeErrorKind> = new Set(['rate_limited', 'server', 'timeout', 'network']);

export interface ExchangeErrorDetails {
  exchange?: string;
  method?: string;
  path?: string;
  status?: number;
  /** Exchange business error code, when present. */
  code?: string | number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ExchangeApiError extends Error {
  readonly kind: ExchangeErrorKind;
  readonly details: ExchangeErrorDetails;

  constructor(kind: ExchangeErrorKind, message: string, details: ExchangeErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ExchangeApiError';
    this.kind = kind;
    this.details = details;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}
