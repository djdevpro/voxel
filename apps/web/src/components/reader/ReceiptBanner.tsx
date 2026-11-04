/**
 * Bandeau « L'expéditeur demande un accusé de lecture », selon le réglage de l'appareil :
 * demander (bandeau Envoyer / Ignorer), toujours envoyer (envoi automatique à l'ouverture), jamais (rien).
 * Rien pour un message déjà traité (`$mdnsent`), un brouillon, ou un message envoyé par l'une de nos identités.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MailCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Email, Identity } from '@voxel/jmap';
import { useSettings } from '@/store/settings';
import { dismissReceipt, receiptHandled, receiptRequestedBy, receivingIdentity, sendReceipt } from '@/lib/receipts';
import { errorMessage } from '@/lib/api';
import { isOffline } from '@/lib/outbox';

/** Isole une adresse (texte LTR) dans une phrase RTL : FSI … PDI. */
const isolate = (s: string) => `⁨${s}⁩`;

/** Messages déjà traités dans cette session (évite un double envoi avant le rafraîchissement des mots-clés). */
const handled = new Set<string>();

export function ReceiptBanner({ email, accountId, identities, ownEmails }: { email: Email; accountId: string; identities: Identity[] | undefined; ownEmails: Set<string> }) {
  const { t } = useTranslation('reader');
  const policy = useSettings((s) => s.readReceipts);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const key = `${accountId}:${email.id}`;
  const to = receiptRequestedBy(email);
  const fromMe = !!email.from?.some((a) => ownEmails.has(a.email.toLowerCase()));
  const pending = !!to && !fromMe && !email.keywords.$draft && !receiptHandled(email) && !handled.has(key) && !done;
  const identity = receivingIdentity(email, identities);

  const send = async (mode: 'manual' | 'automatic') => {
    if (!identity) return;
    if (isOffline()) {
      toast.error(t('receipt.offline'));
      return;
    }
    setBusy(true);
    handled.add(key);
    try {
      await sendReceipt(accountId, email, identity, mode);
      setDone(true);
      toast(t('receipt.sent', { email: to?.email }));
    } catch (e) {
      handled.delete(key);
      toast.error(t('receipt.failed'), { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  // « toujours envoyer » : une seule fois par message, à l'ouverture
  const auto = useRef(false);
  useEffect(() => {
    if (policy !== 'always' || !pending || !identity || auto.current || isOffline()) return;
    auto.current = true;
    void send('automatic');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, pending, identity]);

  if (!pending || policy !== 'ask' || !identity) return null;
  return (
    <div role="region" aria-label={t('receipt.title')} className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-muted/50 px-3 py-2 text-[12.5px] text-text-2">
      <span className="flex min-w-0 items-center gap-2">
        <MailCheck className="size-3.5 shrink-0 text-text-3" />
        <span className="min-w-0 break-words">{t('receipt.asks', { email: isolate(to!.email) })}</span>
      </span>
      <span className="flex gap-3">
        <button type="button" disabled={busy} className="font-medium text-voxel-accent-strong hover:underline disabled:opacity-50" onClick={() => void send('manual')}>
          {t('receipt.send')}
        </button>
        <button
          type="button"
          disabled={busy}
          className="font-medium text-text-2 hover:text-text-1 hover:underline disabled:opacity-50"
          onClick={() => {
            handled.add(key);
            setDone(true);
            dismissReceipt(accountId, email).catch((e) => toast.error(t('receipt.failed'), { description: errorMessage(e) }));
          }}
        >
          {t('receipt.ignore')}
        </button>
      </span>
    </div>
  );
}
