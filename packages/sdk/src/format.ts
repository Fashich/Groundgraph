export interface FormatUsdcOpts {
  /** Decimal places to show (0..6). Default 2. Values are truncated, never rounded up. */
  decimals?: number;
  /** Thousands separators. Default false. */
  grouping?: boolean;
  /** Prefix with "$". Default false. */
  symbol?: boolean;
}

/** Format 6-decimal base units, e.g. `12_345_678n` -> "12.34". */
export function formatUsdc(base: bigint, opts: FormatUsdcOpts = {}): string {
  const decimals = Math.min(6, Math.max(0, opts.decimals ?? 2));
  const neg = base < 0n;
  const a = neg ? -base : base;
  let whole = (a / 1_000_000n).toString();
  if (opts.grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (a % 1_000_000n).toString().padStart(6, '0').slice(0, decimals);
  const body = decimals > 0 ? `${whole}.${frac}` : whole;
  return `${neg ? '-' : ''}${opts.symbol ? '$' : ''}${body}`;
}

/** 0..1 to a whole-number percentage, e.g. 0.424 -> "42%". */
export function formatPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** A 0..1 share price in cents, e.g. 0.424 -> "42c". */
export function formatPrice(x: number): string {
  return `${Math.round(x * 100)}c`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtTarget(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return String(Number(p.toFixed(2)));
  return String(Number(p.toPrecision(4)));
}

/**
 * Market question text. Close: "SOL above or below $250 at the Oct 31 close?" (month and day in UTC).
 * Touch (Phase 2 wording): "ETH before Oct 20: holds above $3,800 or breaks below?".
 */
export function buildQuestion(a: {
  assetSymbol: string;
  kind: 'close' | 'touch';
  direction?: 'up' | 'down';
  targetPrice: number;
  settleTs: number;
}): string {
  const d = new Date(a.settleTs * 1000);
  const when = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const target = fmtTarget(a.targetPrice);
  if (a.kind === 'close') return `${a.assetSymbol} above or below $${target} at the ${when} close?`;
  return a.direction === 'down'
    ? `${a.assetSymbol} before ${when}: holds above $${target} or breaks below?`
    : `${a.assetSymbol} before ${when}: holds below $${target} or breaks above?`;
}
