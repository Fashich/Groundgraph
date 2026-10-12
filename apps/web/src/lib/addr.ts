const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type AddrStatus = 'empty' | 'evm' | 'ok' | 'bad';

/** Classify a pasted address. EVM (0x...) addresses get their own helpful message. */
export function addrStatus(v: string): AddrStatus {
  if (!v) return 'empty';
  if (/^0x/i.test(v)) return 'evm';
  return SOL_RE.test(v) ? 'ok' : 'bad';
}

export function addrMessage(status: AddrStatus, short: string): { text: string; tone: 'ok' | 'error' | 'hint' } {
  if (status === 'ok') return { text: `Valid Solana address · ${short}`, tone: 'ok' };
  if (status === 'evm') return { text: 'That is an EVM (0x…) address. Groundgraph runs on Solana: in MetaMask, switch to your Solana account and copy that address.', tone: 'error' };
  if (status === 'bad') return { text: 'Not a valid Solana address. Expected base58, 32–44 characters.', tone: 'error' };
  return { text: 'View-only shows your positions and radar score. Trading and publishing need a signing wallet.', tone: 'hint' };
}
