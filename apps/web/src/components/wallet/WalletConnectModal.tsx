'use client';

import { useMemo, useState } from 'react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { Button } from '@groundgraph/ui';
import { Modal, ModalHeader } from '@/components/common/Modal';
import { useUi } from '@/lib/stores';
import { addrMessage, addrStatus } from '@/lib/addr';
import { shortAddr } from '@/lib/format';
import { WALLET_INSTALL, useWalletFlow } from './flow';
import { Spinner } from '@groundgraph/ui';

function Mono({ name, icon, bg, size = 36 }: { name: string; icon?: string; bg?: string; size?: number }) {
  if (icon) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={icon} alt="" width={size} height={size} className="flex-none rounded-[10px]" style={{ width: size, height: size }} />;
  }
  return (
    <span aria-hidden className="grid flex-none place-items-center rounded-[10px] font-display text-[15px] font-bold text-white" style={{ width: size, height: size, background: bg ?? '#5B2C8F' }}>
      {name.slice(0, 1)}
    </span>
  );
}

export function WalletConnectModal() {
  const open = useUi((s) => s.walletModal);
  const conn = useUi((s) => s.conn);
  const close = useUi((s) => s.closeWallet);
  const resetConn = useUi((s) => s.resetConn);
  const { startWallet, viewAddress, wallets } = useWalletFlow();
  const [paste, setPaste] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverMsg, setServerMsg] = useState<string | null>(null);

  const detected = useMemo(() => wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable), [wallets]);
  const detectedNames = new Set(detected.map((w) => w.adapter.name.toLowerCase()));
  const toInstall = WALLET_INSTALL.filter((w) => !detectedNames.has(w.name.toLowerCase()));

  const connecting = conn.phase === 'connecting';
  const failed = conn.phase === 'error';
  const status = addrStatus(paste.trim());
  const msg = addrMessage(status, shortAddr(paste.trim()));
  const showErr = touched && (status === 'evm' || status === 'bad');
  const picked = wallets.find((w) => w.adapter.name === conn.walletName);

  const handleClose = () => {
    if (connecting) return;
    resetConn();
    setPaste('');
    setTouched(false);
    setServerMsg(null);
    close();
  };

  const submitPaste = async () => {
    setTouched(true);
    if (status !== 'ok') return;
    setBusy(true);
    const err = await viewAddress(paste.trim());
    setBusy(false);
    if (err) setServerMsg(err);
    else {
      setPaste('');
      setTouched(false);
      setServerMsg(null);
    }
  };

  const readClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setPaste(t.trim());
      setTouched(true);
    } catch {
      setTouched(true);
    }
  };

  const tone = serverMsg ? 'error' : showErr ? 'error' : status === 'ok' ? 'ok' : 'hint';
  const color = tone === 'ok' ? '#2CE6D6' : tone === 'error' ? '#E046F0' : '#9A95AE';

  return (
    <Modal open={open} onClose={handleClose} label="Connect a wallet" data-component="WalletConnectModal" panelClassName="w-full max-w-[440px] p-6 pb-[max(24px,env(safe-area-inset-bottom))] flex flex-col gap-[18px]">
      <ModalHeader title={connecting ? 'Connecting...' : 'Connect a wallet'} sub={connecting ? 'Waiting for your approval' : 'Wallet Standard · non-custodial · no email or password'} onClose={connecting ? undefined : handleClose} />

      {connecting ? (
        <div className="flex flex-col items-center gap-[18px] py-5" role="status" aria-live="polite">
          <div className="relative h-[72px] w-[72px]">
            <span className="absolute inset-0 animate-gg-spin rounded-full border-2 border-violet/15 border-t-above" />
            <span className="absolute inset-3.5 grid place-items-center">
              <Mono name={conn.walletName ?? '?'} icon={picked?.adapter.icon} size={40} />
            </span>
          </div>
          <span className="text-center text-sm text-ink-2">Approve the connection in {conn.walletName}</span>
        </div>
      ) : (
        <>
          {failed ? (
            <div role="alert" className="rounded-xl border border-below/30 bg-below/[0.07] px-3.5 py-3 text-[13px] leading-[1.45] text-below-text">
              {conn.error}
            </div>
          ) : null}

          <div data-component="WalletList" className="flex flex-col gap-2">
            {detected.map((w) => (
              <button
                key={w.adapter.name}
                type="button"
                onClick={() => void startWallet(w.adapter.name)}
                className="flex min-h-[58px] items-center gap-3.5 rounded-[14px] border border-violet/15 bg-white/[0.025] px-3.5 text-left transition-all hover:translate-x-0.5 hover:border-above/45 hover:bg-above/5"
              >
                <Mono name={w.adapter.name} icon={w.adapter.icon} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-[15px] font-semibold leading-none">{w.adapter.name}</span>
                  <span className="text-xs text-faint">Detected in this browser</span>
                </span>
                <span className="flex-none font-mono text-[11px] text-above">Detected</span>
              </button>
            ))}
            {detected.length === 0 ? <p className="rounded-xl border border-dashed border-violet/25 px-3.5 py-3 text-[13px] leading-[1.5] text-dim">No Solana wallet was detected in this browser. Install one below, then reload, or paste an address to browse in view-only mode.</p> : null}
            {toInstall.map((w) => (
              <a
                key={w.name}
                href={w.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-[58px] items-center gap-3.5 rounded-[14px] border border-violet/15 bg-white/[0.025] px-3.5 text-left text-body transition-all hover:translate-x-0.5 hover:border-violet/45 hover:text-body"
              >
                <Mono name={w.name} bg={w.bg} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-[15px] font-semibold leading-none">{w.name}</span>
                  <span className="text-xs text-faint">Install the browser extension</span>
                </span>
                <span className="flex-none font-mono text-[11px] text-faint">Install ↗</span>
              </a>
            ))}
          </div>

          <div className="flex items-center gap-3 font-mono text-[11px] font-medium uppercase leading-none tracking-[0.06em] text-faint">
            <span className="h-px flex-1 bg-violet/15" />
            or paste an address
            <span className="h-px flex-1 bg-violet/15" />
          </div>

          <form
            data-component="AddressPaste"
            className="flex flex-col gap-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void submitPaste();
            }}
          >
            <div className="gg-field h-[54px] pr-1.5" data-invalid={showErr || !!serverMsg} style={status === 'ok' ? { borderColor: 'rgba(44,230,214,0.55)', boxShadow: '0 0 24px rgba(44,230,214,0.15)' } : undefined}>
              <input
                value={paste}
                onChange={(e) => {
                  setPaste(e.target.value);
                  setServerMsg(null);
                }}
                onBlur={() => setTouched(true)}
                placeholder="Solana wallet address"
                aria-label="Solana wallet address"
                aria-describedby="paste-msg"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-[13px] font-medium text-ink"
              />
              <button type="button" onClick={() => void readClipboard()} className="h-[42px] flex-none rounded-[10px] border border-violet/25 bg-violet/[0.08] px-3.5 text-xs font-semibold text-violet-pale transition-colors hover:bg-violet/[0.18]">
                Paste
              </button>
            </div>
            <span id="paste-msg" role={tone === 'error' ? 'alert' : undefined} className="flex items-start gap-2 text-xs leading-[1.45] transition-colors" style={{ color }}>
              <span aria-hidden className="mt-[5px] h-1.5 w-1.5 flex-none rounded-full" style={{ background: color }} />
              {serverMsg ?? (showErr || status === 'ok' ? msg.text : addrMessage('empty', '').text)}
            </span>
            <Button type="submit" variant="plain" size="md" disabled={busy || status !== 'ok'} className="rounded-xl border-violet/45 bg-brand text-white disabled:opacity-50">
              {busy ? <Spinner size={14} /> : null}
              Continue in view-only →
            </Button>
          </form>
        </>
      )}
    </Modal>
  );
}
