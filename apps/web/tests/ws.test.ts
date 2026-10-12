import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSocket, backoffMs, type ChannelMsg } from '@/lib/ws';

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function make() {
  const got: ChannelMsg[] = [];
  const states: string[] = [];
  const resyncs: string[][] = [];
  const s = new LiveSocket({
    url: () => 'ws://test/ws',
    onMessage: (m) => got.push(m),
    onState: (x) => states.push(x),
    onLag: () => undefined,
    onResync: (c) => resyncs.push(c),
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    pingEveryMs: 1000,
    pongTimeoutMs: 500,
    idleCloseMs: 100,
  });
  return { s, got, states, resyncs };
}
const m = (ch: string, seq: number, type: 'snapshot' | 'delta' = 'delta', data: unknown = {}) => ({ ch, type, seq, ts: new Date().toISOString(), data });

beforeEach(() => {
  FakeWS.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('backoff', () => {
  it('doubles from 1s up to 15s with 25 percent jitter', () => {
    expect(backoffMs(0, () => 0.5)).toBe(1000);
    expect(backoffMs(1, () => 0.5)).toBe(2000);
    expect(backoffMs(3, () => 0.5)).toBe(8000);
    expect(backoffMs(10, () => 0.5)).toBe(15000);
    expect(backoffMs(0, () => 0)).toBe(750);
    expect(backoffMs(0, () => 1)).toBe(1250);
  });
});

describe('LiveSocket', () => {
  it('subscribes once per channel (reference counted) and sends the subscribe on open', () => {
    const { s, states } = make();
    const off1 = s.subscribe('market:A');
    const off2 = s.subscribe('market:A');
    s.subscribe('me');
    const ws = FakeWS.all[0]!;
    ws.open();
    expect(states).toEqual(['connecting', 'open']);
    expect(ws.sent[0]).toEqual({ op: 'subscribe', channels: ['market:A', 'me'] });
    off1();
    expect(s.channels).toContain('market:A');
    off2();
    expect(s.channels).not.toContain('market:A');
    expect(ws.sent.at(-1)).toEqual({ op: 'unsubscribe', channels: ['market:A'] });
  });

  it('delivers messages, drops duplicates and out of order deltas', () => {
    const { s, got } = make();
    s.subscribe('market:A');
    const ws = FakeWS.all[0]!;
    ws.open();
    ws.push(m('market:A', 1, 'snapshot'));
    ws.push(m('market:A', 2));
    ws.push(m('market:A', 2));
    ws.push(m('market:A', 1));
    ws.push({ op: 'pong' });
    expect(got.map((x) => x.seq)).toEqual([1, 2]);
  });

  it('asks for a resync on a sequence gap', () => {
    const { s, resyncs } = make();
    s.subscribe('market:A');
    const ws = FakeWS.all[0]!;
    ws.open();
    ws.push(m('market:A', 1, 'snapshot'));
    ws.push(m('market:A', 5));
    expect(resyncs).toEqual([['market:A']]);
  });

  it('ignores junk frames', () => {
    const { s, got } = make();
    s.subscribe('me');
    const ws = FakeWS.all[0]!;
    ws.open();
    ws.onmessage?.({ data: 'not json' });
    ws.push({ nope: true });
    ws.push(null);
    expect(got).toHaveLength(0);
  });

  it('reconnects with backoff, re-subscribes everything and asks for a resync', () => {
    const { s, states, resyncs } = make();
    s.subscribe('market:A');
    s.subscribe('me');
    FakeWS.all[0]!.open();
    FakeWS.all[0]!.close(); // server drops us
    expect(states.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(1300);
    expect(FakeWS.all).toHaveLength(2);
    const ws2 = FakeWS.all[1]!;
    ws2.open();
    expect(ws2.sent[0]).toEqual({ op: 'subscribe', channels: ['market:A', 'me'] });
    expect(resyncs).toEqual([['market:A', 'me']]);
    expect(states.at(-1)).toBe('open');
  });

  it('closes the socket shortly after the last channel goes away', () => {
    const { s, states } = make();
    const off = s.subscribe('me');
    FakeWS.all[0]!.open();
    off();
    vi.advanceTimersByTime(150);
    expect(states.at(-1)).toBe('idle');
    expect(FakeWS.all[0]!.readyState).toBe(3);
  });

  it('terminates a connection that stops answering heartbeats', () => {
    const { s, states } = make();
    s.subscribe('me');
    const ws = FakeWS.all[0]!;
    ws.open();
    vi.advanceTimersByTime(1000);
    expect(ws.sent.some((x) => x.op === 'ping')).toBe(true);
    vi.advanceTimersByTime(600);
    expect(ws.readyState).toBe(3);
    expect(states.at(-1)).toBe('reconnecting');
  });

  it('close() stops reconnecting', () => {
    const { s } = make();
    s.subscribe('me');
    FakeWS.all[0]!.open();
    s.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.all).toHaveLength(1);
  });
});
