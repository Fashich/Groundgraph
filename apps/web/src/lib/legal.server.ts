import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LEGAL_KEYS, parseLegal, type LegalDoc, type LegalDocKey } from './legal';

/** Reads content/legal/*.md. Server only. */
export async function loadLegal(): Promise<Record<LegalDocKey, LegalDoc>> {
  const out = {} as Record<LegalDocKey, LegalDoc>;
  await Promise.all(
    LEGAL_KEYS.map(async (k) => {
      const md = await readFile(path.join(process.cwd(), 'content', 'legal', `${k}.md`), 'utf8');
      out[k] = parseLegal(k, md);
    }),
  );
  return out;
}
