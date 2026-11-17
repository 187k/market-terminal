import type { SignalDto } from '@mip/core';
import { signalRowToDto, type Prisma, type PrismaClient } from '@mip/db';
import type { SignalStore } from './signals.js';

function columns(s: SignalDto) {
  return {
    title: s.title,
    value: s.value,
    peakValue: s.peakValue,
    status: s.status,
    lastSeenAt: new Date(s.lastSeenAt),
    resolvedAt: s.resolvedAt === null ? null : new Date(s.resolvedAt),
    updates: s.updates,
    data: s.data as Prisma.InputJsonValue,
    telegramState: s.telegram.state,
    telegramMessageId: s.telegram.messageId,
    telegramDetail: s.telegram.detail,
  };
}

export class PrismaSignalStore implements SignalStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(s: SignalDto): Promise<string> {
    const row = await this.prisma.signal.create({
      data: {
        scanner: s.scanner,
        key: s.key,
        exchange: s.exchange,
        symbol: s.symbol,
        asset: s.asset,
        direction: s.direction,
        firstSeenAt: new Date(s.firstSeenAt),
        ...columns(s),
      },
      select: { id: true },
    });
    return row.id.toString();
  }

  async update(s: SignalDto): Promise<void> {
    if (!s.id) return; // the insert failed; nothing to update
    await this.prisma.signal.update({ where: { id: BigInt(s.id) }, data: columns(s) });
  }

  async loadOpen(resolvedSince: number): Promise<SignalDto[]> {
    const rows = await this.prisma.signal.findMany({
      where: { OR: [{ status: 'active' }, { resolvedAt: { gte: new Date(resolvedSince) } }] },
      orderBy: { firstSeenAt: 'desc' },
      take: 5_000,
    });
    return rows.map(signalRowToDto);
  }

  /** Deletes resolved signals that resolved before `before`; open signals are never deleted. */
  async purgeResolved(before: number): Promise<number> {
    const { count } = await this.prisma.signal.deleteMany({
      where: { status: 'resolved', resolvedAt: { lt: new Date(before) } },
    });
    return count;
  }

  /** Signals opened in the last 24 h, per scanner. */
  async counts24h(now: number): Promise<Map<string, { count: number; last: number | null }>> {
    const rows = await this.prisma.signal.groupBy({
      by: ['scanner'],
      where: { firstSeenAt: { gte: new Date(now - 86_400_000) } },
      _count: { _all: true },
      _max: { firstSeenAt: true },
    });
    return new Map(
      rows.map((r) => [r.scanner, { count: r._count._all, last: r._max.firstSeenAt?.getTime() ?? null }]),
    );
  }
}
