'use client';

import { useState } from 'react';
import { Button, Spinner } from '@groundgraph/ui';
import { Modal, ModalHeader } from '@/components/common/Modal';
import { api } from '@/lib/api';
import { useSession } from '@/lib/queries';
import { useUi } from '@/lib/stores';

/** Dispute a wallet flag or ask to hide a label. Sent from the wallet in question, so it needs a session. */
export function DisputeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: session } = useSession();
  const openWallet = useUi((s) => s.openWallet);
  const toast = useUi((s) => s.toast);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const send = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.dispute(msg.trim());
      toast({ tone: 'success', title: 'Dispute sent', body: 'We review disputes by hand. Your label stays visible until a decision is made.' });
      setMsg('');
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} label="Dispute a wallet flag" data-component="DisputeModal" panelClassName="w-full max-w-[460px] p-6 flex flex-col gap-4">
      <ModalHeader title="Dispute a wallet flag" sub="Scores describe on-chain behaviour. If yours looks wrong, or you want the label hidden, tell us why." onClose={onClose} />
      {!session || session.mode !== 'sign' ? (
        <>
          <p className="text-sm leading-[1.5] text-muted">Disputes are sent from the wallet in question, so connect a signing wallet first.</p>
          <Button
            onClick={() => {
              onClose();
              openWallet();
            }}
          >
            Connect a signing wallet
          </Button>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-2 text-xs text-faint">
            Message
            <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={5} maxLength={1000} className="gg-input h-auto py-3 text-sm text-ink" placeholder="Which flag, and what is wrong or missing?" />
          </label>
          {err ? (
            <p role="alert" className="text-xs text-below-text">
              {err}
            </p>
          ) : null}
          <Button disabled={busy || msg.trim().length < 10} onClick={() => void send()}>
            {busy ? <Spinner size={14} /> : null}
            Send dispute
          </Button>
        </>
      )}
    </Modal>
  );
}
