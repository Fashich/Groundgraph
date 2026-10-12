// Reads tests/radar_vectors.json and runs every case through the real SDK function. Prints a JSON summary.
// state, n, ci and edge must match exactly; p must match to 1e-12 relative (V8 and glibc differ by an ulp in exp/log).
import { readFileSync } from 'node:fs';
import { radarProbability } from '../../../packages/sdk/src/radar';

const path = process.argv[2];
const doc = JSON.parse(readFileSync(path, 'utf8'));
const bad: string[] = [];
let maxRel = 0;
for (const c of doc.cases) {
  const r = radarProbability({ pMarket: c.pMarket, flagged: c.flagged });
  const e = c.expected;
  const same =
    r.state === e.state &&
    r.n === e.n &&
    (e.p === null ? r.p === null : r.p !== null && Math.abs(r.p - e.p) <= 1e-12 * Math.abs(e.p)) &&
    (e.ci === null ? r.ci === null : r.ci === e.ci) &&
    (e.edge === null ? r.edge === null : r.edge === e.edge);
  if (e.p !== null && r.p !== null) maxRel = Math.max(maxRel, Math.abs(r.p - e.p) / Math.abs(e.p));
  if (!same) bad.push(`${c.name}: ts=${JSON.stringify(r)} py=${JSON.stringify(e)}`);
}
console.log(JSON.stringify({ total: doc.cases.length, mismatches: bad.length, maxRelDiffP: maxRel, first: bad.slice(0, 5) }));
