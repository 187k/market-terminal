#!/usr/bin/env node
// Starts collector, engine, api and the web dev server together with prefixed output.
// Usage: npm run dev            (all)
//        npm run dev -- api web (a subset)
import { spawn, spawnSync } from 'node:child_process';

const ALL = {
  collector: '\x1b[36m',
  engine: '\x1b[35m',
  api: '\x1b[32m',
  web: '\x1b[33m',
};
const reset = '\x1b[0m';
const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(ALL);
const unknown = names.filter((n) => !(n in ALL));
if (unknown.length > 0) {
  console.error(`unknown app(s): ${unknown.join(', ')}; choose from ${Object.keys(ALL).join(', ')}`);
  process.exit(1);
}

const width = Math.max(...names.map((n) => n.length));
const children = names.map((name) => {
  const child = spawn('npm', ['run', 'dev', '-w', `@mip/${name}`, '--silent'], {
    shell: process.platform === 'win32',
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  const prefix = `${ALL[name]}${name.padEnd(width)} |${reset} `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => process.stdout.write(`${prefix}exited with code ${code}\n`));
  return child;
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGINT');
  }
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
