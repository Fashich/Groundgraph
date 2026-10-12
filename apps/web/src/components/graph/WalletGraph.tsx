'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GraphNode, GraphPayload } from '@groundgraph/sdk/api-types';
import { cn } from '@groundgraph/ui';
import { graphLimit, pickNodes, type GraphMode } from '@/lib/graph';
import { shortAddr } from '@/lib/format';

export type GraphState = 'idle' | 'loading' | 'hover' | 'selected' | 'empty';

export interface WalletGraphProps {
  data: GraphPayload | null | undefined;
  mode: GraphMode;
  lite?: boolean;
  state?: GraphState;
  /** Selected wallet address. */
  selected?: string | null;
  /** Market the mini graph belongs to, and the wallet addresses positioned in it. */
  market?: string | null;
  members?: string[] | null;
  minScore?: number;
  /** 'all' or a cluster id. */
  cluster?: string;
  showCrowd?: boolean;
  align?: 'right' | 'center';
  onSelect?: (addr: string | null) => void;
  /** Custom tooltip body. The default shows address, score, cluster and verdict. */
  renderTip?: (node: GraphNode, clusterName: string) => ReactNode;
  decorative?: boolean;
  label?: string;
  className?: string;
}

interface SpriteSet {
  c: HTMLCanvasElement;
  m: HTMLCanvasElement;
  v: HTMLCanvasElement;
}
let SPR: SpriteSet | null = null;
function sprite(rgb: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, `rgba(${rgb},0.95)`);
  g.addColorStop(0.22, `rgba(${rgb},0.45)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return c;
}
const sprites = (): SpriteSet => (SPR ??= { c: sprite('44,230,214'), m: sprite('224,70,240'), v: sprite('155,107,255') });

interface GNode {
  n: GraphNode;
  inM: boolean;
}
interface Proj {
  x: number;
  y: number;
  z: number;
  k: number;
  e: number;
  on: boolean;
  pass: boolean;
  r: number;
}
interface Packet {
  e: { a: number; b: number; flag: boolean };
  t: number;
  s: number;
  fl: { a: number; b: number; flag: boolean }[];
}

/** Canvas 2D wallet graph. Port of the design's gg-graph web component, fed by the API graph payload. */
export function WalletGraph(props: WalletGraphProps) {
  const { data, mode, lite = false, state = 'idle', selected = null, market = null, members = null, minScore = 0, cluster = 'all', showCrowd = true, align = 'right', onSelect, renderTip, decorative, label, className } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const [tipIdx, setTipIdx] = useState<number>(-1);

  // Latest props for the animation loop (no restart on filter changes).
  const cfg = useRef({ mode, lite, state, selected, minScore, cluster, showCrowd, align, onSelect });
  cfg.current = { mode, lite, state, selected, minScore, cluster, showCrowd, align, onSelect };

  const memberKey = members ? members.join(',') : '';
  const built = useMemo(() => {
    const payload = data;
    if (!payload || payload.nodes.length === 0) return null;
    const mem = members && members.length ? new Set(members) : null;
    const limit = graphLimit(mode, lite);
    const idx = pickNodes(payload.nodes, limit, market ? mem : null);
    const map = new Map<number, number>();
    const nodes: GNode[] = idx.map((g, k) => {
      const n = payload.nodes[g]!;
      map.set(n.id, k);
      return { n, inM: market && mem ? mem.has(n.addr) : true };
    });
    const edges: { a: number; b: number; flag: boolean }[] = [];
    const adj: number[][] = nodes.map(() => []);
    for (const e of payload.edges) {
      const A = map.get(e.a);
      const B = map.get(e.b);
      if (A == null || B == null) continue;
      edges.push({ a: A, b: B, flag: e.flag });
      adj[A]!.push(B);
      adj[B]!.push(A);
    }
    const names = new Map(payload.clusters.map((c) => [c.id, c.name] as const));
    return { nodes, edges, adj, names };
    // memberKey stands in for the members array identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, mode, lite, market, memberKey]);

  const sig = built ? `${built.nodes.length}:${built.nodes[0]?.n.addr}:${built.nodes[built.nodes.length - 1]?.n.addr}:${mode}:${lite}` : 'none';

  useEffect(() => {
    const canvas = cv.current;
    const host = wrap.current;
    if (!canvas || !host || !built) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { nodes, edges, adj } = built;
    const SP = sprites();
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    const fl = edges.filter((e) => e.flag);
    const np = lite ? 4 : mode === 'mini' ? 8 : 26;
    const packets: Packet[] = [];
    for (let q = 0; q < np && fl.length; q++) packets.push({ e: fl[Math.floor(Math.random() * fl.length)]!, t: Math.random(), s: 0.0002 + Math.random() * 0.0004, fl });
    let demo = nodes.findIndex((n) => n.n.top);
    if (demo < 0) demo = 0;

    const S = { ay: 0.6, ax: -0.22, zoom: 1, mx: 0, my: 0, smx: 0, smy: 0, sy: 0, hover: -1, vis: true, run: true, last: 0, prev: performance.now(), t0: performance.now(), W: 1, H: 1, dpr: 1, tip: -1 };
    let P: Proj[] = [];
    let down: { x: number; y: number; ay: number; ax: number; moved: boolean } | null = null;

    const resize = () => {
      const b = host.getBoundingClientRect();
      S.W = Math.max(1, b.width);
      S.H = Math.max(1, b.height);
      S.dpr = Math.min(window.devicePixelRatio || 1, lite ? 1.5 : 2);
      canvas.width = Math.round(S.W * S.dpr);
      canvas.height = Math.round(S.H * S.dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    const io = new IntersectionObserver((e) => {
      S.vis = !!e[0]?.isIntersecting;
    });
    io.observe(host);

    const pointer = (x: number, y: number, e: PointerEvent) => {
      if (down && mode === 'explorer') {
        const dx = e.clientX - down.x;
        const dy = e.clientY - down.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) down.moved = true;
        if (down.moved) {
          S.ay = down.ay + dx * 0.006;
          S.ax = Math.max(-1.2, Math.min(1.2, down.ax + dy * 0.004));
          S.hover = -1;
          host.style.cursor = 'grabbing';
          return;
        }
      }
      let best = -1;
      let bd = 1e9;
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        if (!p || !p.on) continue;
        const dd = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
        const th = Math.max(12, p.r + 8);
        if (dd < th * th && dd < bd) {
          bd = dd;
          best = i;
        }
      }
      S.hover = best;
      host.style.cursor = best >= 0 ? 'pointer' : mode === 'explorer' ? 'grab' : 'default';
    };
    const rel = (e: PointerEvent) => {
      const b = host.getBoundingClientRect();
      return [e.clientX - b.left, e.clientY - b.top] as const;
    };
    const onMove = (e: PointerEvent) => {
      const [x, y] = rel(e);
      pointer(x, y, e);
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, ay: S.ay, ax: S.ax, moved: false };
      if (mode === 'explorer') {
        try {
          host.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      const [x, y] = rel(e);
      pointer(x, y, e);
    };
    const onUp = () => {
      const d = down;
      down = null;
      if (!d || d.moved) return;
      const n = nodes[S.hover];
      cfg.current.onSelect?.(n ? n.n.addr : null);
    };
    const onLeave = () => {
      if (!down) S.hover = -1;
    };
    const onWheel = (e: WheelEvent) => {
      if (mode !== 'explorer') return;
      e.preventDefault();
      S.zoom = Math.max(0.6, Math.min(2.4, S.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    };
    const onWinMove = (e: MouseEvent) => {
      S.mx = (e.clientX / innerWidth) * 2 - 1;
      S.my = (e.clientY / innerHeight) * 2 - 1;
    };
    const onScroll = () => {
      S.sy = window.scrollY || 0;
    };
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('wheel', onWheel, { passive: false });
    const parallax = mode === 'hero' && !lite && !reduce;
    if (parallax) {
      window.addEventListener('mousemove', onWinMove);
      window.addEventListener('scroll', onScroll, { passive: true });
    }

    let raf = 0;
    const frame = (now: number) => {
      if (!S.run) return;
      raf = requestAnimationFrame(frame);
      const c = cfg.current;
      if (!S.vis || document.hidden) {
        S.prev = now;
        return;
      }
      if (lite && now - S.last < 33) return;
      S.last = now;
      const dt = Math.min(64, now - S.prev);
      S.prev = now;
      const { W, H, dpr } = S;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const st = c.state || 'idle';
      const spin = reduce ? 0 : mode === 'explorer' ? 0.00005 : lite ? 0.00003 : 0.00006;
      if (!down) S.ay += dt * spin;
      S.smx += (S.mx - S.smx) * 0.05;
      S.smy += (S.my - S.smy) * 0.05;
      const par = mode === 'hero' && !lite;
      const a = S.ay + (par ? S.smx * 0.35 + S.sy * 0.0009 : 0);
      const b = S.ax + (par ? S.smy * 0.18 : 0);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      const center = mode === 'hero' && c.align !== 'center' && W > 900;
      const ox = center ? W * 0.68 : W * 0.5;
      let oy = mode === 'hero' && W <= 900 ? H * 0.36 : H * 0.5;
      oy -= par ? S.sy * 0.15 : 0;
      const base = mode === 'hero' ? (W > 900 ? Math.min(W * 0.42, H * 0.62) : Math.min(W * 0.62, H * 0.42)) : Math.min(W, H) * 0.42;
      const focal = base * 3.4 * S.zoom;
      const Dz = 3.4;
      const N = nodes.length;
      const el = now - S.t0;
      const PP: Proj[] = (P = new Array(N));
      const loading = st === 'loading';
      const empty = st === 'empty';
      let focus = S.hover;
      if (st === 'hover' && focus < 0) focus = demo;
      let selK = -1;
      if (c.selected) selK = nodes.findIndex((n) => n.n.addr === c.selected);
      if (st === 'selected' && selK < 0) selK = demo;
      let fset: Record<number, 1> | null = null;
      const fk = focus >= 0 ? focus : selK;
      if (fk >= 0) {
        fset = { [fk]: 1 };
        for (const x of adj[fk]!) fset[x] = 1;
      }
      for (let i = 0; i < N; i++) {
        const nd = nodes[i]!;
        const w = nd.n;
        const e = reduce ? 1 : Math.max(0, Math.min(1, (el - (i / N) * (lite ? 450 : 900)) / 700));
        const ez = 1 - Math.pow(1 - e, 3);
        const s = 0.25 + 0.75 * ez;
        const wob = lite || reduce ? 0 : Math.sin(now * 0.0006 + i) * 0.012;
        const x = w.pos[0] * s + wob;
        const y = w.pos[1] * s - wob;
        const z = w.pos[2] * s;
        const x1 = x * ca - z * sa;
        const z1 = x * sa + z * ca;
        const y1 = y * cb - z1 * sb;
        const z2 = y * sb + z1 * cb;
        const k = focal / (Dz + z2 * 1.2) / (focal / Dz);
        const pass = !empty && w.score >= c.minScore && (c.cluster === 'all' || String(w.cluster) === c.cluster) && (c.showCrowd !== false || w.smart) && nd.inM;
        PP[i] = { x: ox + (x1 * focal) / (Dz + z2 * 1.2), y: oy + (y1 * focal) / (Dz + z2 * 1.2), z: z2, k, e: ez, on: pass && !loading && ez > 0.5, pass, r: 0 };
      }

      if (!loading) {
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.strokeStyle = `rgba(150,120,255,${empty ? 0.05 : fset ? 0.05 : 0.11})`;
        const fe: typeof edges = [];
        for (const E of edges) {
          const A = PP[E.a]!;
          const B = PP[E.b]!;
          if (A.e < 0.3 || B.e < 0.3) continue;
          if (fset && (E.a === fk || E.b === fk)) {
            fe.push(E);
            continue;
          }
          if (E.flag && A.pass && B.pass) continue;
          ctx.moveTo(A.x, A.y);
          ctx.lineTo(B.x, B.y);
        }
        ctx.stroke();
        if (!empty) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(44,230,214,${fset ? 0.08 : 0.24})`;
          for (const E of edges) {
            const A = PP[E.a]!;
            const B = PP[E.b]!;
            if (!E.flag || !A.pass || !B.pass || A.e < 0.3 || B.e < 0.3) continue;
            if (fset && (E.a === fk || E.b === fk)) continue;
            ctx.moveTo(A.x, A.y);
            ctx.lineTo(B.x, B.y);
          }
          ctx.stroke();
        }
        ctx.lineWidth = 1.6;
        for (const E of fe) {
          const A = PP[E.a]!;
          const B = PP[E.b]!;
          const g = ctx.createLinearGradient(A.x, A.y, B.x, B.y);
          g.addColorStop(0, 'rgba(44,230,214,0.95)');
          g.addColorStop(1, 'rgba(224,70,240,0.85)');
          ctx.strokeStyle = g;
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.lineTo(B.x, B.y);
          ctx.stroke();
        }
        if (!empty && !reduce) {
          for (const pk of packets) {
            pk.t += pk.s * dt;
            if (pk.t >= 1) {
              pk.t = 0;
              pk.e = pk.fl[Math.floor(Math.random() * pk.fl.length)]!;
            }
            const A = PP[pk.e.a]!;
            const B = PP[pk.e.b]!;
            if (!A.pass || !B.pass || A.e < 1) continue;
            const px = A.x + (B.x - A.x) * pk.t;
            const py = A.y + (B.y - A.y) * pk.t;
            ctx.globalAlpha = fset ? 0.3 : 0.9;
            ctx.drawImage(SP.c, px - 7, py - 7, 14, 14);
            ctx.globalAlpha = 1;
          }
        }
      }

      const order = PP.map((_, i) => i).sort((u, v) => PP[v]!.z - PP[u]!.z);
      for (const i of order) {
        const p = PP[i]!;
        const w = nodes[i]!.n;
        if (p.e <= 0) continue;
        const depth = Math.max(0.35, Math.min(1, 1 - p.z * 0.35));
        const dim = fset && !fset[i] ? 0.22 : 1;
        const alpha = p.e * depth * dim;
        if (loading) {
          const sh = 0.25 + 0.25 * Math.sin(now * 0.004 - i * 0.25);
          ctx.fillStyle = `rgba(155,107,255,${sh})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2 * p.k, 0, 6.283);
          ctx.fill();
          continue;
        }
        if (!p.pass) {
          ctx.fillStyle = `rgba(120,110,150,${0.22 * alpha})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.6 * p.k, 0, 6.283);
          ctx.fill();
          p.r = 2;
          continue;
        }
        if (w.smart) {
          const pulse = reduce ? 1 : 1 + 0.18 * Math.sin(now * 0.003 + i * 1.7);
          const rad = (2.6 + (w.score - 70) * 0.07) * p.k * (lite ? 1.1 : 1);
          p.r = rad;
          const gs = rad * (lite ? 5 : 7) * pulse;
          ctx.globalAlpha = alpha * (lite ? 0.7 : 0.9);
          ctx.drawImage(w.top ? SP.m : SP.c, p.x - gs / 2, p.y - gs / 2, gs, gs);
          ctx.globalAlpha = 1;
          ctx.fillStyle = w.top ? `rgba(252,214,255,${alpha})` : `rgba(222,255,252,${alpha})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rad, 0, 6.283);
          ctx.fill();
        } else {
          p.r = 2.1 * p.k;
          ctx.fillStyle = `rgba(150,125,232,${0.75 * alpha})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, 6.283);
          ctx.fill();
        }
      }

      if (selK >= 0 && PP[selK] && PP[selK]!.pass) {
        const p = PP[selK]!;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 4]);
        ctx.lineDashOffset = -now * 0.02;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 9, 0, 6.283);
        ctx.stroke();
        ctx.restore();
        ctx.font = '500 11px "JetBrains Mono",monospace';
        ctx.fillStyle = 'rgba(237,235,245,0.95)';
        ctx.fillText(shortAddr(nodes[selK]!.n.addr), p.x + p.r + 14, p.y + 4);
      }
      if (focus >= 0 && PP[focus] && PP[focus]!.pass) {
        const p = PP[focus]!;
        ctx.strokeStyle = 'rgba(44,230,214,0.95)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 5, 0, 6.283);
        ctx.stroke();
      }
      if (loading || empty) {
        ctx.font = '500 12px "JetBrains Mono",monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(200,195,220,0.9)';
        ctx.fillText(loading ? 'Loading wallet graph' : 'No wallets match these filters', W / 2, H - 22);
        ctx.textAlign = 'start';
      }

      // tooltip: React state only changes when the hovered node changes, position is written imperatively
      const tk = focus >= 0 && PP[focus] && PP[focus]!.on ? focus : -1;
      if (tk !== S.tip) {
        S.tip = tk;
        setTipIdx(tk);
      }
      const t = tipEl.current;
      if (t && tk >= 0) {
        const p = PP[tk]!;
        let x = p.x + 16;
        let y = p.y - 20;
        if (x + 250 > W) x = p.x - 266;
        if (y + 130 > H) y = H - 134;
        if (y < 8) y = 8;
        t.style.transform = `translate(${Math.round(Math.max(4, x))}px,${Math.round(y)}px)`;
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      S.run = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onWinMove);
      window.removeEventListener('scroll', onScroll);
      setTipIdx(-1);
    };
    // The loop restarts only when the drawn set changes; filters are read from cfg.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, built]);

  const tipNode = built && tipIdx >= 0 ? built.nodes[tipIdx]?.n : undefined;
  const clusterName = tipNode ? (built?.names.get(tipNode.cluster) ?? `Cluster ${tipNode.cluster}`) : '';
  const col = tipNode ? (tipNode.smart ? (tipNode.top ? '#E046F0' : '#2CE6D6') : '#9A95AE') : '#9A95AE';

  return (
    <div
      ref={wrap}
      data-component="WalletGraph"
      data-mode={mode}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : (label ?? 'Wallet graph. Wallets are nodes and transfers are edges. Use the wallet list to read each score.')}
      className={cn('relative block h-full w-full overflow-hidden', className)}
      style={{ touchAction: mode === 'explorer' ? 'none' : 'pan-y' }}
    >
      <canvas ref={cv} className="absolute inset-0 block h-full w-full" />
      <div
        ref={tipEl}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 z-[2] min-w-[200px] max-w-[250px] rounded-xl border border-violet/30 bg-[rgba(14,11,24,0.88)] px-3.5 py-3 text-xs leading-[1.45] shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-opacity duration-[180ms]"
        style={{ opacity: tipNode ? 1 : 0 }}
      >
        {tipNode ? (
          renderTip ? (
            renderTip(tipNode, clusterName)
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[11px] font-medium text-muted">{shortAddr(tipNode.addr)}</span>
                <span className="font-display text-lg font-semibold" style={{ color: col }}>
                  {tipNode.score}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-dim">
                {clusterName} · {tipNode.smart ? 'Flagged smart money' : 'Crowd wallet'}
              </div>
              <div className="mt-2 text-[11px] text-violet">Click for full breakdown →</div>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}
