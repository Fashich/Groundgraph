import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { NonceResp } from '@groundgraph/sdk/api-types';
import { base64ToBytes, bytesToBase64, createSignInMessageText, signInWithWallet } from '@/lib/siws';
// The API's own verifier. If either side changes the message format, these tests fail.
import { buildSiwsMessage, checkSiwsFields, parseSiwsMessage, tosStatement, verifyEd25519 } from '../../../services/api/src/auth/siws';

const kp = nacl.sign.keyPair();
const address = bs58.encode(kp.publicKey);
const now = new Date('2026-10-12T12:00:00.000Z');

function nonce(over: Partial<NonceResp> = {}): NonceResp {
  return {
    nonce: 'AbCdEfGh12345678AbCdEfGh',
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60_000).toISOString(),
    domain: 'localhost:3000',
    uri: 'http://localhost:3000',
    statement: tosStatement('2026-10-01'),
    tosVersion: '2026-10-01',
    chainId: 'solana:devnet',
    ...over,
  };
}

describe('base64 helpers', () => {
  it('round trips arbitrary bytes, including large buffers', () => {
    const big = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(Array.from(base64ToBytes(bytesToBase64(big)))).toEqual(Array.from(big));
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });
});

describe('SIWS message', () => {
  it('is byte identical to the message the API builds', () => {
    const n = nonce();
    const mine = createSignInMessageText(n, address);
    const theirs = buildSiwsMessage({
      domain: n.domain,
      address,
      statement: n.statement,
      uri: n.uri,
      version: '1',
      chainId: 'devnet',
      nonce: n.nonce,
      issuedAt: n.issuedAt,
      expirationTime: n.expirationTime,
      resources: [`tos:${n.tosVersion}`],
    });
    expect(mine).toBe(theirs);
  });

  it('parses on the API side and carries the Terms version', () => {
    const f = parseSiwsMessage(createSignInMessageText(nonce(), address));
    expect(f.address).toBe(address);
    expect(f.resources).toEqual(['tos:2026-10-01']);
    expect(f.statement).toContain('version 2026-10-01');
  });
});

describe('signInWithWallet', () => {
  const exp = { wallet: address, domain: 'localhost:3000', uri: 'http://localhost:3000', chainId: 'devnet', tosVersion: '2026-10-01', now };

  it('signMessage fallback produces a signature the API accepts', async () => {
    const n = nonce();
    const out = await signInWithWallet({ signMessage: async (m) => nacl.sign.detached(m, kp.secretKey) }, address, n);
    const msgBytes = base64ToBytes(out.signedMessage);
    expect(verifyEd25519(msgBytes, base64ToBytes(out.signature), address)).toBe(true);
    expect(() => checkSiwsFields(new TextDecoder().decode(msgBytes), exp)).not.toThrow();
  });

  it('prefers the Wallet Standard solana:signIn feature and passes the nonce fields through', async () => {
    const n = nonce();
    let seen: Record<string, unknown> | null = null;
    const out = await signInWithWallet(
      {
        signIn: async (input) => {
          seen = input;
          const signedMessage = new TextEncoder().encode(createSignInMessageText(n, address));
          return { signedMessage, signature: nacl.sign.detached(signedMessage, kp.secretKey) };
        },
        signMessage: async () => {
          throw new Error('should not be used');
        },
      },
      address,
      n,
    );
    expect(seen).toMatchObject({ domain: n.domain, address, nonce: n.nonce, chainId: 'devnet', version: '1', resources: ['tos:2026-10-01'] });
    expect(verifyEd25519(base64ToBytes(out.signedMessage), base64ToBytes(out.signature), address)).toBe(true);
  });

  it('fails clearly when the wallet cannot sign messages', async () => {
    await expect(signInWithWallet({}, address, nonce())).rejects.toThrow(/cannot sign in/i);
  });

  it('a tampered message or a different key fails verification', async () => {
    const n = nonce();
    const out = await signInWithWallet({ signMessage: async (m) => nacl.sign.detached(m, kp.secretKey) }, address, n);
    const bytes = base64ToBytes(out.signedMessage);
    bytes[10] = bytes[10]! ^ 1;
    expect(verifyEd25519(bytes, base64ToBytes(out.signature), address)).toBe(false);
    const other = bs58.encode(nacl.sign.keyPair().publicKey);
    expect(verifyEd25519(base64ToBytes(out.signedMessage), base64ToBytes(out.signature), other)).toBe(false);
  });

  it('the API rejects an expired message or one for the wrong Terms version', async () => {
    const stale = nonce({ issuedAt: new Date(now.getTime() - 20 * 60_000).toISOString(), expirationTime: new Date(now.getTime() - 15 * 60_000).toISOString() });
    expect(() => checkSiwsFields(createSignInMessageText(stale, address), exp)).toThrow(/expired/);
    expect(() => checkSiwsFields(createSignInMessageText(nonce(), address), { ...exp, tosVersion: '2099-01-01' })).toThrow(/Terms version/);
  });
});
