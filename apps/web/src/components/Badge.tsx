import type { ReactNode } from 'react';

export type Tone = 'pos' | 'neg' | 'warn' | 'muted' | 'info';

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATE_TONES: Record<string, Tone> = {
  ok: 'pos',
  open: 'pos',
  degraded: 'warn',
  starting: 'info',
  connecting: 'info',
  reconnecting: 'warn',
  down: 'neg',
  error: 'neg',
  stopped: 'muted',
  disabled: 'muted',
  not_implemented: 'muted',
  idle: 'muted',
};

const STATE_LABELS: Record<string, string> = {
  not_implemented: 'not built yet',
};

export function StateBadge({ state, title }: { state: string; title?: string }) {
  return (
    <Badge tone={STATE_TONES[state] ?? 'muted'} {...(title ? { title } : {})}>
      {STATE_LABELS[state] ?? state}
    </Badge>
  );
}
