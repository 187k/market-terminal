// Soak monitor (Stage 6): samples the running system at a fixed interval and writes a summary.
// Read-only: Redis, PostgreSQL, `docker stats` and the public /api/health route. Prints no secrets.
//
//   npm run soak -- --minutes 1440 --interval 30 [--url http://localhost:8080]
//
// Samples go to soak/<start>.jsonl as they are taken; the summary to soak/<start>-summary.md
// (and stdout) at the end or on Ctrl+C. Run it on the server for the 24 h soak.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  connectRedis,
  createRedis,
  readExchangeHealth,
  readProcessStatuses,
  readScannerStatus,
} from '@mip/bus';
import { createLogger, loadDotEnv } from '@mip/core';
import { createPrismaClient } from '@mip/db';

const run = promisify(execFile);
loadDotEnv();
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const minutes = Number(arg('minutes', '60'));
const intervalS = Number(arg('interval', '30'));
const baseUrl = arg('url', `http://localhost:${process.env.WEB_PORT ?? 8080}`);
if (!process.env.REDIS_URL || !process.env.DATABASE_URL) {
  console.error('REDIS_URL and DATABASE_URL must be set (.env)');
  process.exit(2);
}

const logger = createLogger({ service: 'soak', level: 'warn' });
const redis = createRedis(process.env.REDIS_URL, logger, 'soak');
await connectRedis(redis);
const prisma = createPrismaClient(process.env.DATABASE_URL);

const started = Date.now();
const stamp = new Date(started).toISOString().replace(/[:.]/g, '-');
const dir = path.resolve('soak');
mkdirSync(dir, { recursive: true });
const samplesFile = path.join(dir, `${stamp}.jsonl`);
const summaryFile = path.join(dir, `${stamp}-summary.md`);

interface Sample {
  t: number;
  exchanges: {
    ex: string;
    state: string;
    fresh: number;
    tracked: number;
    updPerSec: number;
    latencyMs: number | null;
    reconnects: number;
  }[];
  processes: { name: string; alive: boolean; startedAt: number | null }[];
  scanners: {
    id: string;
    enabled: boolean;
    lastRunAgeMs: number | null;
    lastRunMs: number | null;
    error: string | null;
    active: number;
    telegram: string;
  }[];
  containers: { name: string; cpu: number; memMb: number }[];
  redisMb: number | null;
  health: { ok: boolean; ms: number } | null;
}

const mb = (s: string): number => {
  const m = /([\d.]+)\s*([KMG]i?B)/.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2]!.startsWith('G') ? n * 1024 : m[2]!.startsWith('K') ? n / 1024 : n;
};

async function containers(): Promise<Sample['containers']> {
  try {
    const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}'], {
      timeout: 20_000,
    });
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { Name: string; CPUPerc: string; MemUsage: string })
      .filter((c) => c.Name.startsWith('mip-'))
      .map((c) => ({
        name: c.Name.replace(/^mip-|-1$/g, ''),
        cpu: Number.parseFloat(c.CPUPerc),
        memMb: mb(c.MemUsage.split('/')[0]!),
      }));
  } catch {
    return []; // docker CLI not available: the rest of the soak still works
  }
}

async function sample(): Promise<Sample> {
  const t = Date.now();
  const [health, procs, scanners, info, ctr] = await Promise.all([
    readExchangeHealth(redis),
    readProcessStatuses(redis),
    readScannerStatus(redis),
    redis.info('memory').catch(() => ''),
    containers(),
  ]);
  let h: Sample['health'] = null;
  const t0 = performance.now();
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
    h = { ok: res.ok, ms: Math.round(performance.now() - t0) };
  } catch {
    h = { ok: false, ms: Math.round(performance.now() - t0) };
  }
  const used = /used_memory:(\d+)/.exec(info);
  return {
    t,
    exchanges: (health?.exchanges ?? []).map((e) => ({
      ex: e.exchange,
      state: e.state,
      fresh: e.data?.fresh ?? 0,
      tracked: e.data?.tracked ?? 0,
      updPerSec: e.data?.updatesPerSec ?? 0,
      latencyMs: e.data?.latencyMs ?? null,
      reconnects: e.connections.reduce((n, c) => n + c.reconnects, 0),
    })),
    processes: procs.map((p) => ({ name: p.name, alive: p.alive, startedAt: p.startedAt })),
    scanners: (scanners?.scanners ?? []).map((s) => ({
      id: s.id,
      enabled: s.enabled,
      lastRunAgeMs: s.lastRunAt === null ? null : t - s.lastRunAt,
      lastRunMs: s.lastRunMs,
      error: s.error,
      active: s.active,
      telegram: s.telegram.state,
    })),
    containers: ctr,
    redisMb: used ? Number(used[1]) / 1_048_576 : null,
    health: h,
  };
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
};
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '—');

async function summary(samples: Sample[]): Promise<string> {
  const out: string[] = [];
  const end = samples.at(-1)?.t ?? Date.now();
  out.push(
    `# Soak summary`,
    '',
    `- Window: ${new Date(started).toISOString()} → ${new Date(end).toISOString()} (${f1((end - started) / 60_000)} min, ${samples.length} samples every ${intervalS} s)`,
  );
  // Sampling gaps much longer than the interval mean the machine slept or the monitor stalled.
  const gaps = samples
    .slice(1)
    .map((s, i) => s.t - samples[i]!.t)
    .filter((g) => g > intervalS * 3_000);
  out.push(
    `- Sampling gaps longer than 3 intervals: ${gaps.length ? gaps.map((g) => `${f1(g / 60_000)} min`).join(', ') : 'none'}`,
    '',
  );

  out.push(
    '## Exchanges',
    '',
    '| Exchange | ok samples | fresh ratio min / avg | reconnects during soak | upd/s avg | delay p50 / p95 ms |',
    '|---|---|---|---|---|---|',
  );
  const exs = [...new Set(samples.flatMap((s) => s.exchanges.map((e) => e.ex)))];
  for (const ex of exs) {
    const rows = samples
      .map((s) => s.exchanges.find((e) => e.ex === ex))
      .filter((e): e is Sample['exchanges'][number] => !!e);
    const ok = rows.filter((r) => r.state === 'ok').length;
    const ratios = rows.filter((r) => r.tracked > 0).map((r) => r.fresh / r.tracked);
    const lat = rows.map((r) => r.latencyMs).filter((x): x is number => x !== null);
    const rec = rows.length ? rows.at(-1)!.reconnects - rows[0]!.reconnects : 0;
    out.push(
      `| ${ex} | ${ok}/${rows.length} | ${f1(Math.min(...ratios) * 100)} % / ${f1((ratios.reduce((a, b) => a + b, 0) / (ratios.length || 1)) * 100)} % | ${rec} | ${f1(rows.reduce((a, r) => a + r.updPerSec, 0) / (rows.length || 1))} | ${f1(q(lat, 0.5))} / ${f1(q(lat, 0.95))} |`,
    );
  }

  out.push('', '## Processes', '');
  for (const name of ['collector', 'engine', 'api']) {
    const rows = samples.map((s) => s.processes.find((p) => p.name === name));
    const down = rows.filter((p) => !p?.alive).length;
    const starts = new Set(rows.map((p) => p?.startedAt).filter(Boolean)).size;
    out.push(
      `- ${name}: heartbeat missing in ${down}/${rows.length} samples; ${Math.max(0, starts - 1)} restart(s)`,
    );
  }

  out.push(
    '',
    '## Scanners',
    '',
    '| Scanner | run time p50 / p95 / max ms | stalled samples (no run for 2 min) | error samples | active signals min / max | Telegram |',
    '|---|---|---|---|---|---|',
  );
  const ids = [...new Set(samples.flatMap((s) => s.scanners.map((x) => x.id)))];
  for (const id of ids) {
    const rows = samples
      .map((s) => s.scanners.find((x) => x.id === id))
      .filter((x): x is Sample['scanners'][number] => !!x);
    const ms = rows.map((r) => r.lastRunMs).filter((x): x is number => x !== null);
    const stalled = rows.filter(
      (r) => r.enabled && (r.lastRunAgeMs === null || r.lastRunAgeMs > 120_000),
    ).length;
    const errors = rows.filter((r) => r.error).length;
    const act = rows.map((r) => r.active);
    const tg = [...new Set(rows.map((r) => r.telegram))].join(', ');
    out.push(
      `| ${id} | ${f1(q(ms, 0.5))} / ${f1(q(ms, 0.95))} / ${f1(Math.max(...ms))} | ${stalled} | ${errors} | ${Math.min(...act)} / ${Math.max(...act)} | ${tg} |`,
    );
  }

  out.push(
    '',
    '## Resources',
    '',
    '| Container | memory start → end (max) MB | growth MB/h, 1st half / 2nd half | CPU avg / max % |',
    '|---|---|---|---|',
  );
  // Warm-up slows down; a leak keeps its pace. Compare the growth rate of the two halves.
  const rate = (pts: { t: number; mem: number }[]) =>
    pts.length < 2 ? NaN : ((pts.at(-1)!.mem - pts[0]!.mem) / (pts.at(-1)!.t - pts[0]!.t)) * 3_600_000;
  const names = [...new Set(samples.flatMap((s) => s.containers.map((c) => c.name)))];
  for (const n of names) {
    const pts = samples
      .map((s) => ({ t: s.t, mem: s.containers.find((c) => c.name === n)?.memMb ?? NaN }))
      .filter((p) => Number.isFinite(p.mem));
    const mem = pts.map((p) => p.mem);
    const cpu = samples
      .map((s) => s.containers.find((c) => c.name === n)?.cpu)
      .filter((x): x is number => typeof x === 'number');
    const half = Math.floor(pts.length / 2);
    out.push(
      `| ${n} | ${f1(mem[0]!)} → ${f1(mem.at(-1)!)} (${f1(Math.max(...mem))}) | ${f1(rate(pts.slice(0, half + 1)))} / ${f1(rate(pts.slice(half)))} | ${f1(cpu.reduce((a, b) => a + b, 0) / cpu.length)} / ${f1(Math.max(...cpu))} |`,
    );
  }
  const redisMb = samples.map((s) => s.redisMb).filter((x): x is number => x !== null);
  out.push(
    '',
    `- Redis used memory: ${f1(redisMb[0]!)} → ${f1(redisMb.at(-1)!)} MB (max ${f1(Math.max(...redisMb))})`,
  );
  const hl = samples.map((s) => s.health).filter((x): x is NonNullable<Sample['health']> => !!x);
  out.push(
    `- GET /api/health: ${hl.filter((x) => !x.ok).length}/${hl.length} failed; latency p50 ${q(
      hl.map((x) => x.ms),
      0.5,
    )} ms, p95 ${q(
      hl.map((x) => x.ms),
      0.95,
    )} ms, max ${Math.max(...hl.map((x) => x.ms))} ms`,
  );

  // Telegram outcome of the signals opened during the soak.
  const opened = await prisma.signal.groupBy({
    by: ['scanner', 'telegramState'],
    where: { firstSeenAt: { gte: new Date(started) } },
    _count: { _all: true },
  });
  out.push('', '## Signals opened during the soak (Telegram outcome)', '');
  if (!opened.length) out.push('- none');
  for (const r of opened) out.push(`- ${r.scanner}: ${r._count._all} ${r.telegramState}`);
  const failed = await prisma.signal.findMany({
    where: { firstSeenAt: { gte: new Date(started) }, telegramState: 'failed' },
    select: { scanner: true, telegramDetail: true },
    take: 5,
  });
  for (const f of failed) out.push(`  - failed (${f.scanner}): ${f.telegramDetail}`);
  return out.join('\n') + '\n';
}

const samples: Sample[] = [];
let stopping = false;
const finish = async () => {
  if (stopping) return;
  stopping = true;
  const text = await summary(samples);
  writeFileSync(summaryFile, text);
  console.log(`\n${text}\nSamples: ${samplesFile}\nSummary: ${summaryFile}`);
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void finish());

console.log(`Soak: ${minutes} min, a sample every ${intervalS} s → ${samplesFile}`);
const deadline = started + minutes * 60_000;
while (!stopping && Date.now() < deadline) {
  const s = await sample();
  samples.push(s);
  appendFileSync(samplesFile, JSON.stringify(s) + '\n');
  const notOk = s.exchanges.filter((e) => e.state !== 'ok').map((e) => e.ex);
  console.log(
    `${new Date(s.t).toISOString()} exchanges not ok: ${notOk.join(',') || 'none'} · health ${s.health?.ok ? 'ok' : 'FAIL'} ${s.health?.ms} ms`,
  );
  const wait = Math.max(0, s.t + intervalS * 1000 - Date.now());
  await new Promise((r) => setTimeout(r, Math.min(wait, deadline - Date.now())));
}
await finish();
