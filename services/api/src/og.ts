import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type { MarketSummary } from '@groundgraph/sdk/api-types';
import satori from 'satori';

/**
 * 1200x630 share card (matches the ShareCard design: dark surface, teal ABOVE, magenta BELOW, mono details).
 * Fonts come from the bundled @fontsource/inter package, nothing is fetched at runtime.
 */
const require = createRequire(import.meta.url);

interface FontSpec { name: string; data: Buffer; weight: 400 | 600 | 700; style: 'normal' }
let fonts: FontSpec[] | null = null;

function loadFonts(): FontSpec[] {
  if (fonts) return fonts;
  const dir = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
  fonts = ([400, 600, 700] as const).map((weight) => ({ name: 'Inter', data: readFileSync(join(dir, `inter-latin-${weight}-normal.woff`)), weight, style: 'normal' as const }));
  return fonts;
}

const C = {
  bg: '#07070d',
  panel: '#11111c',
  border: '#272740',
  text: '#f2f2fa',
  muted: '#8e8ea8',
  above: '#2de2c6',
  below: '#e040fb',
  accent: '#7c5cff',
};

type Node = { type: string; props: { style?: Record<string, unknown>; children?: unknown } };
const el = (style: Record<string, unknown>, children?: unknown): Node => ({ type: 'div', props: { style: { display: 'flex', boxSizing: 'border-box', ...style }, children } });
const text = (style: Record<string, unknown>, s: string): Node => el(style, s);

const cents = (p: number) => `${Math.round(p * 100)}¢`;
const money = (base: string) => {
  const n = Number(base) / 1e6;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
};

export interface OgInput {
  market: MarketSummary;
  webHost: string;
  clusterLabel: string;
}

export function ogTree(i: OgInput): Node {
  const m = i.market;
  const ends = new Date(m.endsAt);
  const endsLabel = `${ends.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${ends.toISOString().slice(11, 16)} UTC`;
  const radarLine =
    m.radar.state === 'ready' && m.radar.p !== null
      ? `Radar P(above) ${Math.round(m.radar.p * 100)}%${m.radar.ci !== null ? ` ±${m.radar.ci}` : ''} · ${m.radar.n} flagged wallets`
      : `Radar is building · ${m.radar.n} flagged wallets so far`;
  const resolved = m.status === 'settled' || m.status === 'voided';
  const status = m.status === 'settled' ? `Settled ${m.outcome ? m.outcome.toUpperCase() : ''}` : m.status === 'voided' ? 'Voided' : m.status === 'trading_closed' ? 'Trading closed' : `Ends ${endsLabel}`;
  const side = (label: string, price: number, color: string) =>
    el({ flexDirection: 'column', flex: 1, padding: '26px 32px', borderRadius: 24, border: `2px solid ${color}55`, background: `${color}14` }, [
      text({ fontSize: 24, fontWeight: 600, color, letterSpacing: 2 }, `${label}`),
      text({ fontSize: 96, fontWeight: 700, color: C.text, marginTop: 4 }, cents(price)),
      text({ fontSize: 24, color: C.muted }, `${Math.round(price * 100)}% implied`),
    ]);
  return el({ width: 1200, height: 630, flexDirection: 'column', justifyContent: 'space-between', padding: '48px 64px', background: C.bg, color: C.text, fontFamily: 'Inter' }, [
    el({ justifyContent: 'space-between', alignItems: 'center' }, [
      el({ alignItems: 'center' }, [
        el({ width: 18, height: 18, borderRadius: 9, background: C.above, marginRight: 14 }),
        text({ fontSize: 34, fontWeight: 700 }, 'Groundgraph'),
      ]),
      text({ fontSize: 22, color: C.muted, padding: '8px 18px', border: `2px solid ${C.border}`, borderRadius: 999 }, i.clusterLabel),
    ]),
    el({ flexDirection: 'column' }, [
      text({ fontSize: m.question.length > 70 ? 46 : m.question.length > 44 ? 52 : 60, fontWeight: 700, lineHeight: 1.12, color: C.text }, m.question),
      text({ fontSize: 26, color: C.muted, marginTop: 14 }, `${m.assetSymbol} · ${status} · Vol ${money(m.volume)}${resolved ? '' : ` · Fee ${(m.feeBpsNow / 100).toFixed(2)}%`}`),
    ]),
    el({ gap: 28 }, [side('ABOVE', m.priceAbove, C.above), side('BELOW', 1 - m.priceAbove, C.below)]),
    el({ justifyContent: 'space-between', alignItems: 'center' }, [
      text({ fontSize: 26, color: C.above, fontWeight: 600 }, radarLine),
      text({ fontSize: 22, color: C.muted }, i.webHost),
    ]),
  ]);
}

export async function renderOgPng(i: OgInput): Promise<Buffer> {
  const svg = await satori(ogTree(i) as never, { width: 1200, height: 630, fonts: loadFonts() });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { loadSystemFonts: false } }).render().asPng());
}
