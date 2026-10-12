import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGAL_KEYS, parseLegal } from '@/lib/legal';

const read = (k: string) => readFileSync(path.join(__dirname, '..', 'content', 'legal', `${k}.md`), 'utf8');

describe('parseLegal', () => {
  it('reads the title, meta lines, intro and numbered sections', () => {
    const d = parseLegal('terms', '# Terms\n\nversion: 2026-10-01\nupdated: Oct 1, 2026\nread: 3 min read\n\nIntro line one.\nIntro line two.\n\n## First\nBody a.\nBody b.\n\n## Second\nBody c.\n');
    expect(d.title).toBe('Terms');
    expect(d.version).toBe('2026-10-01');
    expect(d.updated).toBe('Oct 1, 2026');
    expect(d.readTime).toBe('3 min read');
    expect(d.intro).toBe('Intro line one. Intro line two.');
    expect(d.sections).toEqual([
      { n: '01', t: 'First', d: 'Body a. Body b.' },
      { n: '02', t: 'Second', d: 'Body c.' },
    ]);
  });
  it('does not mistake a body line that starts with "version:" for metadata', () => {
    const d = parseLegal('terms', '# T\nversion: 1\n\n## S\nversion: not meta\n');
    expect(d.version).toBe('1');
    expect(d.sections[0]!.d).toBe('version: not meta');
  });
});

describe('shipped legal documents', () => {
  for (const k of LEGAL_KEYS) {
    it(`${k}.md parses, carries the Terms version and has real sections`, () => {
      const d = parseLegal(k, read(k));
      expect(d.title.length).toBeGreaterThan(3);
      expect(d.version).toBe('2026-10-01');
      expect(d.sections.length).toBeGreaterThanOrEqual(4);
      for (const s of d.sections) expect(s.d.length, `${k} ${s.t}`).toBeGreaterThan(20);
    });
  }
  it('the version matches the one the app asks the API to record', () => {
    const v = parseLegal('terms', read('terms')).version;
    expect(v).toBe(process.env.NEXT_PUBLIC_TOS_VERSION || '2026-10-01');
  });
  it('the risk disclosure says positions can end at zero and that this is devnet', () => {
    const t = read('risk');
    expect(t).toMatch(/\$0/);
    expect(t).toMatch(/devnet/i);
  });
});
