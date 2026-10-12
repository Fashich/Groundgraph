import type { GraphPayload, MarketSummary } from '@groundgraph/sdk/api-types';

export const HOW_STEPS = [
  { n: '01', t: 'Index', d: 'Every swap, transfer and market entry on Solana streams into a live wallet graph. Wallets are nodes; value flowing between them are edges.', tech: 'Chain data → graph store' },
  { n: '02', t: 'Score', d: 'Graph features (whale overlap, entry timing, hit rate, centrality, lead time) add up to a 0 to 100 smart money score per wallet, and a GraphSAGE model reads the graph around it.', tech: 'Five named features + GraphSAGE' },
  { n: '03', t: 'Trade', d: "Take an Above or Below position from a constant-product pool. The radar's lean sits beside every price, with the wallets behind it one tap away.", tech: 'Anchor program · Pyth resolution' },
] as const;

/** Highest scoring wallet in the payload, used by the landing sections that explain a score. */
export function topWallet(g: GraphPayload | null | undefined) {
  if (!g || g.nodes.length === 0) return null;
  return g.nodes.reduce((a, b) => (b.score > a.score ? b : a));
}

export function graphStats(g: GraphPayload | null | undefined) {
  if (!g) return null;
  return { wallets: g.nodes.length, smart: g.nodes.filter((n) => n.smart).length };
}

/** Markets whose radar is ready, strongest edge first. */
export function signalMarkets(items: MarketSummary[], n = 3): MarketSummary[] {
  return items
    .filter((m) => m.status === 'open' && m.radar.state === 'ready' && m.radar.edge != null)
    .sort((a, b) => Math.abs(b.radar.edge ?? 0) - Math.abs(a.radar.edge ?? 0))
    .slice(0, n);
}
