/** Unit helpers shared by all services. USDC and outcome shares both use 6 decimals. */
export const USDC_ONE = 1_000_000n;

const U64_MAX = (1n << 64n) - 1n;

/** Strict decimal-string to u64 bigint. Throws RangeError on anything that is not a plain non-negative integer. */
export function parseU64(input: string): bigint {
  if (!/^\d{1,20}$/.test(input)) throw new RangeError('amount must be a decimal string of base units');
  const v = BigInt(input);
  if (v > U64_MAX) throw new RangeError('amount exceeds u64');
  return v;
}

/** Base units to a 2+ decimals display number (display only). */
export function usdcToNumber(base: bigint | string): number {
  const b = typeof base === 'bigint' ? base : BigInt(base);
  const neg = b < 0n;
  const abs = neg ? -b : b;
  const n = Number(abs / USDC_ONE) + Number(abs % USDC_ONE) / 1e6;
  return neg ? -n : n;
}

/** numeric/DB string (may contain a fractional part from numeric) to bigint base units, truncating any fraction. */
export function numericToBigInt(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  const s = typeof v === 'number' ? Math.trunc(v).toString() : v.split('.')[0]!;
  return BigInt(s === '' || s === '-' ? '0' : s);
}

/** Exact decimal string for `raw * 10^expo` (expo is typically negative). e.g. (11279751066n, -8) -> "112.79751066". */
export function rawToDecimalString(raw: bigint, expo: number): string {
  const neg = raw < 0n;
  let digits = (neg ? -raw : raw).toString();
  let out: string;
  if (expo >= 0) {
    out = digits + '0'.repeat(expo);
  } else {
    const places = -expo;
    if (digits.length <= places) digits = '0'.repeat(places - digits.length + 1) + digits;
    const int = digits.slice(0, digits.length - places);
    const frac = digits.slice(digits.length - places).replace(/0+$/, '');
    out = frac ? `${int}.${frac}` : int;
  }
  return neg ? `-${out}` : out;
}

/** raw * 10^expo as a JS number (display / float math only). */
export function rawToNumber(raw: bigint, expo: number): number {
  return Number(raw) * Math.pow(10, expo);
}

/** Human price to the raw i64 mantissa for a given exponent (e.g. 250.5, -8 -> 25050000000n). Rounds to nearest. */
export function numberToRaw(price: number, expo: number): bigint {
  if (!Number.isFinite(price) || price <= 0) throw new RangeError('price must be positive');
  const places = Math.max(0, -expo);
  // toFixed handles up to 100 digits and avoids exponent notation for the magnitudes we use
  const fixed = price.toFixed(Math.min(places, 20));
  const [i = '0', f = ''] = fixed.split('.');
  const frac = (f + '0'.repeat(places)).slice(0, places);
  let raw = BigInt(i + frac);
  if (expo > 0) raw = raw / 10n ** BigInt(expo);
  return raw;
}

export function priceFromBps(bps: number): number {
  return bps / 10_000;
}

export const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
