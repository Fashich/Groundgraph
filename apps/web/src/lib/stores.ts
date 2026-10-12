'use client';

import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'error';
export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

/** What the mandatory legal modal is being shown for. */
export type LegalIntent = { reason: 'connect'; walletName: string; address: string } | { reason: 'refresh' };

export type ConnPhase = 'idle' | 'connecting' | 'legal' | 'signing' | 'error';
export interface ConnState {
  phase: ConnPhase;
  walletName: string | null;
  address: string | null;
  error: string | null;
}

interface UiState {
  walletModal: boolean;
  /** Path to open after a successful connection (set by the route gate). */
  next: string | null;
  legal: LegalIntent | null;
  conn: ConnState;
  toasts: Toast[];
  openWallet: (next?: string | null) => void;
  closeWallet: () => void;
  openLegal: (intent: LegalIntent) => void;
  closeLegal: () => void;
  setConn: (c: Partial<ConnState>) => void;
  resetConn: () => void;
  toast: (t: Omit<Toast, 'id'>) => number;
  dismissToast: (id: number) => void;
}

const IDLE: ConnState = { phase: 'idle', walletName: null, address: null, error: null };
let toastSeq = 1;

export const useUi = create<UiState>((set, get) => ({
  walletModal: false,
  next: null,
  legal: null,
  conn: IDLE,
  toasts: [],
  openWallet: (next) => set({ walletModal: true, next: next === undefined ? get().next : next }),
  closeWallet: () => set({ walletModal: false }),
  openLegal: (intent) => set({ legal: intent }),
  closeLegal: () => set({ legal: null }),
  setConn: (c) => set({ conn: { ...get().conn, ...c } }),
  resetConn: () => set({ conn: IDLE }),
  toast: (t) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    if (typeof window !== 'undefined') window.setTimeout(() => get().dismissToast(id), t.tone === 'error' ? 7000 : 4500);
    return id;
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
}));

export type WsState = 'idle' | 'connecting' | 'open' | 'reconnecting';

interface NetState {
  ws: WsState;
  /** Age in ms of the newest server message, from its `ts`. */
  lagMs: number;
  /** When the socket last stopped being open (ms epoch), null while open. */
  downSince: number | null;
  rpcSlow: boolean;
  setWs: (s: WsState) => void;
  setLag: (ms: number) => void;
  setRpcSlow: (v: boolean) => void;
}

export const useNet = create<NetState>((set, get) => ({
  ws: 'idle',
  lagMs: 0,
  downSince: null,
  rpcSlow: false,
  setWs: (s) => {
    const prev = get();
    if (s === 'open') set({ ws: s, downSince: null });
    else set({ ws: s, downSince: prev.downSince ?? Date.now() });
  },
  setLag: (ms) => set({ lagMs: ms }),
  setRpcSlow: (v) => set({ rpcSlow: v }),
}));

/** Pure helper so the banner logic is unit-testable. */
export function networkProblem(n: { ws: WsState; lagMs: number; downSince: number | null }, now: number): null | { kind: 'lag' | 'down'; seconds: number } {
  if (n.ws === 'open' && n.lagMs > 5000) return { kind: 'lag', seconds: Math.round(n.lagMs / 1000) };
  if ((n.ws === 'reconnecting' || n.ws === 'connecting') && n.downSince && now - n.downSince > 5000) return { kind: 'down', seconds: Math.round((now - n.downSince) / 1000) };
  return null;
}
