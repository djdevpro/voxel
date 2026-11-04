/**
 * Notifications push par boîte, dans Paramètres → Lecture et envoi. Interrupteur pour chaque
 * boîte JMAP qui annonce `urn:ietf:params:jmap:webpush-vapid` ; les autres boîtes (IMAP) n'ont que les
 * notifications appli ouverte, ce qui est dit sous la liste.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useAccounts } from '@/hooks/useData';
import { disablePush, enablePush, pushState, pushSupported, PushSetupError } from '@/lib/push';
import { errorMessage } from '@/lib/api';
import { Switch } from '@/components/ui/switch';
import { AccountDot } from '@/components/common/bits';
import { SettingRow } from './ui';

export function PushSettings() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const { data: all } = useAccounts();
  const accounts = all ?? [];
  const capable = accounts.filter((a) => a.capabilities?.webpush);
  const others = accounts.filter((a) => !a.capabilities?.webpush);
  const { data: enabled } = useQuery({
    queryKey: ['push-state', capable.map((a) => a.id).join(',')],
    queryFn: async () => Object.fromEntries(await Promise.all(capable.map(async (a) => [a.id, !!(await pushState(a.id))] as const))),
  });
  const [busy, setBusy] = useState<string | null>(null);
  if (!accounts.length) return null;
  const supported = pushSupported();

  const toggle = async (id: string, on: boolean) => {
    setBusy(id);
    try {
      if (on) {
        await enablePush(id);
        toast(t('reading.push.enabled'));
      } else await disablePush(id);
    } catch (e) {
      const code = e instanceof PushSetupError ? e.code : null;
      toast.error(t('reading.push.failed'), { description: code ? t(`reading.push.errors.${code}`) : errorMessage(e) });
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['push-state'] });
    }
  };

  return (
    <SettingRow
      title={t('reading.push.title')}
      description={
        <>
          {t('reading.push.description')}
          {!supported && capable.length > 0 && <span className="block">{t('reading.push.errors.unsupported')}</span>}
          {others.length > 0 && <span className="block">{t('reading.push.openOnly', { list: others.map((a) => a.displayName || a.email).join(', ') })}</span>}
        </>
      }
    >
      {capable.length > 0 && (
        <ul className="space-y-2">
          {capable.map((a) => (
            <li key={a.id} className="flex items-center justify-end gap-2.5">
              <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-text-2">
                <AccountDot color={a.color} />
                <span className="truncate">{a.displayName || a.email}</span>
              </span>
              <Switch
                checked={!!enabled?.[a.id]}
                disabled={!supported || busy === a.id}
                aria-label={t('reading.push.toggle', { mailbox: a.displayName || a.email })}
                className="data-[state=checked]:bg-voxel-accent"
                onCheckedChange={(v) => void toggle(a.id, v)}
              />
            </li>
          ))}
        </ul>
      )}
    </SettingRow>
  );
}
