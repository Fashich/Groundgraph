import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** One throwaway database per run: svc_api, rebuilt from every migration (scripts/dev-db.sh). Redis DB 2 is flushed per test file. */
export default function setup(): void {
  execFileSync('bash', [resolve(__dirname, '../../../scripts/dev-db.sh'), 'svc_api'], { stdio: 'pipe' });
}
