'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState, type WalletName } from '@solana/wallet-adapter-base';
import type { SessionResp } from '@groundgraph/sdk/api-types';
import { api, isApiError } from '@/lib/api';
import { env } from '@/lib/env';
import { qk, useSession } from '@/lib/queries';
import { addrMessage, addrStatus } from '@/lib/addr';
import { shortAddr } from '@/lib/format';
import { signInWithWallet, type SigningWallet } from '@/lib/siws';
import { useUi } from '@/lib/stores';

export const WALLET_INSTALL = [
  { name: 'Phantom', url: 'https://phantom.app/download', mono: 'P', bg: '#AB9FF2' },
  { name: 'Solflare', url: 'https://solflare.com/download', mono: 'S', bg: '#FC9B22' },
  { name: 'Backpack', url: 'https://backpack.app/downloads', mono: 'B', bg: '#E33E3F' },
] as const;

function friendly(e: unknown): string {
  const msg = String((e as { message?: string })?.message ?? e ?? '');
  if (/reject|denied|declin|cancel|closed/i.test(msg)) return 'The request was rejected in your wallet. Nothing was signed.';
  if (/not ready|not installed/i.test(msg)) return 'That wallet is not available in this browser.';
  if (isApiError(e)) return e.message;
  return msg || 'Something went wrong. Please try again.';
}

async function until<T>(get: () => T | null | undefined, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 60));
  }
}

/** All connect, sign-in, view-only and disconnect actions. State lives in the zustand ui store and TanStack Query. */
export function useWalletFlow() {
  const w = useWallet();
  const qc = useQueryClient();
  const router = useRouter();
  const session = useSession().data ?? null;

  const adapterFor = useCallback((name: string) => w.wallets.find((x) => x.adapter.name === name), [w.wallets]);

  const afterSession = useCallback(
    (s: SessionResp, opts: { toast?: string; goNext?: boolean } = { goNext: true }) => {
      qc.setQueryData(qk.session, s);
      void qc.invalidateQueries({ queryKey: qk.me });
      void qc.invalidateQueries({ queryKey: ['positions'] });
      void qc.invalidateQueries({ queryKey: ['markets'] });
      const ui = useUi.getState();
      const next = ui.next;
      ui.closeLegal();
      ui.closeWallet();
      ui.resetConn();
      if (opts.toast) ui.toast({ tone: 'success', title: opts.toast });
      if (opts.goNext !== false) {
        useUi.setState({ next: null });
        router.push(next && next.startsWith('/') && !next.startsWith('//') ? next : '/markets');
      }
    },
    [qc, router],
  );

  /** Pick a detected wallet: connect, then ask for the Terms. */
  const startWallet = useCallback(
    async (name: string) => {
      const ui = useUi.getState();
      const entry = adapterFor(name);
      if (!entry) return;
      const ready = entry.readyState === WalletReadyState.Installed || entry.readyState === WalletReadyState.Loadable;
      if (!ready) {
        window.open(entry.adapter.url, '_blank', 'noopener,noreferrer');
        return;
      }
      ui.setConn({ phase: 'connecting', walletName: name, address: null, error: null });
      try {
        w.select(name as WalletName);
        if (!entry.adapter.connected) await entry.adapter.connect();
        const pk = await until(() => entry.adapter.publicKey, 4000);
        if (!pk) throw new Error('The wallet did not share an account.');
        const address = pk.toBase58();
        ui.setConn({ phase: 'legal', address });
        ui.closeWallet();
        ui.openLegal({ reason: 'connect', walletName: name, address });
      } catch (e) {
        ui.setConn({ phase: 'error', error: friendly(e) });
      }
    },
    [adapterFor, w],
  );

  /** The user ticked the box in the legal modal: sign in with Solana and open the session. */
  const acceptAndSign = useCallback(async () => {
    const ui = useUi.getState();
    const { legal, conn } = ui;
    if (!legal) return;
    if (legal.reason === 'refresh') {
      try {
        ui.setConn({ phase: 'signing', error: null });
        const s = await api.acceptTos(env.tosVersion);
        afterSession(s, { toast: 'Terms accepted', goNext: false });
      } catch (e) {
        ui.setConn({ phase: 'legal', error: friendly(e) });
      }
      return;
    }
    const entry = adapterFor(legal.walletName);
    const address = legal.address || conn.address;
    if (!entry || !address) {
      ui.setConn({ phase: 'error', error: 'The wallet disconnected. Pick it again to continue.' });
      ui.closeLegal();
      ui.openWallet();
      return;
    }
    ui.setConn({ phase: 'signing', error: null });
    try {
      const nonce = await api.nonce(address);
      const ad = entry.adapter as unknown as SigningWallet & { signIn?: SigningWallet['signIn']; signMessage?: SigningWallet['signMessage'] };
      const proof = await signInWithWallet(
        { signIn: 'signIn' in ad && ad.signIn ? ad.signIn.bind(ad) : undefined, signMessage: 'signMessage' in ad && ad.signMessage ? ad.signMessage.bind(ad) : undefined },
        address,
        nonce,
      );
      const s = await api.verify({ wallet: address, signedMessage: proof.signedMessage, signature: proof.signature, walletName: legal.walletName, tosAccepted: true });
      afterSession(s, { toast: `Connected ${shortAddr(address)}` });
    } catch (e) {
      ui.setConn({ phase: 'legal', error: friendly(e) });
    }
  }, [adapterFor, afterSession]);

  const disconnectAll = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* the cookie may already be gone */
    }
    try {
      await w.disconnect();
    } catch {
      /* ignore */
    }
    qc.setQueryData(qk.session, null);
    qc.removeQueries({ queryKey: qk.me });
    qc.removeQueries({ queryKey: ['positions'] });
    qc.removeQueries({ queryKey: qk.activity });
    qc.removeQueries({ queryKey: ['balance'] });
    useUi.getState().resetConn();
    router.push('/');
  }, [qc, router, w]);

  const declineLegal = useCallback(async () => {
    const ui = useUi.getState();
    const l = ui.legal;
    ui.closeLegal();
    ui.resetConn();
    if (l?.reason === 'connect') {
      try {
        await w.disconnect();
      } catch {
        /* ignore */
      }
      ui.toast({ tone: 'info', title: 'Terms declined', body: 'Nothing was signed and no session was created.' });
    } else {
      await disconnectAll();
    }
  }, [w, disconnectAll]);

  const viewAddress = useCallback(
    async (address: string): Promise<string | null> => {
      const a = address.trim();
      const st = addrStatus(a);
      if (st !== 'ok') return addrMessage(st, shortAddr(a)).text;
      try {
        const s = await api.view(a);
        afterSession(s, { toast: `Viewing ${shortAddr(a)} (read-only)` });
        return null;
      } catch (e) {
        return friendly(e);
      }
    },
    [afterSession],
  );

  /** Re-connect the signing wallet in this browser after a reload, for a session that is already open. */
  const reconnectSigner = useCallback(async (): Promise<boolean> => {
    if (!session || session.mode !== 'sign') return false;
    const entry = (session.walletName && adapterFor(session.walletName)) || w.wallets.find((x) => x.readyState === WalletReadyState.Installed);
    if (!entry) {
      useUi.getState().openWallet();
      return false;
    }
    try {
      w.select(entry.adapter.name as WalletName);
      if (!entry.adapter.connected) await entry.adapter.connect();
      const pk = await until(() => entry.adapter.publicKey, 4000);
      if (pk && pk.toBase58() !== session.wallet) {
        useUi.getState().toast({ tone: 'error', title: 'Different wallet account', body: `Your session is for ${shortAddr(session.wallet)}. Switch the account in your wallet or use Switch wallet.` });
        return false;
      }
      return !!pk;
    } catch (e) {
      useUi.getState().toast({ tone: 'error', title: 'Could not reconnect', body: friendly(e) });
      return false;
    }
  }, [adapterFor, session, w]);

  const switchWallet = useCallback(async () => {
    try {
      await w.disconnect();
    } catch {
      /* ignore */
    }
    useUi.getState().openWallet(null);
  }, [w]);

  return { startWallet, acceptAndSign, declineLegal, viewAddress, disconnectAll, reconnectSigner, switchWallet, wallets: w.wallets };
}
