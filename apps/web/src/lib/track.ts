import type { TrackRecord } from '@groundgraph/sdk/api-types';

export function leadBuckets(h: TrackRecord['leadHistogram']): { label: string; n: number; h: number }[] {
  const max = Math.max(1, ...h.map((b) => b.count));
  return h.map((b, i) => {
    const next = h[i + 1]?.bucketMin;
    const label = i === 0 && b.bucketMin === 0 ? `<${next ?? 10}` : next != null ? `${b.bucketMin}-${next}` : `${b.bucketMin}+`;
    return { label, n: b.count, h: b.count / max };
  });
}

export function closerStats(rows: TrackRecord['rows']): { radar: number; market: number; tie: number; total: number } {
  let radar = 0;
  let market = 0;
  let tie = 0;
  for (const r of rows) {
    if (r.closer === 'radar') radar++;
    else if (r.closer === 'market') market++;
    else if (r.closer === 'tie') tie++;
  }
  return { radar, market, tie, total: radar + market + tie };
}
