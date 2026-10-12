import type { GraphNode } from '@groundgraph/sdk/api-types';

export type GraphMode = 'hero' | 'explorer' | 'mini';

/** Max nodes drawn per mode. Lite (phones) stays at 70 or fewer. */
export function graphLimit(mode: GraphMode, lite: boolean): number {
  if (mode === 'explorer') return lite ? 70 : 600;
  if (mode === 'mini') return lite ? 40 : 72;
  return lite ? 54 : 132;
}

/**
 * Choose which payload nodes to draw. Market members come first, then the highest scoring wallets (up to
 * 45% of the remaining budget), then an evenly spaced sample of the crowd so the shape of the graph survives.
 * Returns indices into `nodes`, in payload order.
 */
export function pickNodes(nodes: GraphNode[], limit: number, members?: ReadonlySet<string> | null): number[] {
  if (nodes.length <= limit && !members) return nodes.map((_, i) => i);
  const chosen = new Set<number>();
  if (members && members.size) {
    const m = nodes.map((n, i) => [i, n] as const).filter(([, n]) => members.has(n.addr)).sort((a, b) => b[1].score - a[1].score);
    for (const [i] of m) {
      if (chosen.size >= limit) break;
      chosen.add(i);
    }
  }
  const rest = limit - chosen.size;
  if (rest > 0) {
    const byScore = nodes.map((n, i) => [i, n.score] as const).filter(([i]) => !chosen.has(i)).sort((a, b) => b[1] - a[1]);
    const top = Math.floor(rest * 0.45);
    for (let k = 0; k < top && k < byScore.length; k++) chosen.add(byScore[k]![0]);
    const remain = nodes.map((_, i) => i).filter((i) => !chosen.has(i));
    const need = limit - chosen.size;
    if (need > 0 && remain.length) {
      const step = remain.length / Math.min(need, remain.length);
      for (let k = 0; k < Math.min(need, remain.length); k++) chosen.add(remain[Math.floor(k * step)]!);
    }
  }
  return [...chosen].sort((a, b) => a - b);
}

export function nodePasses(n: Pick<GraphNode, 'score' | 'smart' | 'cluster'>, f: { minScore: number; cluster: string; showCrowd: boolean }): boolean {
  return n.score >= f.minScore && (f.cluster === 'all' || String(n.cluster) === f.cluster) && (f.showCrowd || n.smart);
}
