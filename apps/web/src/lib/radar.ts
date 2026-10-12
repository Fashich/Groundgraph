import type { GraphNode, GraphPayload } from '@groundgraph/sdk/api-types';
import { nodePasses } from './graph';
import type { RadarFilters } from './queries';

/** Filtered view of the wallet graph. Thresholds come from the data, never from constants. */
export interface Derived {
  pass: GraphNode[];
  flagged: GraphNode[];
  top: GraphNode[];
  minSmart: number | null;
  minTop: number | null;
}

export function deriveRadar(data: GraphPayload | undefined, f: RadarFilters): Derived {
  const nodes = data?.nodes ?? [];
  const pass = nodes.filter((n) => nodePasses(n, { minScore: f.minScore, cluster: f.cluster, showCrowd: f.crowd }));
  const flagged = pass.filter((n) => n.smart);
  const top = [...flagged].sort((a, b) => b.score - a.score).slice(0, 6);
  const sm = nodes.filter((n) => n.smart).map((n) => n.score);
  const tp = nodes.filter((n) => n.top).map((n) => n.score);
  return { pass, flagged, top, minSmart: sm.length ? Math.min(...sm) : null, minTop: tp.length ? Math.min(...tp) : null };
}
