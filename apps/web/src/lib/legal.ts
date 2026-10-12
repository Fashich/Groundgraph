export type LegalDocKey = 'terms' | 'privacy' | 'risk';

export const LEGAL_KEYS: LegalDocKey[] = ['terms', 'privacy', 'risk'];

export const LEGAL_TAB: Record<LegalDocKey, string> = { terms: 'Terms', privacy: 'Privacy', risk: 'Risk' };

export interface LegalSection {
  n: string;
  t: string;
  d: string;
}

export interface LegalDoc {
  key: LegalDocKey;
  title: string;
  version: string;
  updated: string;
  readTime: string;
  intro: string;
  sections: LegalSection[];
}

/** Parse the small markdown dialect used in content/legal/*.md. */
export function parseLegal(key: LegalDocKey, md: string): LegalDoc {
  const lines = md.replace(/\r/g, '').split('\n');
  let title = '';
  const meta: Record<string, string> = {};
  const intro: string[] = [];
  const sections: LegalSection[] = [];
  let cur: { t: string; d: string[] } | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('# ')) {
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('## ')) {
      if (cur) sections.push({ n: String(sections.length + 1).padStart(2, '0'), t: cur.t, d: cur.d.join(' ').trim() });
      cur = { t: line.slice(3).trim(), d: [] };
      continue;
    }
    const m = /^(version|updated|read):\s*(.+)$/.exec(line);
    if (m && !cur) {
      meta[m[1]!] = m[2]!.trim();
      continue;
    }
    if (!line.trim()) continue;
    if (cur) cur.d.push(line.trim());
    else intro.push(line.trim());
  }
  if (cur) sections.push({ n: String(sections.length + 1).padStart(2, '0'), t: cur.t, d: cur.d.join(' ').trim() });
  return { key, title, version: meta.version ?? '', updated: meta.updated ?? '', readTime: meta.read ?? '', intro: intro.join(' '), sections };
}
