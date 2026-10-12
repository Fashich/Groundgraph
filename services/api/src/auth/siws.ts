import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

/** Sign-In With Solana (CAIP-122) message fields. */
export interface SiwsFields {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  resources: string[];
}

export const NONCE_TTL_MS = 5 * 60_000;
const MAX_MESSAGE_LIFETIME_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 60_000;

export function newNonce(): string {
  // 24 chars of base58: alphanumeric as required by the SIWS spec (>= 8 chars)
  return bs58.encode(randomBytes(18)).slice(0, 24).padEnd(24, 'x');
}

export function tosStatement(tosVersion: string): string {
  return `I accept the Groundgraph Terms of Service (version ${tosVersion}), Privacy Policy and Risk Disclosure. Signing in does not authorize any transaction.`;
}

export function buildSiwsMessage(f: SiwsFields): string {
  const lines = [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.address,
    '',
    f.statement,
    '',
    `URI: ${f.uri}`,
    `Version: ${f.version}`,
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
  ];
  if (f.resources.length) lines.push('Resources:', ...f.resources.map((r) => `- ${r}`));
  return lines.join('\n');
}

export class SiwsError extends Error {}

export function parseSiwsMessage(text: string): SiwsFields {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = /^(\S+) wants you to sign in with your Solana account:$/.exec(lines[0] ?? '');
  if (!head) throw new SiwsError('not a Sign-In With Solana message');
  const address = lines[1] ?? '';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new SiwsError('invalid address line');
  if (lines[2] !== '') throw new SiwsError('malformed message header');
  // statement runs until the first blank line
  let i = 3;
  const stmt: string[] = [];
  while (i < lines.length && lines[i] !== '') stmt.push(lines[i++]!);
  i++; // blank line after the statement
  const kv: Record<string, string> = {};
  const resources: string[] = [];
  let inResources = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '') continue;
    if (inResources) {
      const r = /^- (.+)$/.exec(line);
      if (!r) throw new SiwsError('malformed resources');
      resources.push(r[1]!);
      continue;
    }
    if (line === 'Resources:') {
      inResources = true;
      continue;
    }
    const m = /^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time|Not Before|Request ID): (.*)$/.exec(line);
    if (!m) throw new SiwsError(`unexpected line: ${line.slice(0, 40)}`);
    if (kv[m[1]!] !== undefined) throw new SiwsError(`duplicate field ${m[1]}`);
    kv[m[1]!] = m[2]!;
  }
  for (const req of ['URI', 'Version', 'Chain ID', 'Nonce', 'Issued At', 'Expiration Time']) {
    if (!kv[req]) throw new SiwsError(`missing ${req}`);
  }
  return {
    domain: head[1]!,
    address,
    statement: stmt.join('\n'),
    uri: kv['URI']!,
    version: kv['Version']!,
    chainId: kv['Chain ID']!,
    nonce: kv['Nonce']!,
    issuedAt: kv['Issued At']!,
    expirationTime: kv['Expiration Time']!,
    resources,
  };
}

export interface SiwsExpectation {
  wallet: string;
  domain: string;
  uri: string;
  chainId: string;
  tosVersion: string;
  now: Date;
}

/**
 * Check every field of a signed SIWS message against what the server issued. Does not touch the nonce store
 * (the caller burns the nonce atomically). Returns the parsed fields.
 */
export function checkSiwsFields(message: string, exp: SiwsExpectation): SiwsFields {
  const f = parseSiwsMessage(message);
  if (f.address !== exp.wallet) throw new SiwsError('message address does not match the wallet');
  if (f.domain !== exp.domain) throw new SiwsError(`domain mismatch (expected ${exp.domain})`);
  if (f.uri !== exp.uri) throw new SiwsError(`uri mismatch (expected ${exp.uri})`);
  if (f.version !== '1') throw new SiwsError('unsupported SIWS version');
  if (f.chainId !== exp.chainId) throw new SiwsError(`chain id mismatch (expected ${exp.chainId})`);
  if (!f.statement.includes(`(version ${exp.tosVersion})`)) {
    throw new SiwsError(`the message must accept Terms version ${exp.tosVersion}`);
  }
  const issued = Date.parse(f.issuedAt);
  const expires = Date.parse(f.expirationTime);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) throw new SiwsError('invalid timestamps');
  const now = exp.now.getTime();
  if (issued > now + CLOCK_SKEW_MS) throw new SiwsError('message issued in the future');
  if (expires <= now) throw new SiwsError('message expired');
  if (expires - issued > MAX_MESSAGE_LIFETIME_MS) throw new SiwsError('message lifetime too long');
  return f;
}

export function verifyEd25519(messageBytes: Uint8Array, signature: Uint8Array, wallet: string): boolean {
  let pub: Uint8Array;
  try {
    pub = bs58.decode(wallet);
  } catch {
    return false;
  }
  if (pub.length !== 32 || signature.length !== 64) return false;
  return nacl.sign.detached.verify(messageBytes, signature, pub);
}

export function isValidSolanaAddress(addr: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return false;
  try {
    return bs58.decode(addr).length === 32;
  } catch {
    return false;
  }
}
