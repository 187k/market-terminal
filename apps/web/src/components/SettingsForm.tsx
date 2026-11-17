import { useEffect, useMemo, useState } from 'react';
import { EXCHANGE_NAMES, isExchangeId, type ScannerId, type ScannerSettingsDto } from '@mip/core/types';
import { api, ApiError } from '../api';
import { formatWhen } from '../format';

/** The parts of JSON Schema the form understands (what zod's toJSONSchema emits). */
interface Schema {
  type?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  enum?: string[];
  items?: Schema;
  properties?: Record<string, Schema>;
}

interface Meta {
  label: string;
  unit?: string;
  help?: string;
}

/** Labels and help for each setting. Bounds and types come from the server's schema. */
const META: Record<string, Meta> = {
  notifyTelegram: {
    label: 'Send Telegram messages',
    help: 'Signals are recorded and shown here either way.',
  },
  notifyResolved: { label: 'Edit the message when a signal resolves' },
  exchanges: { label: 'Exchanges', help: 'Only the selected exchanges; none selected = all.' },
  includeAssets: {
    label: 'Only these assets',
    help: 'Asset codes separated by commas, e.g. BTC, ETH. Empty = all.',
  },
  excludeAssets: { label: 'Never these assets', help: 'Asset codes separated by commas.' },
  minTurnover24hUsd: { label: 'Min 24h turnover', unit: '$' },
  confirmSec: {
    label: 'Confirm for',
    unit: 's',
    help: 'A condition must hold this long before a signal opens.',
  },
  resolveAfterSec: {
    label: 'Resolve after',
    unit: 's',
    help: 'A signal resolves after its condition has been absent this long.',
  },
  cooldownMinutes: {
    label: 'Cooldown',
    unit: 'min',
    help: 'The same signal coming back within this time reopens it instead of sending a new message.',
  },
  minUpdateIntervalSec: { label: 'Min time between message edits', unit: 's' },
  significantChangePct: {
    label: 'Significant change',
    unit: '%',
    help: 'Relative change of the main figure that counts as significant and edits the message.',
  },
  // Fair price
  minDeviationPct: { label: 'Min deviation', unit: '%', help: '|last − mark| / mark × 100' },
  requireExecutable: {
    label: 'Require the order book to offer it',
    help: 'Ask below mark for LONG, bid above mark for SHORT, by at least the executable edge. Filters stale last prices.',
  },
  minExecutableEdgePct: { label: 'Min executable edge', unit: '%' },
  fairIndexWarnPct: { label: 'Warn when fair vs index exceeds', unit: '%' },
  minTopOfBookUsd: { label: 'Min top of book', unit: '$', help: 'Notional at the best level.' },
  maxSpreadPct: { label: 'Max book spread', unit: '%', help: 'Bid–ask spread, percent of mid.' },
  // Open interest
  thresholds: {
    label: 'Thresholds per window',
    help: 'OI growth / decline within the window that opens a signal, percent.',
  },
  growthPct: { label: 'Growth', unit: '%' },
  declinePct: { label: 'Decline', unit: '%' },
  signalOnGrowth: { label: 'Signal on growth' },
  signalOnDecline: { label: 'Signal on decline' },
  minOiUsd: { label: 'Min open interest', unit: '$', help: 'Current OI × mark price.' },
  // Funding
  extreme24hPct: { label: 'Extreme funding, normalised to 24h', unit: '%' },
  signalExtremes: { label: 'Signal extreme funding' },
  minDifference24hPct: { label: 'Min difference between exchanges, 24h', unit: '%' },
  signalArbitrage: { label: 'Signal differences between exchanges' },
  // Spread
  minGrossSpreadPct: { label: 'Min gross spread', unit: '%' },
  minNetSpreadPct: { label: 'Min net spread', unit: '%', help: 'After fees, VWAP slippage and funding.' },
  positionUsd: { label: 'Position per leg', unit: '$', help: 'Used for VWAP and profit.' },
  holdingHours: {
    label: 'Holding period',
    unit: 'h',
    help: 'Funding over this period is included; 0 = ignore funding.',
  },
  maxPlausibleSpreadPct: {
    label: 'Max plausible spread',
    unit: '%',
    help: 'Larger gaps are treated as an instrument-mapping problem, never as a signal.',
  },
  maxQuoteSkewMs: { label: 'Max time between the two quotes', unit: 'ms' },
  allowMixedQuotes: { label: 'Compare USDC (Hyperliquid) with USDT contracts' },
  takerFees: {
    label: 'Taker fees',
    help: 'Fractions: 0.0005 = 0.05 %. Defaults are base-tier rates; your account tier may differ.',
  },
  // TWAP
  windowMinutes: { label: 'Analysis window', unit: 'min' },
  minSlices: { label: 'Min similar executions' },
  minDurationSec: { label: 'Min duration', unit: 's' },
  minNotionalUsd: { label: 'Min executed volume', unit: '$' },
  sizeTolerancePct: { label: 'Similar size tolerance', unit: '%' },
  minConfidence: {
    label: 'Min confidence',
    unit: '0–1',
    help: 'Heuristic patterns below this are not reported.',
  },
  hyperliquidConfirmed: { label: 'Report Hyperliquid TWAP slices as exchange-confirmed' },
};

const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Notifications', keys: ['notifyTelegram', 'notifyResolved'] },
  {
    title: 'Filters',
    keys: [
      'exchanges',
      'includeAssets',
      'excludeAssets',
      'minTurnover24hUsd',
      'minOiUsd',
      'minTopOfBookUsd',
      'maxSpreadPct',
    ],
  },
  {
    title: 'Signal lifecycle',
    keys: [
      'confirmSec',
      'resolveAfterSec',
      'cooldownMinutes',
      'minUpdateIntervalSec',
      'significantChangePct',
    ],
  },
];

const humanize = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

type Draft = Record<string, unknown>;

const setAt = (obj: Draft, path: string[], value: unknown): Draft => {
  const [head, ...rest] = path;
  if (head === undefined) return obj;
  return {
    ...obj,
    [head]: rest.length ? setAt((obj[head] as Draft | undefined) ?? {}, rest, value) : value,
  };
};

/** Number inputs keep what was typed ("0.", "") until saved; convert back before sending. */
function toNumbers(value: unknown, schema: Schema | undefined, path: string, errors: string[]): unknown {
  if (schema?.type === 'number' || schema?.type === 'integer') {
    if (typeof value === 'number') return value;
    const n = Number(String(value).trim());
    if (String(value).trim() === '' || !Number.isFinite(n)) errors.push(`${path}: enter a number`);
    return n;
  }
  if (schema?.type === 'object' && schema.properties && value && typeof value === 'object') {
    const out: Draft = {};
    for (const [k, v] of Object.entries(value as Draft))
      out[k] = toNumbers(v, schema.properties[k], path ? `${path}.${k}` : k, errors);
    return out;
  }
  return value;
}

function Field({
  name,
  path,
  schema,
  value,
  defaultValue,
  problems,
  onChange,
}: {
  name: string;
  path: string[];
  schema: Schema;
  value: unknown;
  defaultValue: unknown;
  problems: string[];
  onChange: (path: string[], v: unknown) => void;
}) {
  const meta = META[name] ?? { label: humanize(name) };
  const id = `set-${path.join('-')}`;
  const pathKey = path.join('.');
  const mine = problems.filter((p) => p.startsWith(`${pathKey}:`) || p.startsWith(`${pathKey}.`));
  const changed = JSON.stringify(value) !== JSON.stringify(defaultValue);
  const hint = (
    <>
      {meta.help && <span className="field-help">{meta.help}</span>}
      {changed && defaultValue !== undefined && typeof defaultValue !== 'object' && (
        <span className="field-help">default {String(defaultValue)}</span>
      )}
      {mine.map((p) => (
        <span key={p} className="field-error">
          {p.slice(p.indexOf(':') + 1).trim()}
        </span>
      ))}
    </>
  );

  if (schema.type === 'boolean')
    return (
      <div className={`field field-check ${changed ? 'field-changed' : ''}`}>
        <label htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(path, e.target.checked)}
          />
          {meta.label}
        </label>
        {hint}
      </div>
    );

  if (schema.type === 'array' && schema.items?.enum) {
    const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
    return (
      <fieldset className={`field ${changed ? 'field-changed' : ''}`}>
        <legend>{meta.label}</legend>
        <div className="chips">
          {schema.items.enum.map((opt) => (
            <label key={opt} className={`chip ${selected.has(opt) ? 'chip-on' : ''}`}>
              <input
                type="checkbox"
                checked={selected.has(opt)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(opt);
                  else next.delete(opt);
                  onChange(
                    path,
                    schema.items!.enum!.filter((o) => next.has(o)),
                  );
                }}
              />
              {isExchangeId(opt) ? EXCHANGE_NAMES[opt] : opt}
            </label>
          ))}
        </div>
        {hint}
      </fieldset>
    );
  }

  if (schema.type === 'array')
    return (
      <div className={`field ${changed ? 'field-changed' : ''}`}>
        <label htmlFor={id}>{meta.label}</label>
        <input
          id={id}
          type="text"
          value={Array.isArray(value) ? (value as string[]).join(', ') : String(value ?? '')}
          onChange={(e) =>
            onChange(
              path,
              e.target.value
                .split(',')
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean),
            )
          }
          placeholder="e.g. BTC, ETH"
        />
        {hint}
      </div>
    );

  if (schema.type === 'object' && schema.properties) {
    const obj = (value as Draft | undefined) ?? {};
    const def = (defaultValue as Draft | undefined) ?? {};
    return (
      <fieldset className="field field-group">
        <legend>{meta.label}</legend>
        {meta.help && <span className="field-help">{meta.help}</span>}
        <div className="field-grid">
          {Object.entries(schema.properties).map(([k, s]) =>
            s.type === 'object' ? (
              <fieldset key={k} className="field field-sub">
                <legend>{isExchangeId(k) ? EXCHANGE_NAMES[k] : k}</legend>
                {Object.entries(s.properties ?? {}).map(([k2, s2]) => (
                  <Field
                    key={k2}
                    name={k2}
                    path={[...path, k, k2]}
                    schema={s2}
                    value={(obj[k] as Draft | undefined)?.[k2]}
                    defaultValue={(def[k] as Draft | undefined)?.[k2]}
                    problems={problems}
                    onChange={onChange}
                  />
                ))}
              </fieldset>
            ) : (
              <Field
                key={k}
                name={isExchangeId(k) ? k : k}
                path={[...path, k]}
                schema={s}
                value={obj[k]}
                defaultValue={def[k]}
                problems={problems}
                onChange={onChange}
              />
            ),
          )}
        </div>
      </fieldset>
    );
  }

  // number / integer
  const label = META[name]?.label ?? (isExchangeId(name) ? EXCHANGE_NAMES[name] : humanize(name));
  return (
    <div className={`field ${changed ? 'field-changed' : ''}`}>
      <label htmlFor={id}>
        {label}
        {meta.unit && <span className="muted">, {meta.unit}</span>}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={typeof value === 'number' || typeof value === 'string' ? value : ''}
        min={schema.minimum ?? schema.exclusiveMinimum}
        max={schema.maximum}
        step={schema.type === 'integer' ? 1 : 'any'}
        onChange={(e) => onChange(path, e.target.value)}
      />
      {hint}
    </div>
  );
}

/**
 * Settings editor for one scanner. Saving validates on the server (the same zod schema the
 * engine uses) and the engine applies the change within about a second.
 */
export function SettingsForm({
  scanner,
  onUnauthorized,
}: {
  scanner: ScannerId;
  onUnauthorized: () => void;
}) {
  const [dto, setDto] = useState<ScannerSettingsDto | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [enabled, setEnabled] = useState(true);
  const [problems, setProblems] = useState<string[]>([]);
  const [status, setStatus] = useState<{ tone: 'pos' | 'neg' | 'muted'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.settings(scanner).then(
      (d) => {
        if (cancelled) return;
        setDto(d);
        setDraft(d.settings);
        setEnabled(d.enabled);
      },
      (err) => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else if (!cancelled)
          setStatus({ tone: 'neg', text: `Could not load settings: ${(err as Error).message}` });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scanner, onUnauthorized]);

  const schema = (dto?.schema ?? {}) as Schema;
  const props = schema.properties ?? {};
  const grouped = useMemo(() => {
    const used = new Set(GROUPS.flatMap((g) => g.keys));
    const detection = Object.keys(props).filter((k) => !used.has(k));
    return [GROUPS[0]!, { title: 'Detection', keys: detection }, GROUPS[1]!, GROUPS[2]!].map((g) => ({
      ...g,
      keys: g.keys.filter((k) => k in props),
    }));
  }, [props]);

  if (!dto)
    return (
      <div className="empty">
        {status ? <span className={status.tone}>{status.text}</span> : 'Loading settings…'}
      </div>
    );

  const dirty = enabled !== dto.enabled || JSON.stringify(draft) !== JSON.stringify(dto.settings);
  // Problems no field shows (e.g. on the root object) are listed under the form.
  const orphanProblems = problems.filter(
    (p) => !Object.keys(props).some((k) => p.startsWith(`${k}:`) || p.startsWith(`${k}.`)),
  );

  const save = async () => {
    const errors: string[] = [];
    const settings = toNumbers(draft, schema, '', errors) as Draft;
    setProblems(errors);
    if (errors.length) {
      setStatus({ tone: 'neg', text: 'Some values are not numbers.' });
      return;
    }
    setSaving(true);
    try {
      const saved = await api.saveSettings(scanner, { enabled, settings });
      setDto(saved);
      setDraft(saved.settings);
      setEnabled(saved.enabled);
      setProblems([]);
      setStatus({ tone: 'pos', text: 'Saved. The engine applies the change within about a second.' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setProblems(err instanceof ApiError ? err.problems : []);
      setStatus({ tone: 'neg', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const onChange = (path: string[], v: unknown) => {
    setDraft((d) => setAt(d, path, v));
    setStatus(null);
  };

  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="field field-check field-main">
        <label htmlFor="set-enabled">
          <input
            id="set-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Scanner enabled
        </label>
        <span className="field-help">
          A disabled scanner stops detecting; its open signals resolve after the usual delay.
        </span>
      </div>
      {grouped.map(
        (g) =>
          g.keys.length > 0 && (
            <section key={g.title} className="settings-group">
              <h3>{g.title}</h3>
              <div className="field-grid">
                {g.keys.map((k) => (
                  <Field
                    key={k}
                    name={k}
                    path={[k]}
                    schema={props[k]!}
                    value={draft[k]}
                    defaultValue={dto.defaults[k]}
                    problems={problems}
                    onChange={onChange}
                  />
                ))}
              </div>
            </section>
          ),
      )}
      {orphanProblems.length > 0 && (
        <ul className="field-error">
          {orphanProblems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <footer className="settings-foot">
        <span className="small muted">
          {dto.updatedAt ? `Last saved ${formatWhen(dto.updatedAt)}` : 'Using the defaults (never saved).'}
        </span>
        {status && <span className={`small ${status.tone}`}>{status.text}</span>}
        <button
          type="button"
          className="btn"
          onClick={() => {
            setDraft(dto.defaults);
            setStatus({ tone: 'muted', text: 'Defaults loaded into the form. Save to apply them.' });
          }}
        >
          Reset to defaults
        </button>
        <button
          type="button"
          className="btn"
          disabled={!dirty}
          onClick={() => {
            setDraft(dto.settings);
            setEnabled(dto.enabled);
            setProblems([]);
            setStatus(null);
          }}
        >
          Discard changes
        </button>
        <button type="submit" className="btn btn-primary" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </form>
  );
}
