/** Dialogue « Se connecter à une autre boîte » (bouton + du rail) et « Reconnectez-vous » (upstream_auth). */
import { useState } from 'react';
import { motion } from 'motion/react';
import { tBase } from '@/lib/motion';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { create } from 'zustand';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { LoginFlow } from '@/components/auth/LoginFlow';
import { AccountChooser } from '@/components/auth/AccountChooser';
import { afterLogin, useKnownAccounts, useSession } from '@/components/auth/session';
import { goView } from '@/nav/nav';
import type { MailboxInfo } from '@/lib/api';

interface AddMailboxState {
  open: boolean;
  /** Adresse imposée (reconnexion). */
  email?: string;
  reconnect?: boolean;
  show: (opts?: { email?: string; reconnect?: boolean }) => void;
  hide: () => void;
}

export const useAddMailbox = create<AddMailboxState>()((set) => ({
  open: false,
  show: (opts) => set({ open: true, email: opts?.email, reconnect: !!opts?.reconnect }),
  hide: () => set({ open: false }),
}));

function Body({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('accounts');
  const { email: lockedEmail, reconnect } = useAddMailbox();
  const { data: session } = useSession();
  const known = useKnownAccounts((s) => s.list);
  const forget = useKnownAccounts((s) => s.forget);
  const open = new Set((session?.mailboxes ?? []).map((m) => m.email.toLowerCase()));
  const candidates = known.filter((a) => !open.has(a.email));
  const [mode, setMode] = useState<{ kind: 'choose' } | { kind: 'login'; email?: string; key: number }>(() =>
    lockedEmail ? { kind: 'login', email: lockedEmail, key: 0 } : candidates.length ? { kind: 'choose' } : { kind: 'login', key: 0 },
  );

  const onSuccess = async (m: MailboxInfo) => {
    await afterLogin(m);
    toast.success(reconnect ? t('add.reconnected', { email: m.email }) : t('add.added', { email: m.email }));
    if (!reconnect) goView({ accountId: m.id, mailbox: { kind: 'role', role: 'inbox' } });
    onDone();
  };

  return (
    <>
      {mode.kind === 'choose' ? (
        <motion.div key="choose" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={tBase}>
          <AccountChooser
            accounts={candidates}
            onPick={(email) => setMode({ kind: 'login', email, key: Date.now() })}
            onOther={() => setMode({ kind: 'login', key: Date.now() })}
            onForget={forget}
          />
        </motion.div>
      ) : (
        <motion.div key={`login-${mode.key}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={tBase}>
          <LoginFlow
            variant="dialog"
            initialEmail={mode.email}
            lockEmail={!!lockedEmail}
            onSuccess={onSuccess}
            onBack={!lockedEmail && candidates.length ? () => setMode({ kind: 'choose' }) : undefined}
          />
        </motion.div>
      )}
    </>
  );
}

export function AddMailboxDialog() {
  const { t } = useTranslation('accounts');
  const { open, hide, reconnect, email } = useAddMailbox();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && hide()}>
      <DialogContent className="w-[min(440px,94vw)] gap-0 p-0 sm:max-w-none">
        <div className="border-b border-line px-6 pt-5 pb-4">
          <DialogTitle className="text-[16px] font-semibold text-text-1">{reconnect ? t('add.reconnectTitle') : t('add.title')}</DialogTitle>
          <DialogDescription className="mt-1 text-[12.5px] leading-relaxed text-text-2">
            {reconnect ? t('add.reconnectText', { email }) : t('add.text')}
          </DialogDescription>
        </div>
        <div className="px-6 py-5">{open && <Body onDone={hide} />}</div>
      </DialogContent>
    </Dialog>
  );
}
