import { publishSettingsChanged, readScannerStatus, readSignals, type Redis } from '@mip/bus';
import {
  defaultSettings,
  LIVE_RECENT_PER_SCANNER,
  mergeSettings,
  parseScannerSettings,
  SCANNER_IDS,
  settingsJsonSchema,
  type ExchangeId,
  type LiveSignalsResponse,
  type ScannerId,
  type ScannerSettingsDto,
  type ScannersResponse,
  type SignalDto,
} from '@mip/core';
import { signalRowToDto, type Prisma, type PrismaClient } from '@mip/db';

export interface SignalQuery {
  scanner?: ScannerId;
  status?: 'active' | 'resolved';
  /** Asset code, e.g. "BTC". */
  asset?: string;
  exchange?: ExchangeId;
  limit: number;
  before?: number;
}

export interface ScannerSource {
  scanners(): Promise<ScannersResponse>;
  /** Active signals come from the engine's live state; history from PostgreSQL. */
  signals(q: SignalQuery): Promise<SignalDto[]>;
  /** Active and recently resolved signals of every scanner, from the engine's live state. */
  liveSignals(): Promise<LiveSignalsResponse>;
  getSettings(id: ScannerId): Promise<ScannerSettingsDto>;
  putSettings(
    id: ScannerId,
    body: { enabled?: unknown; settings?: unknown },
  ): Promise<{ ok: true; value: ScannerSettingsDto } | { ok: false; problems: string[] }>;
}

export function createScannerSource(redis: Redis, prisma: PrismaClient): ScannerSource {
  const settingsDto = async (id: ScannerId): Promise<ScannerSettingsDto> => {
    const row = await prisma.scannerSetting.findUnique({ where: { scanner: id } });
    const parsed = parseScannerSettings(id, row?.settings ?? {});
    return {
      scanner: id,
      enabled: row?.enabled ?? true,
      settings: parsed.ok ? parsed.settings : defaultSettings(id),
      defaults: defaultSettings(id),
      schema: settingsJsonSchema(id),
      updatedAt: row?.updatedAt.getTime() ?? null,
    };
  };

  return {
    async scanners() {
      const stored = await readScannerStatus(redis);
      return { scanners: stored?.scanners ?? [], updatedAt: stored?.ts ?? null };
    },

    async signals(q) {
      // Active signals come from the engine's live state (the database lags by up to 30 s).
      if (q.status === 'active') {
        const ids = q.scanner ? [q.scanner] : SCANNER_IDS;
        const lists = await Promise.all(ids.map(async (id) => (await readSignals(redis, id))?.active ?? []));
        return lists
          .flat()
          .filter((s) => (!q.asset || s.asset === q.asset) && (!q.exchange || s.exchange === q.exchange))
          .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
          .slice(0, q.limit);
      }
      const where: Prisma.SignalWhereInput = {
        ...(q.scanner ? { scanner: q.scanner } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.asset ? { asset: q.asset } : {}),
        ...(q.exchange ? { exchange: q.exchange } : {}),
        ...(q.before ? { firstSeenAt: { lt: new Date(q.before) } } : {}),
      };
      const rows = await prisma.signal.findMany({ where, orderBy: { firstSeenAt: 'desc' }, take: q.limit });
      return rows.map(signalRowToDto);
    },

    async liveSignals() {
      const stored = await Promise.all(SCANNER_IDS.map((id) => readSignals(redis, id)));
      const byNewest = (a: SignalDto, b: SignalDto) => b.firstSeenAt - a.firstSeenAt;
      return {
        active: stored.flatMap((s) => s?.active ?? []).sort(byNewest),
        recent: stored
          .flatMap((s) => (s?.recent ?? []).slice(0, LIVE_RECENT_PER_SCANNER))
          .sort((a, b) => (b.resolvedAt ?? b.lastSeenAt) - (a.resolvedAt ?? a.lastSeenAt)),
        updatedAt: stored.reduce<number | null>(
          (max, s) => (s && (max === null || s.ts > max) ? s.ts : max),
          null,
        ),
      };
    },

    getSettings: settingsDto,

    async putSettings(id, body) {
      const current = await settingsDto(id);
      const submitted = body.settings ?? {};
      if (typeof submitted !== 'object' || Array.isArray(submitted) || submitted === null)
        return { ok: false, problems: ['settings: must be an object'] };
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
        return { ok: false, problems: ['enabled: must be true or false'] };
      // Nested objects are merged, so a partial update never resets the keys it left out.
      const parsed = parseScannerSettings(
        id,
        mergeSettings(current.settings, submitted as Record<string, unknown>),
      );
      if (!parsed.ok) return { ok: false, problems: parsed.problems };
      const enabled = body.enabled ?? current.enabled;
      await prisma.scannerSetting.upsert({
        where: { scanner: id },
        create: {
          scanner: id,
          enabled,
          settings: parsed.settings as Prisma.InputJsonValue,
          updatedAt: new Date(),
        },
        update: { enabled, settings: parsed.settings as Prisma.InputJsonValue, updatedAt: new Date() },
      });
      await publishSettingsChanged(redis, id);
      return { ok: true, value: await settingsDto(id) };
    },
  };
}

export const isScannerId = (v: string): v is ScannerId => (SCANNER_IDS as readonly string[]).includes(v);
