'use client';

import { useEffect, useRef, useState } from 'react';
import { Checkbox, Spinner } from '@groundgraph/ui';
import { Modal } from '@/components/common/Modal';
import { useUi } from '@/lib/stores';
import { LEGAL_KEYS, LEGAL_TAB, type LegalDocKey } from '@/lib/legal';
import { shortAddr } from '@/lib/format';
import { useLegalDocs } from './legal-context';
import { useWalletFlow } from './flow';
import { useIsMobile } from '@/lib/hooks';

/** Legal documents. Mandatory (cannot be dismissed, needs the checkbox) while connecting a wallet. */
export function LegalModal() {
  const legal = useUi((s) => s.legal);
  const conn = useUi((s) => s.conn);
  const closeLegal = useUi((s) => s.closeLegal);
  const docs = useLegalDocs();
  const { acceptAndSign, declineLegal } = useWalletFlow();
  const mobile = useIsMobile();
  const [doc, setDoc] = useState<LegalDocKey>('terms');
  const [agree, setAgree] = useState(false);
  const [progress, setProgress] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const open = !!legal;
  const mandatory = true;
  const signing = conn.phase === 'signing';

  useEffect(() => {
    if (open) {
      setAgree(false);
      setDoc('terms');
      setProgress(0);
    }
  }, [open]);

  const d = docs[doc];
  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max <= 0 ? 100 : Math.min(100, Math.round((el.scrollTop / max) * 100)));
  };
  const pick = (k: LegalDocKey) => {
    setDoc(k);
    if (body.current) body.current.scrollTop = 0;
    setProgress(0);
  };

  useEffect(() => {
    // short documents have nothing to scroll, so they count as fully read
    if (open) requestAnimationFrame(onScroll);
  }, [open, doc]);

  const who = legal?.reason === 'connect' ? `${legal.walletName} · ${shortAddr(legal.address)}` : 'Updated terms';
  const label = conn.phase === 'signing' ? 'Waiting for signature' : legal?.reason === 'connect' ? 'Accept & sign' : 'Accept';

  return (
    <Modal
      open={open}
      onClose={() => undefined}
      closable={!mandatory}
      z={95}
      variant="center"
      scrim="bg-[rgba(4,3,8,0.78)]"
      label={d.title}
      data-component="LegalModal"
      initialFocus="[data-legal-tab]"
      panelClassName="relative flex flex-col overflow-hidden rounded-3xl! animate-gg-tos!"
    >
      <div
        className="flex min-h-0 flex-col overflow-hidden"
        style={{
          maxHeight: 'calc(100dvh - 24px)',
          width: mobile ? 'min(calc(100vw - 24px), calc((100vh - 24px) * 0.75))' : 'min(760px, calc(100vw - 32px), calc((100vh - 32px) * 1.3333))',
          aspectRatio: mobile ? '3 / 4' : '4 / 3',
        }}
      >
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[150px] bg-[radial-gradient(70%_100%_at_50%_0%,rgba(91,44,143,0.38),transparent)]" />
        <div className="relative flex flex-none items-start justify-between gap-4 px-6 pb-3.5 pt-[22px]">
          <div className="flex min-w-0 items-center gap-3.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/gg-icon.png" alt="" width={40} height={40} className="h-10 w-10 flex-none rounded-[11px] shadow-[0_0_24px_rgba(91,44,143,0.6)]" />
            <div className="flex min-w-0 flex-col gap-[7px]">
              <span className="gg-eyebrow text-above!">Before you continue</span>
              <h2 className="font-display text-[clamp(19px,2.4vw,24px)] font-semibold leading-[1.1] tracking-[-0.02em] text-ink">{d.title}</h2>
            </div>
          </div>
        </div>
        <div className="relative flex flex-none flex-wrap items-center justify-between gap-2.5 px-6 pb-3">
          <div role="tablist" aria-label="Legal documents" className="gg-seg">
            {LEGAL_KEYS.map((k) => (
              <button key={k} role="tab" aria-selected={doc === k} data-on={doc === k} data-legal-tab type="button" onClick={() => pick(k)} className="gg-seg-btn h-8! px-[13px]!">
                {LEGAL_TAB[k]}
              </button>
            ))}
          </div>
          {!mobile ? (
            <span className="font-mono text-[11px] text-faint">
              Updated {d.updated} · {d.readTime}
            </span>
          ) : null}
        </div>
        <div className="h-0.5 flex-none bg-violet/[0.12]" role="progressbar" aria-label="Reading progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span className="block h-full bg-[linear-gradient(90deg,#9B6BFF,#2CE6D6)] shadow-[0_0_10px_rgba(44,230,214,0.6)] transition-[width] duration-150 ease-linear" style={{ width: `${progress}%` }} />
        </div>
        <div data-component="LegalBody" ref={body} onScroll={onScroll} tabIndex={0} aria-label={`${d.title} text`} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-3 pt-[18px]">
          <p className="text-sm leading-[1.6] text-ink-2">{d.intro}</p>
          {d.sections.map((x) => (
            <div key={x.n} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-2.5 gap-y-1">
              <span className="font-mono text-[11px] font-medium leading-[1.9] text-violet">{x.n}</span>
              <div className="flex flex-col gap-1.5">
                <h3 className="font-display text-[15px] font-semibold leading-[1.3] text-ink">{x.t}</h3>
                <p className="text-[13px] leading-[1.6] text-muted">{x.d}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-none flex-col gap-3 border-t border-violet/15 bg-bg/45 px-6 pb-[18px] pt-3.5">
          <Checkbox checked={agree} onChange={setAgree} className="text-[13px] leading-[1.45] text-ink-2">
            <span>I am 18 or older, not in a restricted region, and I agree to the Terms of Service, Privacy Policy and Risk Disclosure.</span>
          </Checkbox>
          {conn.error ? (
            <div role="alert" className="rounded-xl border border-below/30 bg-below/[0.07] px-3 py-2 text-xs leading-[1.45] text-below-text">
              {conn.error}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <span className="flex items-center gap-2 font-mono text-[11px] leading-[1.4] text-faint">
              <span aria-hidden className="gg-dot" />
              {who}
            </span>
            <div className="ml-auto flex gap-2">
              <button type="button" disabled={signing} onClick={() => void declineLegal()} className="gg-btn h-11 rounded-xl border-white/15 px-[18px] text-sm hover:border-below/50">
                Decline
              </button>
              <button
                type="button"
                disabled={!agree || signing}
                onClick={() => void acceptAndSign()}
                className="gg-btn gg-btn-primary h-11 gap-2.5 rounded-xl px-5 text-sm"
              >
                {signing ? <Spinner size={14} className="border-white/30! border-t-white!" /> : null}
                {label}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
