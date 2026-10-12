import { CH, RK, type Logger, type Redis } from '@groundgraph/svc-core';

/** Thin wrapper over Redis pub/sub with the channel names the API fans out to WebSocket clients. All calls are best effort. */
export class Publisher {
  constructor(
    private redis: Redis | null,
    private log: Logger,
    private count: (kind: string) => void = () => {},
  ) {}

  private async send(channel: string, data: unknown, kind: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.publish(channel, JSON.stringify({ type: 'delta', data }));
      this.count(kind);
    } catch (err) {
      this.log.warn({ err: (err as Error).message, channel }, 'redis publish failed');
    }
  }

  market(marketId: string, data: unknown): Promise<void> {
    return this.send(CH.market(marketId), data, 'market');
  }

  me(wallet: string, data: unknown): Promise<void> {
    return this.send(CH.me(wallet), data, 'me');
  }

  /** The API added a pending buy reservation when it built the transaction; once the buy is indexed it is dropped. */
  async consumeReservation(wallet: string, usdc: string): Promise<void> {
    if (!this.redis) return;
    try {
      const key = RK.pendingSpend(wallet);
      const members = await this.redis.zrange(key, 0, -1);
      const hit = members.find((m) => m.startsWith(`${usdc}:`));
      if (hit) await this.redis.zrem(key, hit);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'reservation cleanup failed');
    }
  }

  async consumeQuestion(marketId: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(RK.pendingQuestion(marketId)).catch(() => undefined);
  }

  async question(marketId: string): Promise<string | undefined> {
    if (!this.redis) return undefined;
    try {
      return (await this.redis.get(RK.pendingQuestion(marketId))) ?? undefined;
    } catch {
      return undefined;
    }
  }
}
