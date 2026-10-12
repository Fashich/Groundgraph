import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Keypair } from '@solana/web3.js';

/**
 * Load a signing keypair from an env value. Accepts a file path (the standard `solana-keygen` JSON array file, `~` allowed)
 * or the JSON array itself. The secret never gets logged.
 */
export function loadKeypair(spec: string): Keypair {
  const trimmed = spec.trim();
  let raw: string;
  if (trimmed.startsWith('[')) {
    raw = trimmed;
  } else {
    const path = trimmed.startsWith('~') ? homedir() + trimmed.slice(1) : trimmed;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`could not read keypair file ${path}: ${(err as Error).message}`);
    }
  }
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error('keypair must be a JSON array of 64 bytes');
  }
  if (!Array.isArray(arr) || arr.length !== 64 || arr.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error('keypair must be a JSON array of 64 bytes');
  }
  return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
}
