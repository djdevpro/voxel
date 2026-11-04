/** Quota de stockage d'une boîte : `Quota/get`, relu après chaque changement d'Email. */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { pickQuota, quotaLevel, type Quota } from '@voxel/jmap';
import i18n from '@/i18n';
import { jmap } from '@/lib/jmap';
import type { MailboxInfo } from '@/lib/api';

export interface QuotaInfo {
  used: number;
  limit: number;
  level: 'ok' | 'warn' | 'danger';
}

export async function fetchQuota(accountId: string): Promise<QuotaInfo | null> {
  const c = jmap(accountId);
  const aid = await c.accountId();
  const r = await c.call('Quota/get', { accountId: aid, ids: null });
  const q: Quota | null = pickQuota(r.list);
  // pas de quota, ou quota sans limite (hardLimit 0) : rien à afficher
  if (!q || !(q.hardLimit > 0) || q.resourceType !== 'octets') return null;
  return { used: q.used, limit: q.hardLimit, level: quotaLevel(q.used, q.hardLimit) };
}

/** Alerte au-delà de 90 % : un toast par boîte et par session. */
const warned = new Set<string>();

export function useQuota(account: MailboxInfo | undefined) {
  const enabled = !!account?.capabilities?.quota;
  const q = useQuery({
    queryKey: ['quota', account?.id ?? ''],
    queryFn: () => fetchQuota(account!.id),
    enabled,
    staleTime: 5 * 60_000,
  });
  const data = enabled ? q.data : null;
  useEffect(() => {
    if (!account || !data || data.level === 'ok' || warned.has(account.id)) return;
    warned.add(account.id);
    toast.warning(i18n.t('mail:quota.warnToast', { mailbox: account.displayName || account.email, percent: Math.round((data.used / data.limit) * 100) }));
  }, [account, data]);
  return data ?? null;
}
