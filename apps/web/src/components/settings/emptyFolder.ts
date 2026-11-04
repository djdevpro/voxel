/** « Vider » la corbeille ou les indésirables : confirmation avec le nombre, progression, annulation. */
import { toast } from 'sonner';
import i18n from '@/i18n';
import { emptyMailbox } from '@/lib/folders';
import { getMailboxData, mailboxLabel } from '@/lib/mail';
import { errorMessage } from '@/lib/api';
import { confirmDialog } from '@/store/confirm';

const t = (k: string, o?: Record<string, unknown>) => i18n.t(`settings:folders.${k}`, o);

export async function confirmEmptyFolder(accountId: string, mailboxId: string): Promise<void> {
  const data = await getMailboxData(accountId);
  const m = data.mailboxes.find((x) => x.id === mailboxId);
  if (!m) return;
  const count = m.totalEmails;
  if (!count) {
    toast(t('emptyAlready', { name: mailboxLabel(m) }));
    return;
  }
  const ok = await confirmDialog({
    title: t('emptyTitle', { name: mailboxLabel(m) }),
    description: t('emptyText', { count }),
    confirmLabel: t('emptyConfirm'),
    destructive: true,
  });
  if (!ok) return;
  const ctrl = new AbortController();
  const id = toast.loading(t('emptying', { done: 0, total: count }), {
    action: { label: t('emptyCancel'), onClick: () => ctrl.abort() },
  });
  try {
    const done = await emptyMailbox(accountId, mailboxId, {
      signal: ctrl.signal,
      onProgress: (d, total) => toast.loading(t('emptying', { done: d, total }), { id, action: { label: t('emptyCancel'), onClick: () => ctrl.abort() } }),
    });
    if (ctrl.signal.aborted) toast(t('emptyStopped', { count: done }), { id, action: undefined });
    else toast.success(t('emptied', { name: mailboxLabel(m), count: done }), { id, action: undefined });
  } catch (e) {
    toast.error(t('emptyFailed'), { id, description: errorMessage(e), action: undefined });
  }
}
