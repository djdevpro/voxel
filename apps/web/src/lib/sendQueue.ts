import { toast } from 'sonner';
import { submitMessage, type OutgoingMessage } from './send';
import { useUi, type ComposerState } from '@/store/ui';
import { goView } from '@/nav/nav';
import { useSettings } from '@/store/settings';
import { db } from './db';
import { errorMessage } from './api';
import i18n, { currentLocale } from '@/i18n';

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; tick: ReturnType<typeof setInterval>; send: () => Promise<void> }>();
const t = (key: string, opts?: Record<string, unknown>) => i18n.t(`settings:sending.${key}`, opts);

/**
 * Envoi différé avec possibilité d'annuler (délai réglable 5–30 s).
 * `restore` est l'état de la fenêtre à rouvrir si l'utilisateur annule.
 */
export function scheduleSend(msg: OutgoingMessage, restore: ComposerState) {
  const delay = Math.min(30, Math.max(0, useSettings.getState().undoSendSeconds));
  const id = `send-${restore.id}`;
  if (pending.has(id)) return; // déjà programmé (double déclenchement)
  const doSend = async () => {
    pending.delete(id);
    toast.loading(msg.sendAt ? t('scheduling') : t('sending'), { id, description: undefined, action: undefined, duration: Infinity });
    try {
      const r = await submitMessage(msg);
      await db.drafts.delete(restore.id).catch(() => undefined);
      toast.success(
        r.queued
          ? t('queued')
          : msg.sendAt
            ? t('scheduled', { date: new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(msg.sendAt)) })
            : t('sent'),
        {
          id,
          duration: 4000,
          description: undefined,
          // lien vers Envoyés (ou Programmés) de la boîte d'envoi
          cancel: r.queued ? undefined : { label: t('view'), onClick: () => goView({ accountId: restore.accountId, mailbox: { kind: 'role', role: msg.sendAt ? 'scheduled' : 'sent' } }) },
        },
      );
    } catch (e) {
      toast.error(t('failed'), {
        id,
        description: errorMessage(e),
        duration: 10000,
        action: { label: t('reopen'), onClick: () => useUi.getState().openComposer({ ...restore }) },
      });
    }
  };
  if (delay === 0) {
    void doSend();
    return;
  }
  let remaining = delay;
  const render = () =>
    toast(msg.sendAt ? t('schedulingIn', { count: remaining }) : t('sendingIn', { count: remaining }), {
      id,
      duration: Infinity,
      description: msg.subject || t('noSubject'),
      action: {
        label: t('undo'),
        onClick: () => {
          const p = pending.get(id);
          if (p) {
            clearTimeout(p.timer);
            clearInterval(p.tick);
            pending.delete(id);
          }
          toast.dismiss(id);
          useUi.getState().openComposer({ ...restore });
          toast(t('cancelled'), { duration: 2500 });
        },
      },
    });
  render();
  const tick = setInterval(() => {
    remaining = Math.max(1, remaining - 1);
    render();
  }, 1000);
  const timer = setTimeout(() => {
    clearInterval(tick);
    void doSend();
  }, delay * 1000);
  pending.set(id, { timer, tick, send: doSend });
}

export function hasPendingSends() {
  return pending.size > 0;
}

/** Envoie tout de suite les messages en attente d'annulation (fermeture de la fenêtre du bureau). */
export async function flushPendingSends(): Promise<void> {
  const sends = [...pending.values()].map((p) => {
    clearTimeout(p.timer);
    clearInterval(p.tick);
    return p.send();
  });
  await Promise.allSettled(sends);
}

// Fermer ou recharger l'onglet pendant le délai d'annulation annulerait l'envoi :
// le navigateur demande confirmation (le message reste sinon en brouillon local, rouvert au prochain chargement).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!hasPendingSends()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
