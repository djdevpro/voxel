/** Actions de compte partagées par le rail, son menu et Paramètres → Boîtes. */
import { toast } from 'sonner';
import i18n from '@/i18n';
import { errorMessage, type MailboxInfo } from '@/lib/api';
import { updateAccount } from '@/lib/accounts';
import { scheduleSyncedWrite } from '@/lib/syncedSettings';
import { confirmDialog } from '@/store/confirm';
import { logoutAll, logoutMailbox, refreshSession, useKnownAccounts } from '@/components/auth/session';

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(`accounts:${key}`, opts);

/** Renomme ou recolore une boîte (synchronisé entre appareils). */
export async function updateMailbox(mb: MailboxInfo, patch: { displayName?: string; color?: string }) {
  try {
    await updateAccount(mb.id, patch);
    useKnownAccounts.getState().remember({ ...mb, ...patch });
    scheduleSyncedWrite(mb.id, patch);
  } catch (e) {
    toast.error(t('toast.updateFailed'), { description: errorMessage(e) });
  }
  await refreshSession().catch(() => undefined);
}

export async function confirmLogoutMailbox(mb: MailboxInfo) {
  const ok = await confirmDialog({
    title: t('logout.confirmTitle', { email: mb.email }),
    description: t('logout.confirmText'),
    confirmLabel: t('logout.confirm'),
    destructive: true,
  });
  if (!ok) return;
  try {
    await logoutMailbox(mb.id);
    toast(t('logout.done', { email: mb.email }));
  } catch (e) {
    toast.error(t('toast.logoutFailed'), { description: errorMessage(e) });
  }
}

export async function confirmLogoutAll() {
  const ok = await confirmDialog({
    title: t('logoutAll.confirmTitle'),
    description: t('logoutAll.confirmText'),
    confirmLabel: t('logoutAll.confirm'),
    destructive: true,
  });
  if (!ok) return;
  await logoutAll();
}
