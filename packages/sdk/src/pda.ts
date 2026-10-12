import { PublicKey } from '@solana/web3.js';
import { BPF_LOADER_UPGRADEABLE_PROGRAM_ID, PROGRAM_ID } from './constants';

const enc = new TextEncoder();
const seed = (s: string): Uint8Array => enc.encode(s);

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) throw new RangeError('nonce must fit in u64');
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function find(seeds: Uint8Array[], programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/** Program derived addresses (seeds mirror programs/groundgraph/src/constants.rs). */
export const pda = {
  config: (): PublicKey => find([seed('config')]),
  feed: (feedId: Uint8Array): PublicKey => {
    if (feedId.length !== 32) throw new RangeError('feed id must be 32 bytes');
    return find([seed('feed'), feedId]);
  },
  market: (creator: PublicKey, nonce: bigint): PublicKey => find([seed('market'), creator.toBytes(), u64le(nonce)]),
  vault: (market: PublicKey): PublicKey => find([seed('vault'), market.toBytes()]),
  aboveMint: (market: PublicKey): PublicKey => find([seed('above'), market.toBytes()]),
  belowMint: (market: PublicKey): PublicKey => find([seed('below'), market.toBytes()]),
  lpMint: (market: PublicKey): PublicKey => find([seed('lp'), market.toBytes()]),
  /** BPF upgradeable loader ProgramData account of the Groundgraph program (used by `initialize_config`). */
  programData: (): PublicKey => find([PROGRAM_ID.toBytes()], BPF_LOADER_UPGRADEABLE_PROGRAM_ID),
};
