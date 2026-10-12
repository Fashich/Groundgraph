#!/usr/bin/env node
// Copy lint for the Groundgraph web app: terminology and punctuation rules from BUILD_CONTEXT.md.
// Usage: node scripts/copy-lint.mjs            (exit 1 when a rule is broken)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EM_DASH = String.fromCharCode(0x2014);

/** Words and phrases that never appear in user-facing copy. Matched on whole words, case-insensitive. */
export const BANNED = [
  { re: /\bbet(s|ting|tor|tors)?\b/i, why: 'say "position" or "trade"' },
  { re: /\bodds\b/i, why: 'say "implied probability" or price in cents' },
  { re: /\bgambl(e|es|ed|ing|er|ers)\b/i, why: 'not a gambling product' },
  { re: /\bjackpot\b/i, why: 'banned term' },
  { re: /\bwin big\b/i, why: 'banned phrase' },
  { re: /\bclaim(ing)? (your )?winnings\b/i, why: 'say "redeem"' },
  { re: /\bwinnings\b/i, why: 'say "payout" or "redeem"' },
];

/** Outcome labels must be ABOVE / BELOW, never a bare uppercase YES / NO. */
export const OUTCOME_LABEL = /(['"`>]\s*)(YES|NO)(\s*['"`<])/;

const SKIP_DIRS = new Set(['node_modules', '.next', 'e2e-screenshots', 'test-results', 'playwright-report', 'coverage']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.md', '.json', '.css', '.html', '.yml', '.yaml']);

export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(path.extname(name))) out.push(p);
  }
  return out;
}

/** Scan one file's text. `copy` is true for files whose strings reach users. */
export function scanText(text, { copy }) {
  const found = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.includes(EM_DASH)) found.push({ line: i + 1, rule: 'em-dash', text: line.trim().slice(0, 120) });
    if (!copy) return;
    for (const b of BANNED) if (b.re.test(line)) found.push({ line: i + 1, rule: `term ${b.re.source}`, text: line.trim().slice(0, 120), why: b.why });
    if (OUTCOME_LABEL.test(line)) found.push({ line: i + 1, rule: 'yes-no-label', text: line.trim().slice(0, 120), why: 'use ABOVE / BELOW' });
  });
  return found;
}

/** Directories whose files may reach users (everything else is checked for punctuation only). */
const COPY_DIRS = ['src', 'content', 'mock-api', 'public'];

export function scanApp(root) {
  const results = [];
  const roots = ['src', 'content', 'mock-api', 'public', 'tests', 'e2e', 'scripts'].map((d) => path.join(root, d));
  for (const dir of roots) {
    try {
      statSync(dir);
    } catch {
      continue;
    }
    const isCopy = COPY_DIRS.includes(path.basename(dir));
    for (const file of walk(dir)) {
      for (const f of scanText(readFileSync(file, 'utf8'), { copy: isCopy })) results.push({ file: path.relative(root, file), ...f });
    }
  }
  for (const f of ['README.md', 'package.json', '.env.example']) {
    try {
      for (const r of scanText(readFileSync(path.join(root, f), 'utf8'), { copy: f === 'README.md' })) results.push({ file: f, ...r });
    } catch {
      /* optional */
    }
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const res = scanApp(root);
  for (const r of res) console.error(`${r.file}:${r.line}  ${r.rule}${r.why ? ` (${r.why})` : ''}\n    ${r.text}`);
  if (res.length) {
    console.error(`\ncopy-lint: ${res.length} problem(s)`);
    process.exit(1);
  }
  console.log('copy-lint: clean');
}
