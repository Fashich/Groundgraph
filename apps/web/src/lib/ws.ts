import type { WsClientMsg } from '@groundgraph/sdk/api-types';
import type { WsState } from './stores';

export interface ChannelMsg {
  ch: string;
  type: 'snapshot' | 'delta';
  seq: number;
  ts: string;
  data: unknown;
}

export interface LiveSocketOptions {
  url: () => string;
  onMessage: (m: ChannelMsg) => void;
  onState: (s: WsState) => void;
  /** Age of the newest server message in ms (from its ts). */
  onLag: (ms: number) => void;
  /** Called when a sequence gap or a reconnect means cached data for these channels may be stale. */
  onResync: (channels: string[]) => void;
  /** Injected for tests. */
  WebSocketImpl?: typeof WebSocket;
  pingEveryMs?: number;
  pongTimeoutMs?: number;
  idleCloseMs?: number;
}

/** Reconnect delay with exponential backoff and jitter: 1s, 2s, 4s ... capped at 15s. */
export function backoffMs(attempt: number, rand = Math.random): number {
  const base = Math.min(15000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + rand() * 0.5));
}

/**
 * WebSocket client with reference-counted channels, heartbeat, reconnect with backoff and resume.
 * Resume strategy: after any reconnect it re-subscribes every active channel, asks the app to refetch their
 * cached data (`onResync`), and treats a `seq` gap on a channel the same way.
 */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private refs = new Map<string, number>();
  private lastSeq = new Map<string, number>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private wantOpen = false;
  private everOpened = false;
  private opts: Required<Pick<LiveSocketOptions, 'pingEveryMs' | 'pongTimeoutMs' | 'idleCloseMs'>> & LiveSocketOptions;

  constructor(opts: LiveSocketOptions) {
    this.opts = { pingEveryMs: 15000, pongTimeoutMs: 10000, idleCloseMs: 4000, ...opts };
  }

  get channels(): string[] {
    return [...this.refs.keys()];
  }

  subscribe(channel: string): () => void {
    const n = this.refs.get(channel) ?? 0;
    this.refs.set(channel, n + 1);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (n === 0) this.send({ op: 'subscribe', channels: [channel] });
    this.ensureOpen();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const c = (this.refs.get(channel) ?? 1) - 1;
      if (c <= 0) {
        this.refs.delete(channel);
        this.lastSeq.delete(channel);
        this.send({ op: 'unsubscribe', channels: [channel] });
        if (this.refs.size === 0) this.scheduleIdleClose();
      } else this.refs.set(channel, c);
    };
  }

  /** Drop the current socket (if any) and open a fresh one immediately, keeping all subscriptions. */
  reconnectNow() {
    this.attempt = 0;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.wantOpen = this.refs.size > 0;
    if (this.wantOpen) this.open();
  }

  close() {
    this.wantOpen = false;
    this.clearTimers();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.opts.onState('idle');
  }

  private scheduleIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.refs.size === 0) this.close();
    }, this.opts.idleCloseMs);
  }

  private ensureOpen() {
    this.wantOpen = true;
    if (this.ws || this.reconnectTimer) return;
    this.open();
  }

  private open() {
    const Impl = this.opts.WebSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    const url = this.opts.url();
    if (!Impl || !url) return;
    this.opts.onState(this.everOpened ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new Impl(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const resumed = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.opts.onState('open');
      const channels = this.channels;
      if (channels.length) this.rawSend({ op: 'subscribe', channels });
      if (resumed && channels.length) {
        this.lastSeq.clear();
        this.opts.onResync(channels);
      }
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      this.heard();
      let m: unknown;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(m);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.wantOpen && this.refs.size > 0) {
        this.opts.onState('reconnecting');
        this.scheduleReconnect();
      } else this.opts.onState('idle');
    };
  }

  private handle(m: unknown) {
    if (!m || typeof m !== 'object') return;
    const o = m as Record<string, unknown>;
    if (o.op === 'pong' || o.op === 'error') return;
    if (typeof o.ch !== 'string') return;
    const msg = o as unknown as ChannelMsg;
    const t = Date.parse(msg.ts);
    if (Number.isFinite(t)) this.opts.onLag(Math.max(0, Date.now() - t));
    if (msg.type === 'snapshot') this.lastSeq.set(msg.ch, msg.seq);
    else if (typeof msg.seq === 'number') {
      const prev = this.lastSeq.get(msg.ch);
      if (prev !== undefined && msg.seq > prev + 1) this.opts.onResync([msg.ch]);
      if (prev === undefined || msg.seq > prev) this.lastSeq.set(msg.ch, msg.seq);
      else return; // duplicate or out of order
    }
    this.opts.onMessage(msg);
  }

  private send(m: WsClientMsg) {
    if (this.ws && this.ws.readyState === 1) this.rawSend(m);
  }

  private rawSend(m: WsClientMsg) {
    try {
      this.ws?.send(JSON.stringify(m));
    } catch {
      /* closed */
    }
  }

  private startHeartbeat() {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      this.send({ op: 'ping' });
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        // no traffic at all after the ping: the connection is dead
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
      }, this.opts.pongTimeoutMs);
    }, this.opts.pingEveryMs);
  }

  private heard() {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.pongTimer = this.reconnectTimer = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const d = backoffMs(this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantOpen && this.refs.size > 0) this.open();
    }, d);
  }
}
