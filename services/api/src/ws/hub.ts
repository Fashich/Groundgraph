import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { CH, feeBpsNow, numericToBigInt, type Redis } from '@groundgraph/svc-core';
import type { MarketSummary, WsClientMsg, WsMarketDelta, WsServerMsg } from '@groundgraph/sdk/api-types';
import { Counter, Gauge } from 'prom-client';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import type { SessionCtx } from '../auth/session';
import { loadSettings, toUserSettings } from '../services/limits';
import { feeStateOf, getMarketRow, loadMarketRows, poolPrice, radarSummaries, summarize } from '../services/markets';
import { oracleInfo, readOracle } from '../services/oracle';
import type { AppContext } from '../context';

/**
 * WebSocket hub for `/ws` (also `/api/ws` behind a proxy that keeps the prefix).
 *
 * Protocol (see api-types.ts WsClientMsg / WsServerMsg):
 *  - client: {op:'subscribe', channels:[...]} | {op:'unsubscribe', channels:[...]} | {op:'ping'}
 *  - server: {ch, type:'snapshot'|'delta', seq, ts, data} | {op:'pong'} | {op:'error', message}
 *  - `seq` starts at 1 per connection and channel, snapshot included, and increments with every message. A reconnecting
 *    client simply subscribes again and gets a fresh snapshot (that is the resume mechanism).
 *  - channels: market:{id}, markets:summary (every 2.5 s, only changed markets), radar:{id}, oracle:{feedId}, me (cookie session).
 *  - backpressure: a client whose socket buffer exceeds WS_MAX_BUFFER_BYTES is terminated, never queued without bound.
 *  - heartbeat: protocol ping every 20 s, a client that did not pong by the next round is terminated.
 */

const HEARTBEAT_MS = 20_000;
const SUMMARY_MS = 2_500;
const RADAR_POLL_MS = 5_000;
const MAX_SUBS = 50;
const MAX_PAYLOAD = 16 * 1024;
const RATE_BURST = 40;
const RATE_PER_SEC = 20;
const SUMMARY_LIMIT = 100;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;

export type ParsedChannel =
  | { kind: 'market'; key: string }
  | { kind: 'radar'; key: string }
  | { kind: 'oracle'; key: string }
  | { kind: 'summary'; key: 'markets:summary' }
  | { kind: 'me'; key: 'me' };

/** Validate a client supplied channel name. Returns the canonical key used for routing, or null. */
export function parseChannel(ch: string): ParsedChannel | null {
  if (ch === 'markets:summary') return { kind: 'summary', key: 'markets:summary' };
  if (ch === 'me') return { kind: 'me', key: 'me' };
  const i = ch.indexOf(':');
  if (i < 0) return null;
  const kind = ch.slice(0, i);
  const id = ch.slice(i + 1);
  if ((kind === 'market' || kind === 'radar') && B58.test(id)) return { kind, key: ch };
  if (kind === 'oracle' && HEX64.test(id)) return { kind: 'oracle', key: `oracle:${id.replace(/^0x/, '').toLowerCase()}` };
  return null;
}

const clientMsgSchema: z.ZodType<WsClientMsg> = z.union([
  z.object({ op: z.literal('subscribe'), channels: z.array(z.string().max(120)).min(1).max(MAX_SUBS) }),
  z.object({ op: z.literal('unsubscribe'), channels: z.array(z.string().max(120)).min(1).max(MAX_SUBS) }),
  z.object({ op: z.literal('ping') }),
]);

interface Client {
  id: number;
  ws: WebSocket;
  ip: string;
  session: SessionCtx | null;
  subs: Map<string, { parsed: ParsedChannel; seq: number; name: string }>;
  alive: boolean;
  tokens: number;
  tokenAt: number;
  violations: number;
}

export interface WsHubOptions {
  /** resolves a raw Cookie header to a session (signature + DB check) */
  authenticate: (cookieHeader: string | undefined) => Promise<SessionCtx | null>;
  /** dedicated ioredis connection in subscriber mode */
  subscriber: Redis;
  /** override timers in tests */
  summaryMs?: number;
  radarPollMs?: number;
  heartbeatMs?: number;
}

const hashOf = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('base64');

export class WsHub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  private clients = new Set<Client>();
  private byChannel = new Map<string, Set<Client>>();
  private perIp = new Map<string, number>();
  private nextId = 1;
  private timers: NodeJS.Timeout[] = [];
  private summaryState = new Map<string, string>();
  private summaryBusy = false;
  private radarBusy = false;
  private radarSeen = new Map<string, string>();
  private server: Server | null = null;
  private onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void this.handleUpgrade(req, socket, head);
  private allowedOrigins: Set<string>;

  private gClients: Gauge;
  private cSent: Counter<'channel_kind'>;
  private cDropped: Counter<'reason'>;

  constructor(private ctx: AppContext, private opts: WsHubOptions) {
    this.allowedOrigins = new Set([new URL(ctx.cfg.WEB_ORIGIN).origin, new URL(ctx.cfg.PUBLIC_API_URL).origin]);
    const reg = ctx.registry;
    this.gClients = reg.getSingleMetric('gg_ws_clients') as Gauge ?? new Gauge({ name: 'gg_ws_clients', help: 'Connected WebSocket clients', registers: [reg] });
    this.cSent = reg.getSingleMetric('gg_ws_messages_sent_total') as Counter<'channel_kind'> ?? new Counter({ name: 'gg_ws_messages_sent_total', help: 'WebSocket messages sent', labelNames: ['channel_kind'], registers: [reg] });
    this.cDropped = reg.getSingleMetric('gg_ws_dropped_total') as Counter<'reason'> ?? new Counter({ name: 'gg_ws_dropped_total', help: 'WebSocket clients dropped', labelNames: ['reason'], registers: [reg] });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Attach to an http.Server (the Fastify server) and start fan-out and timers. */
  async start(server: Server): Promise<void> {
    this.server = server;
    server.on('upgrade', this.onUpgrade);
    const sub = this.opts.subscriber;
    sub.on('pmessage', (_pattern, channel, message) => this.onRedis(channel, message));
    await sub.psubscribe(`${CH.prefix}*`);
    this.timers.push(
      setInterval(() => void this.tickSummary(), this.opts.summaryMs ?? SUMMARY_MS),
      setInterval(() => void this.tickRadar(), this.opts.radarPollMs ?? RADAR_POLL_MS),
      setInterval(() => this.heartbeat(), this.opts.heartbeatMs ?? HEARTBEAT_MS),
    );
    for (const t of this.timers) t.unref();
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.server?.off('upgrade', this.onUpgrade);
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.byChannel.clear();
    await this.opts.subscriber.punsubscribe().catch(() => undefined);
    this.opts.subscriber.removeAllListeners('pmessage');
    this.wss.close();
  }

  /* ------------------------------ connection ------------------------------ */

  private reject(socket: Duplex, status: number, msg: string): void {
    socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws' && path !== '/api/ws') return; // not ours (leave to other upgrade listeners)
    socket.on('error', () => undefined);
    try {
      const origin = req.headers.origin;
      // browsers always send Origin: only the web app may open a cookie-authenticated socket
      if (origin && !this.allowedOrigins.has(origin)) return this.reject(socket, 403, 'Forbidden');
      const ip = this.clientIp(req);
      if ((this.perIp.get(ip) ?? 0) >= this.ctx.cfg.WS_MAX_CONNECTIONS_PER_IP) {
        this.cDropped.inc({ reason: 'ip_cap' });
        return this.reject(socket, 429, 'Too Many Requests');
      }
      const session = await this.opts.authenticate(req.headers.cookie).catch(() => null);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip, session));
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, 'ws upgrade failed');
      this.reject(socket, 500, 'Internal Server Error');
    }
  }

  private clientIp(req: IncomingMessage): string {
    if (this.ctx.cfg.TRUST_PROXY) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private onConnection(ws: WebSocket, ip: string, session: SessionCtx | null): void {
    const client: Client = { id: this.nextId++, ws, ip, session, subs: new Map(), alive: true, tokens: RATE_BURST, tokenAt: Date.now(), violations: 0 };
    this.clients.add(client);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    this.gClients.set(this.clients.size);
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (raw, isBinary) => void this.onMessage(client, raw as Buffer, isBinary));
    ws.on('close', () => this.drop(client));
    ws.on('error', () => this.drop(client));
  }

  private drop(c: Client): void {
    if (!this.clients.delete(c)) return;
    for (const sub of c.subs.values()) this.unindex(c, sub.parsed);
    c.subs.clear();
    const n = (this.perIp.get(c.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(c.ip);
    else this.perIp.set(c.ip, n);
    this.gClients.set(this.clients.size);
  }

  private kill(c: Client, reason: string): void {
    this.cDropped.inc({ reason });
    c.ws.terminate();
    this.drop(c);
  }

  /* ------------------------------ messages ------------------------------ */

  private rawSend(c: Client, msg: WsServerMsg, kind = 'control'): boolean {
    if (c.ws.readyState !== c.ws.OPEN) return false;
    if (c.ws.bufferedAmount > this.ctx.cfg.WS_MAX_BUFFER_BYTES) {
      this.kill(c, 'backpressure');
      return false;
    }
    c.ws.send(JSON.stringify(msg));
    this.cSent.inc({ channel_kind: kind });
    if (c.ws.bufferedAmount > this.ctx.cfg.WS_MAX_BUFFER_BYTES) {
      this.kill(c, 'backpressure');
      return false;
    }
    return true;
  }

  private sendData(c: Client, name: string, type: 'snapshot' | 'delta', data: unknown): void {
    const sub = c.subs.get(name);
    if (!sub) return;
    sub.seq += 1;
    this.rawSend(c, { ch: name, type, seq: sub.seq, ts: this.ctx.now().toISOString(), data }, sub.parsed.kind);
  }

  private async onMessage(c: Client, raw: Buffer, isBinary: boolean): Promise<void> {
    const now = Date.now();
    c.tokens = Math.min(RATE_BURST, c.tokens + ((now - c.tokenAt) / 1000) * RATE_PER_SEC);
    c.tokenAt = now;
    if (c.tokens < 1) {
      c.violations += 1;
      this.rawSend(c, { op: 'error', message: 'Too many messages, slow down' });
      if (c.violations >= 5) this.kill(c, 'rate_limit');
      return;
    }
    c.tokens -= 1;
    if (isBinary) return void this.rawSend(c, { op: 'error', message: 'Binary frames are not supported' });
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return void this.rawSend(c, { op: 'error', message: 'Invalid JSON' });
    }
    const parsed = clientMsgSchema.safeParse(json);
    if (!parsed.success) return void this.rawSend(c, { op: 'error', message: 'Unknown or malformed message' });
    const msg = parsed.data;
    if (msg.op === 'ping') return void this.rawSend(c, { op: 'pong' });
    if (msg.op === 'unsubscribe') {
      for (const name of msg.channels) {
        const sub = c.subs.get(name);
        if (sub) {
          this.unindex(c, sub.parsed);
          c.subs.delete(name);
        }
      }
      return;
    }
    for (const name of msg.channels) {
      const p = parseChannel(name);
      if (!p) {
        this.rawSend(c, { op: 'error', message: `Unknown channel ${name.slice(0, 60)}` });
        continue;
      }
      if (p.kind === 'me' && !c.session) {
        this.rawSend(c, { op: 'error', message: 'Channel me requires a signed-in session' });
        continue;
      }
      if (c.subs.has(name)) continue;
      if (c.subs.size >= MAX_SUBS) {
        this.rawSend(c, { op: 'error', message: `At most ${MAX_SUBS} channels per connection` });
        break;
      }
      c.subs.set(name, { parsed: p, seq: 0, name });
      this.index(c, p);
      try {
        const snap = await this.snapshot(c, p);
        if (snap === null) {
          this.unindex(c, p);
          c.subs.delete(name);
          this.rawSend(c, { op: 'error', message: `Nothing to subscribe to for ${name.slice(0, 60)}` });
          continue;
        }
        this.sendData(c, name, 'snapshot', snap);
      } catch (err) {
        this.ctx.log.warn({ err: (err as Error).message, name }, 'ws snapshot failed');
        this.unindex(c, p);
        c.subs.delete(name);
        this.rawSend(c, { op: 'error', message: `Could not load ${name.slice(0, 60)}, try again` });
      }
    }
  }

  /* ------------------------------ routing index ------------------------------ */

  private routeKey(c: Client, p: ParsedChannel): string {
    return p.kind === 'me' ? `me:${c.session!.wallet}` : p.key;
  }
  private index(c: Client, p: ParsedChannel): void {
    const k = this.routeKey(c, p);
    let s = this.byChannel.get(k);
    if (!s) this.byChannel.set(k, (s = new Set()));
    s.add(c);
  }
  private unindex(c: Client, p: ParsedChannel): void {
    const k = this.routeKey(c, p);
    const s = this.byChannel.get(k);
    if (!s) return;
    s.delete(c);
    if (s.size === 0) this.byChannel.delete(k);
  }

  private nameFor(c: Client, key: string): string | null {
    for (const sub of c.subs.values()) if (this.routeKey(c, sub.parsed) === key) return sub.name;
    return null;
  }

  /** deliver a payload to every local client routed to `key` */
  private deliver(key: string, type: 'snapshot' | 'delta', data: unknown): void {
    const set = this.byChannel.get(key);
    if (!set) return;
    for (const c of [...set]) {
      const name = this.nameFor(c, key);
      if (name) this.sendData(c, name, type, data);
    }
  }

  /* ------------------------------ snapshots ------------------------------ */

  private async snapshot(c: Client, p: ParsedChannel): Promise<unknown | null> {
    const ctx = this.ctx;
    switch (p.kind) {
      case 'market': {
        const row = await getMarketRow(ctx, p.key.slice('market:'.length));
        if (!row) return null;
        return this.marketState(row);
      }
      case 'summary': {
        const items = await this.summaries();
        // seed the diff state so changes between this snapshot and the next tick are pushed as deltas
        if (this.summaryState.size === 0) for (const m of items) this.summaryState.set(m.id, hashOf(m));
        return { markets: items };
      }
      case 'radar': {
        const id = p.key.slice('radar:'.length);
        const r = (await radarSummaries(ctx, [id])).get(id) ?? null;
        if (r && !this.radarSeen.has(id)) this.radarSeen.set(id, hashOf(r));
        return r;
      }
      case 'oracle': {
        const feed = p.key.slice('oracle:'.length);
        return oracleInfo(ctx, feed, await readOracle(ctx, feed), ctx.now().getTime());
      }
      case 'me': {
        const s = c.session!;
        return { wallet: s.wallet, mode: s.mode, settings: s.mode === 'sign' ? toUserSettings(await loadSettings(ctx, s.wallet), ctx.now()) : null };
      }
    }
  }

  private marketState(row: Awaited<ReturnType<typeof getMarketRow>> & object): WsMarketDelta {
    return {
      priceAbove: poolPrice(row.reserveAbove, row.reserveBelow),
      reserveAbove: numericToBigInt(row.reserveAbove).toString(),
      reserveBelow: numericToBigInt(row.reserveBelow).toString(),
      feeBps: feeBpsNow(feeStateOf(row), Math.floor(this.ctx.now().getTime() / 1000)).totalBps,
    };
  }

  private async summaries(): Promise<MarketSummary[]> {
    const rows = await loadMarketRows(this.ctx, { status: 'active', limit: SUMMARY_LIMIT, offset: 0 });
    return summarize(this.ctx, rows.slice(0, SUMMARY_LIMIT));
  }

  /* ------------------------------ redis fan-out ------------------------------ */

  private onRedis(channel: string, message: string): void {
    if (!channel.startsWith(CH.prefix)) return;
    const key = channel.slice(CH.prefix.length);
    if (!this.byChannel.has(key)) return;
    let payload: { type?: string; data?: unknown };
    try {
      payload = JSON.parse(message) as { type?: string; data?: unknown };
    } catch {
      return;
    }
    if (payload.data === undefined) return;
    const type = payload.type === 'snapshot' ? 'snapshot' : 'delta';
    let data = payload.data;
    if (key.startsWith('oracle:') && data && typeof data === 'object' && 'publishTs' in data && typeof (data as { publishTs: unknown }).publishTs === 'number') {
      // the keeper publishes the raw reading; clients get the OracleInfo contract shape
      data = oracleInfo(this.ctx, key.slice('oracle:'.length), data as never, this.ctx.now().getTime());
    }
    this.deliver(key, type, data);
  }

  /* ------------------------------ timers ------------------------------ */

  /** markets:summary ticker: one computation shared by all subscribers, only changed markets are pushed. */
  private async tickSummary(): Promise<void> {
    const set = this.byChannel.get('markets:summary');
    if (!set || set.size === 0 || this.summaryBusy) {
      if (!set || set.size === 0) this.summaryState.clear();
      return;
    }
    this.summaryBusy = true;
    try {
      const items = await this.summaries();
      const changed: MarketSummary[] = [];
      const next = new Map<string, string>();
      for (const m of items) {
        const h = hashOf(m);
        next.set(m.id, h);
        if (this.summaryState.get(m.id) !== h) changed.push(m);
      }
      const known = this.summaryState.size > 0;
      this.summaryState = next;
      if (changed.length > 0 && known) this.deliver('markets:summary', 'delta', { markets: changed });
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, 'summary tick failed');
    } finally {
      this.summaryBusy = false;
    }
  }

  /** radar:{id}: the scorer writes market_radar rows; poll the latest timestamp per watched market. */
  private async tickRadar(): Promise<void> {
    if (this.radarBusy) return;
    const ids = [...this.byChannel.keys()].filter((k) => k.startsWith('radar:')).map((k) => k.slice('radar:'.length));
    if (ids.length === 0) {
      this.radarSeen.clear();
      return;
    }
    this.radarBusy = true;
    try {
      const radar = await radarSummaries(this.ctx, ids);
      for (const id of ids) {
        const r = radar.get(id);
        if (!r) continue;
        const h = hashOf(r);
        const prev = this.radarSeen.get(id);
        this.radarSeen.set(id, h);
        if (prev !== undefined && prev !== h) this.deliver(`radar:${id}`, 'delta', r);
      }
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message }, 'radar tick failed');
    } finally {
      this.radarBusy = false;
    }
  }

  private heartbeat(): void {
    for (const c of [...this.clients]) {
      if (!c.alive) {
        this.kill(c, 'heartbeat');
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        this.kill(c, 'heartbeat');
      }
    }
  }
}
