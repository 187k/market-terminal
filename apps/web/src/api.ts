import type {
  AssetDetailResponse,
  CandleInterval,
  CandlesResponse,
  ConnectionEventDto,
  ExchangeId,
  LiveSignalsResponse,
  MarketsResponse,
  ScannerId,
  ScannerSettingsDto,
  ScannersResponse,
  SessionUser,
  SignalsResponse,
  SystemStatus,
  TerminalLiveResponse,
  UniverseResponse,
} from '@mip/core/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Field-level validation problems ("key.path: message"), when the server sent them. */
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, 'network', 'API unreachable');
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
    problems?: string[];
  } | null;
  if (!res.ok)
    throw new ApiError(
      res.status,
      body?.error ?? 'http_error',
      body?.message ?? `HTTP ${res.status}`,
      body?.problems ?? [],
    );
  return body as T;
}

export const api = {
  me: () => request<SessionUser>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<SessionUser>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  status: () => request<SystemStatus>('/api/system/status'),
  events: () => request<ConnectionEventDto[]>('/api/system/events?limit=30'),
  markets: (exchange: ExchangeId) => request<MarketsResponse>(`/api/markets/${exchange}`),
  universe: () => request<UniverseResponse>('/api/universe'),
  scanners: () => request<ScannersResponse>('/api/scanners'),
  liveSignals: () => request<LiveSignalsResponse>('/api/signals/live'),
  /** Resolved signals from PostgreSQL, newest first; `before` = firstSeenAt cursor of the last row. */
  signalHistory: (q: {
    scanner: ScannerId;
    exchange?: ExchangeId;
    asset?: string;
    before?: number;
    limit?: number;
  }) => {
    const params = new URLSearchParams({
      scanner: q.scanner,
      status: 'resolved',
      limit: String(q.limit ?? 50),
    });
    if (q.exchange) params.set('exchange', q.exchange);
    if (q.asset) params.set('asset', q.asset);
    if (q.before) params.set('before', String(q.before));
    return request<SignalsResponse>(`/api/signals?${params}`);
  },
  settings: (id: ScannerId) => request<ScannerSettingsDto>(`/api/scanners/${id}/settings`),
  saveSettings: (id: ScannerId, body: { enabled?: boolean; settings?: Record<string, unknown> }) =>
    request<ScannerSettingsDto>(`/api/scanners/${id}/settings`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  asset: (code: string) => request<AssetDetailResponse>(`/api/assets/${encodeURIComponent(code)}`),
  terminal: (exchange: ExchangeId, symbol: string, interval: CandleInterval) =>
    request<TerminalLiveResponse>(
      `/api/terminal/${exchange}/${encodeURIComponent(symbol)}?interval=${interval}`,
    ),
  /** Candles opening before `before` (the newest page when omitted), oldest first. */
  candles: (exchange: ExchangeId, symbol: string, interval: CandleInterval, before?: number) =>
    request<CandlesResponse>(
      `/api/terminal/${exchange}/${encodeURIComponent(symbol)}/candles?interval=${interval}${before ? `&before=${before}` : ''}`,
    ),
};
