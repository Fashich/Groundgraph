import type { IsoTime, U64 } from '@groundgraph/sdk/api-types';

export const USDC_DECIMALS = 6;
const MINUS = '−';

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** u64 base-unit string (6 decimals) to a JS number of whole units. */
export function fromBase(u64: U64 | null | undefined): number {
  if (u64 == null || u64 === '') return 0;
  try {
    const v = BigInt(u64);
    const whole = v / 1_000_000n;
    const frac = v % 1_000_000n;
    return Number(whole) + Number(frac) / 1e6;
  } catch {
    return 0;
  }
}

/** Parse a user-typed decimal ("12.5") into u64 base units without float error. Returns null when invalid. */
export function toBase(input: string): U64 | null {
  const t = input.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [w = '0', f = ''] = t.split('.');
  const frac = (f + '000000').slice(0, USDC_DECIMALS);
  const out = BigInt(w || '0') * 1_000_000n + BigInt(frac || '0');
  return out.toString();
}

export function usd(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? MINUS : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
  return `${s}$${a.toFixed(2)}`;
}

export const usdFromU64 = (u: U64 | null | undefined) => usd(fromBase(u));

/** 0.21 -> "21¢" */
export const cents = (p: number) => `${Math.round(p * 100)}¢`;

export const signedInt = (n: number) => `${n >= 0 ? '+' : MINUS}${Math.abs(n)}`;
export const signedUsd = (n: number) => `${n >= 0 ? '+' : ''}${usd(n)}`;
export const signedCents = (n: number) => `${n >= 0 ? '+' : MINUS}${Math.abs(n)}¢`;

export function spotFmt(v: number): string {
  if (!Number.isFinite(v)) return '-';
  if (v < 0.001) return `$${v.toFixed(7)}`;
  if (v < 10) return `$${v.toFixed(3)}`;
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function tgtFmt(v: number, ratio = false): string {
  if (ratio) return String(v);
  if (v >= 1000) return '$' + v.toLocaleString('en-US');
  if (v < 0.001) return '$' + v.toFixed(7);
  if (v < 10) return '$' + v.toFixed(2);
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Round to 3 significant digits for presets such as +10% of spot. */
export const numStr = (v: number) => (v >= 100 ? String(Math.round(v)) : String(+v.toPrecision(3)));

export const shortAddr = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');

/** "3d 6h" / "5h 07m" / "Resolving" from a duration in hours. */
export function leftLabel(hours: number): string {
  if (hours <= 0) return 'Resolving';
  const d = Math.floor(hours / 24);
  const r = Math.floor(hours % 24);
  return d > 0 ? `${d}d ${r}h` : `${r}h ${pad2(Math.floor((hours * 60) % 60))}m`;
}

/** Countdown label. Under 48h it shows hours and minutes (live), otherwise days and hours. */
export function countdownLabel(hours: number): string {
  if (hours <= 0) return 'Resolving';
  if (hours >= 48) return leftLabel(hours);
  return `${Math.floor(hours)}h ${pad2(Math.floor((hours * 60) % 60))}m`;
}

export const hoursUntil = (iso: IsoTime, now = Date.now()) => (new Date(iso).getTime() - now) / 36e5;
export const isUrgent = (hours: number) => hours > 0 && hours < 48;

export function fmtD(iso: IsoTime | number): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function fmtDT(iso: IsoTime | number): string {
  const d = new Date(iso);
  return `${fmtD(iso)} · ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Compact "age" of a past timestamp. */
export function ago(iso: IsoTime | number, now = Date.now()): string {
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Parse a decimal text field, returning 0 for empty or invalid input. */
export function num(s: string): number {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

export function txShort(sig: string | null | undefined): string {
  return sig ? `${sig.slice(0, 4)}…${sig.slice(-4)}` : '';
}

/** Percentage-point change, e.g. 2.4 -> "+2.4", -1.1 -> "−1.1". */
export const signedPP = (n: number) => `${n >= 0 ? '+' : MINUS}${Math.abs(n).toFixed(1)}`;

/** Edge in cents with a sign: 17 -> "+17¢". */
export const edgeLabel = (n: number) => `${n >= 0 ? '+' : MINUS}${Math.abs(n)}¢`;

export const traders = (n: number) => n.toLocaleString('en-US');
