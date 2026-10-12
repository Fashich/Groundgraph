import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { DEFAULT_BLOCKED, countryFromHeaders, isBlocked, isEntryRoute, parseBlocked } from '@/lib/geo';

/**
 * Geofence. Closes the entry routes (market list, radar, create) for countries listed in BLOCKED_COUNTRIES (comma separated ISO codes,
 * default: the US and comprehensively sanctioned countries) using the country header set by the CDN (cf-ipcountry or x-vercel-ip-country).
 * When no header is present access is allowed. Positions, single market pages and legal pages stay reachable so existing holders can exit.
 * API calls are not blocked here: the API enforces its own `geo_blocked` rule for buy and create, and never for sell, merge or redeem.
 */
export function proxy(req: NextRequest) {
  const blocked = parseBlocked(process.env.BLOCKED_COUNTRIES ?? DEFAULT_BLOCKED);
  if (blocked.size === 0) return NextResponse.next();
  const country = countryFromHeaders((n) => req.headers.get(n));
  if (isBlocked(country, blocked) && isEntryRoute(req.nextUrl.pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = '/blocked';
    url.search = '';
    return NextResponse.rewrite(url, { status: 451 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|gg-icon.png|gg-logo-full.png|\\.well-known|actions.json|blocked).*)'],
};
