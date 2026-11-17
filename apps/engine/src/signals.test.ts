import { describe, expect, it } from 'vitest';
import {
  createLogger,
  defaultSettings,
  type CommonSettings,
  type ScannerId,
  type SignalDto,
} from '@mip/core';
import type { Candidate, ScannerDefinition } from './scanners/types.js';
import { SignalEngine, type SignalNotifier, type SignalStore } from './signals.js';

const logger = createLogger({ service: 'test', level: 'silent' });

class MemoryStore implements SignalStore {
  rows = new Map<string, SignalDto>();
  #id = 0;
  async insert(s: SignalDto) {
    const id = String(++this.#id);
    this.rows.set(id, structuredClone({ ...s, id }));
    return id;
  }
  async update(s: SignalDto) {
    this.rows.set(s.id, structuredClone(s));
  }
  async loadOpen(since: number) {
    return [...this.rows.values()]
      .filter((r) => r.status === 'active' || (r.resolvedAt ?? 0) >= since)
      .map((r) => structuredClone(r));
  }
}

class FakeNotifier implements SignalNotifier {
  sent: { scanner: ScannerId; html: string }[] = [];
  edits: { messageId: number; html: string }[] = [];
  reason: string | null = null;
  fail = false;
  unavailableReason() {
    return this.reason;
  }
  async send(scanner: ScannerId, html: string) {
    if (this.fail) throw new Error('Bad Request: chat not found');
    this.sent.push({ scanner, html });
    return 100 + this.sent.length;
  }
  async edit(_s: ScannerId, messageId: number, html: string) {
    this.edits.push({ messageId, html });
  }
}

const def: ScannerDefinition = {
  id: 'fair-price',
  intervalMs: 1000,
  evaluate: () => ({ candidates: [], evaluated: 0, warnings: [] }),
  format: (s, st) => `${st.state}:${s.value}`,
};

const settings: CommonSettings = {
  ...(defaultSettings('fair-price') as CommonSettings),
  confirmSec: 5,
  resolveAfterSec: 60,
  cooldownMinutes: 30,
  minUpdateIntervalSec: 60,
  significantChangePct: 25,
};

const cand = (value: number, key = 'bybit:BTCUSDT:LONG'): Candidate => ({
  key,
  exchange: 'bybit',
  symbol: 'BTCUSDT',
  asset: 'BTC',
  direction: 'LONG',
  value,
  title: `t ${value}`,
  data: { v: value },
});

function setup() {
  const store = new MemoryStore();
  const notifier = new FakeNotifier();
  const engine = new SignalEngine({ store, notifier, logger });
  engine.register(def);
  let now = 1_000_000;
  const step = async (ms: number, ...cs: Candidate[]) => {
    now += ms;
    engine.process('fair-price', settings, cs, now);
    await engine.settle();
  };
  return {
    store,
    notifier,
    engine,
    step,
    get now() {
      return now;
    },
  };
}

describe('SignalEngine', () => {
  it('opens a signal only after the condition held for confirmSec, then sends once', async () => {
    const t = setup();
    await t.step(0, cand(-0.6));
    await t.step(3000, cand(-0.6));
    expect(t.engine.active('fair-price')).toHaveLength(0);
    await t.step(2000, cand(-0.7));
    const [s] = t.engine.active('fair-price');
    expect(s).toMatchObject({ status: 'active', value: -0.7, telegram: { state: 'sent', messageId: 101 } });
    expect(t.notifier.sent).toHaveLength(1);
    expect(t.store.rows.get(s!.id)).toMatchObject({ status: 'active', telegram: { state: 'sent' } });
  });

  it('drops a condition that disappears before confirmation', async () => {
    const t = setup();
    await t.step(0, cand(-0.6));
    await t.step(1000);
    await t.step(5000, cand(-0.6));
    expect(t.engine.active('fair-price')).toHaveLength(0); // the timer restarted
  });

  it('edits the message only on significant change, at most once per minUpdateInterval', async () => {
    const t = setup();
    await t.step(0, cand(-1));
    await t.step(5000, cand(-1));
    await t.step(1000, cand(-1.1)); // +10 %: not significant
    await t.step(1000, cand(-1.5)); // +50 %, but only 2 s after opening
    expect(t.notifier.edits).toHaveLength(0);
    await t.step(60_000, cand(-1.6)); // significant vs the last notified value (-1), interval passed
    expect(t.notifier.edits).toEqual([{ messageId: 101, html: 'active:-1.6' }]);
    expect(t.engine.active('fair-price')[0]!.updates).toBe(1);
    expect(t.engine.active('fair-price')[0]!.peakValue).toBeCloseTo(1.6, 12);
  });

  it('resolves after resolveAfterSec without the condition and edits the message', async () => {
    const t = setup();
    await t.step(0, cand(-1));
    await t.step(5000, cand(-1));
    await t.step(59_000);
    expect(t.engine.active('fair-price')).toHaveLength(1);
    await t.step(2000);
    expect(t.engine.active('fair-price')).toHaveLength(0);
    expect(t.engine.recent('fair-price')[0]).toMatchObject({ status: 'resolved' });
    expect(t.notifier.edits.at(-1)!.html).toBe('resolved:-1');
  });

  it('reopens within the cooldown instead of announcing again; announces anew after it', async () => {
    const t = setup();
    await t.step(0, cand(-1));
    await t.step(5000, cand(-1));
    await t.step(61_000); // resolved
    await t.step(10 * 60_000, cand(-0.9)); // back within 30 min
    expect(t.engine.active('fair-price')).toHaveLength(1);
    expect(t.notifier.sent).toHaveLength(1); // no second message
    expect(t.notifier.edits.at(-1)).toEqual({ messageId: 101, html: 'active:-0.9' });

    await t.step(61_000); // resolved again
    await t.step(31 * 60_000); // cooldown over
    await t.step(0, cand(-1.2));
    await t.step(5000, cand(-1.2));
    expect(t.notifier.sent).toHaveLength(2);
    expect(t.store.rows.size).toBe(2);
  });

  it('keeps separate signals per key', async () => {
    const t = setup();
    await t.step(0, cand(-1), cand(1, 'gate:BTC_USDT:SHORT'));
    await t.step(5000, cand(-1), cand(1, 'gate:BTC_USDT:SHORT'));
    expect(t.engine.active('fair-price')).toHaveLength(2);
    expect(t.notifier.sent).toHaveLength(2);
  });

  it('restores open signals after a restart and does not announce them again', async () => {
    const t = setup();
    await t.step(0, cand(-1));
    await t.step(5000, cand(-1));
    const engine2 = new SignalEngine({ store: t.store, notifier: t.notifier, logger });
    engine2.register(def);
    expect(await engine2.restore(t.now, 86_400_000)).toBe(1);
    engine2.process('fair-price', settings, [cand(-1)], t.now + 1000);
    await engine2.settle();
    expect(engine2.active('fair-price')).toHaveLength(1);
    expect(t.notifier.sent).toHaveLength(1);
  });

  it('records why nothing was sent when Telegram is not configured', async () => {
    const t = setup();
    t.notifier.reason = 'TELEGRAM_CHAT_ID is not set';
    await t.step(0, cand(-1));
    await t.step(5000, cand(-1));
    expect(t.engine.active('fair-price')[0]!.telegram).toEqual({
      state: 'disabled',
      messageId: null,
      detail: 'TELEGRAM_CHAT_ID is not set',
    });
    expect(t.notifier.sent).toHaveLength(0);
  });

  it('marks a failed delivery and keeps the signal', async () => {
    const t = setup();
    t.notifier.fail = true;
    await t.step(0, cand(-1));
    await t.step(5000, cand(-1));
    expect(t.engine.active('fair-price')[0]!.telegram).toMatchObject({
      state: 'failed',
      detail: 'Bad Request: chat not found',
    });
  });

  it('respects notifyTelegram = false', async () => {
    const t = setup();
    t.engine.process('fair-price', { ...settings, notifyTelegram: false, confirmSec: 0 }, [cand(-1)], t.now);
    await t.engine.settle();
    expect(t.engine.active('fair-price')[0]!.telegram.state).toBe('disabled');
    expect(t.notifier.sent).toHaveLength(0);
  });
});
