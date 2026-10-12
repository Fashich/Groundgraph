import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadKeypair } from '../src/keypair';

describe('loadKeypair', () => {
  const kp = Keypair.generate();
  const json = JSON.stringify(Array.from(kp.secretKey));

  it('reads a solana-keygen style file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kp-'));
    const file = join(dir, 'id.json');
    writeFileSync(file, json);
    expect(loadKeypair(file).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('reads the JSON array inline', () => {
    expect(loadKeypair(`  ${json}  `).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('rejects malformed input without echoing the secret', () => {
    for (const bad of ['[1,2,3]', '[]', '{"a":1}', `[${Array(64).fill(300).join(',')}]`, 'not json [']) {
      try {
        loadKeypair(bad);
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as Error).message).not.toBe('should have thrown');
        expect((e as Error).message).not.toContain('300,300');
      }
    }
  });

  it('reports a missing file clearly', () => {
    expect(() => loadKeypair('/nonexistent/path/id.json')).toThrow(/could not read keypair file/);
  });
});
