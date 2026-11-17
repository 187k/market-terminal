import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { RealtimeTopic } from '@mip/core/types';
import { ApiError } from './api';
import type { ConnectionState, RealtimeConnection } from './realtime';

export interface Polled<T> {
  data: T | null;
  error: string | null;
  updatedAt: number | null;
}

/**
 * Polls `fetcher` every `intervalMs`, waiting for each request to finish before scheduling
 * the next. Pass `enabled = false` to pause (used while the WebSocket delivers the data).
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  onUnauthorized: () => void,
  enabled = true,
): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, updatedAt: null });
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const data = await fetcher();
        if (!cancelled) setState({ data, error: null, updatedAt: Date.now() });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          unauthorized.current();
          return;
        }
        setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      }
      if (!cancelled) timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fetcher, intervalMs, enabled]);

  return state;
}

export const RealtimeContext = createContext<RealtimeConnection | null>(null);

/** The dashboard's WebSocket state: "open" means data arrives by push, otherwise by polling. */
export function useConnectionState(): ConnectionState {
  const rt = useContext(RealtimeContext);
  const [state, setState] = useState<ConnectionState>(rt?.state ?? 'closed');
  useEffect(() => {
    if (!rt) return;
    setState(rt.state);
    return rt.onState(setState);
  }, [rt]);
  return state;
}

/**
 * Live data for one realtime topic. While the WebSocket is open the server pushes changes;
 * while it is down (or before it connects) the same data is polled over REST, so the
 * dashboard keeps working either way. `topic = null` pauses everything.
 */
export function useTopic<T>(
  topic: RealtimeTopic | null,
  fallback: () => Promise<T>,
  fallbackMs: number,
  onUnauthorized: () => void,
): Polled<T> {
  const rt = useContext(RealtimeContext);
  const connection = useConnectionState();
  const live = rt !== null && connection === 'open' && topic !== null;
  const [pushed, setPushed] = useState<Polled<T> & { topic: string | null }>({
    data: null,
    error: null,
    updatedAt: null,
    topic: null,
  });

  useEffect(() => {
    if (!rt || topic === null) return;
    return rt.subscribe(topic, (m) => {
      if (m.error !== undefined) setPushed((s) => ({ ...s, error: m.error ?? null }));
      else setPushed({ data: m.data as T, error: null, updatedAt: Date.now(), topic });
    });
  }, [rt, topic]);

  const polled = usePolling(fallback, fallbackMs, onUnauthorized, !live && topic !== null);
  // Prefer pushed data for this topic; keep showing polled data until the first push arrives.
  if (live && pushed.topic === topic && pushed.data !== null) return pushed;
  return polled.data !== null || !live ? polled : { ...pushed, data: null };
}

/** Re-renders every `ms` so relative times ("4 s ago") stay current. */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * State remembered in this browser (filters, sort order). Storage can be unavailable (private
 * mode, blocked site data), so every access is guarded and the page works without it.
 */
export function usePersistentState<T extends object>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : { ...initial, ...(JSON.parse(raw) as Partial<T>) };
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // not persisted; the value still applies for this page view
    }
  };
  return [value, set];
}
