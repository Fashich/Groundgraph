import { sleep, type Logger } from '@groundgraph/svc-core';
import type { KeeperMetrics } from './metrics';

export interface Loop {
  name: string;
  /** milliseconds until the next iteration (may change between iterations) */
  everyMs: () => number;
  run: () => Promise<unknown>;
  /** run once immediately before waiting */
  immediate?: boolean;
}

/**
 * Runs each loop sequentially (an iteration never overlaps itself), logs and counts errors instead of dying, and
 * returns once every loop noticed the abort signal.
 */
export async function runLoops(loops: Loop[], log: Logger, metrics: KeeperMetrics, signal: AbortSignal): Promise<void> {
  const one = async (l: Loop) => {
    let first = true;
    while (!signal.aborted) {
      if (!(first && l.immediate)) {
        await sleep(l.everyMs(), signal);
        if (signal.aborted) return;
      }
      first = false;
      const end = metrics.loopSeconds.startTimer({ loop: l.name });
      try {
        await l.run();
        metrics.lastTick.set({ loop: l.name }, Date.now() / 1000);
      } catch (err) {
        metrics.loopErrors.inc({ loop: l.name });
        log.error({ loop: l.name, err: (err as Error).message }, 'loop iteration failed');
      } finally {
        end();
      }
    }
  };
  await Promise.all(loops.map(one));
}
