import type { NonceResp } from '@groundgraph/sdk/api-types';

/** Plain-text Sign-In With Solana message (CAIP-122 style). Used for the signMessage fallback. */
export function createSignInMessageText(n: NonceResp, address: string): string {
  const lines: string[] = [];
  lines.push(`${n.domain} wants you to sign in with your Solana account:`);
  lines.push(address);
  lines.push('');
  if (n.statement) {
    lines.push(n.statement);
    lines.push('');
  }
  const fields: string[] = [];
  fields.push(`URI: ${n.uri}`);
  fields.push('Version: 1');
  fields.push(`Chain ID: ${n.chainId.replace(/^solana:/, '')}`);
  fields.push(`Nonce: ${n.nonce}`);
  fields.push(`Issued At: ${n.issuedAt}`);
  fields.push(`Expiration Time: ${n.expirationTime}`);
  fields.push(`Resources:\n- tos:${n.tosVersion}`);
  return lines.concat(fields).join('\n');
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SigningWallet {
  signIn?: (input: Record<string, unknown>) => Promise<{ signedMessage: Uint8Array; signature: Uint8Array; account?: { address?: string } }>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

/** Sign in with the Wallet Standard `solana:signIn` feature, falling back to signMessage. */
export async function signInWithWallet(w: SigningWallet, address: string, n: NonceResp): Promise<{ signedMessage: string; signature: string }> {
  if (w.signIn) {
    const out = await w.signIn({
      domain: n.domain,
      address,
      statement: n.statement,
      uri: n.uri,
      version: '1',
      chainId: n.chainId.replace(/^solana:/, ''),
      nonce: n.nonce,
      issuedAt: n.issuedAt,
      expirationTime: n.expirationTime,
      resources: [`tos:${n.tosVersion}`],
    });
    return { signedMessage: bytesToBase64(out.signedMessage), signature: bytesToBase64(out.signature) };
  }
  if (w.signMessage) {
    const message = new TextEncoder().encode(createSignInMessageText(n, address));
    const signature = await w.signMessage(message);
    return { signedMessage: bytesToBase64(message), signature: bytesToBase64(signature) };
  }
  throw new Error('This wallet cannot sign in. Open a wallet that supports message signing.');
}
