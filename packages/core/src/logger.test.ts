import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('redacts secrets at the top level and one level deep', () => {
    const { lines, stream } = capture();
    const log = createLogger({ service: 'test', level: 'info' }, stream);
    log.info(
      {
        apiKey: 'AK-123',
        exchange: { apiSecret: 'S-456', name: 'bybit' },
        headers: { 'x-mbx-apikey': 'MBX-789', accept: 'json' },
        password: 'hunter2',
      },
      'hello',
    );
    const out = lines.join('');
    for (const secret of ['AK-123', 'S-456', 'MBX-789', 'hunter2']) expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
    expect(out).toContain('bybit');
    const rec = JSON.parse(lines[0]!);
    expect(rec.service).toBe('test');
    expect(rec.msg).toBe('hello');
  });
});
