/** Geofence helpers (used by proxy.ts, unit tested). */

/** Default list when BLOCKED_COUNTRIES is not set: the United States and comprehensively sanctioned countries. */
export const DEFAULT_BLOCKED = 'US,CU,IR,KP,SY';

export function parseBlocked(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{2}$/.test(s)),
  );
}

/** Country from the CDN headers. Returns null when no header is present (then access is allowed). */
export function countryFromHeaders(get: (name: string) => string | null | undefined): string | null {
  const v = get('cf-ipcountry') || get('x-vercel-ip-country');
  if (!v) return null;
  const c = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

export function isBlocked(country: string | null, blocked: Set<string>): boolean {
  return country !== null && blocked.has(country);
}

/**
 * Routes that are closed in a blocked region: the market list, the radar and market creation. Everything else stays
 * reachable on purpose (landing, legal pages, Positions and single market pages) so a wallet that already holds
 * shares can still sell, merge and redeem. The API refuses buy and create with `geo_blocked`; it never gates exits.
 */
export function isEntryRoute(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  return p === '/markets' || p === '/create' || p === '/radar';
}
