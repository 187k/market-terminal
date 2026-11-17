import type { ExchangeId, ScannerId, SignalDto, TelegramState } from '@mip/core';
import type { Signal } from './generated/prisma/client.js';

/** Converts a `signals` row to the DTO shared by the engine, the API and the dashboard. */
export function signalRowToDto(r: Signal): SignalDto {
  return {
    id: r.id.toString(),
    scanner: r.scanner as ScannerId,
    key: r.key,
    exchange: (r.exchange as ExchangeId | null) ?? null,
    symbol: r.symbol,
    asset: r.asset,
    direction: r.direction,
    title: r.title,
    value: r.value,
    peakValue: r.peakValue,
    status: r.status === 'resolved' ? 'resolved' : 'active',
    firstSeenAt: r.firstSeenAt.getTime(),
    lastSeenAt: r.lastSeenAt.getTime(),
    resolvedAt: r.resolvedAt?.getTime() ?? null,
    updates: r.updates,
    data: (r.data ?? {}) as Record<string, unknown>,
    telegram: {
      state: r.telegramState as TelegramState,
      messageId: r.telegramMessageId,
      detail: r.telegramDetail,
    },
  };
}
