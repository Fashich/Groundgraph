/** Public runtime configuration. Each NEXT_PUBLIC_* variable must be referenced literally so Next can inline it. */
export const env = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL || '/api').replace(/\/$/, ''),
  wsUrl: process.env.NEXT_PUBLIC_WS_URL || '',
  cluster: process.env.NEXT_PUBLIC_SOLANA_CLUSTER || 'devnet',
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com',
  usdcMint: process.env.NEXT_PUBLIC_USDC_MINT || '',
  programId: process.env.NEXT_PUBLIC_PROGRAM_ID || '',
  tosVersion: process.env.NEXT_PUBLIC_TOS_VERSION || '2026-10-01',
} as const;

/** WebSocket URL: explicit env wins, otherwise ws://localhost:8787/ws in dev and same-origin /ws in production. */
export function resolveWsUrl(): string {
  if (env.wsUrl) return env.wsUrl;
  if (typeof window === 'undefined') return '';
  if (process.env.NODE_ENV !== 'production') return 'ws://localhost:8787/ws';
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
}
