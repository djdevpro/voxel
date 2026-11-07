/**
 * Pièces jointes volumineuses, dans Paramètres → Lecture et envoi : le seuil, la durée des liens et, pour chaque
 * boîte qui peut s'en servir, l'espace S3 utilisé (ou « pas encore de compte » : il sera créé à la première
 * pièce jointe volumineuse). Absent quand le serveur n'a pas de stockage S3.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAccounts } from '@/hooks/useData';
import { fileSize } from '@/lib/format';
import { largeFilesAccount, largeFilesConfig, largeFilesEligible } from '@/lib/largeFiles';
import { AccountDot } from '@/components/common/bits';
import { SettingRow } from './ui';

export function LargeFilesSettings() {
  const { t } = useTranslation('appearance');
  const { data: cfg } = useQuery({ queryKey: ['large-files-config'], queryFn: largeFilesConfig, staleTime: Infinity });
  const { data: all } = useAccounts();
  const eligible = (all ?? []).filter((a) => largeFilesEligible(a));
  const { data: usage } = useQuery({
    queryKey: ['large-files-usage', eligible.map((a) => a.id).join(',')],
    queryFn: async () => Object.fromEntries(await Promise.all(eligible.map(async (a) => [a.id, await largeFilesAccount(a.id, { fresh: true }).catch(() => null)] as const))),
    enabled: !!cfg?.enabled && eligible.length > 0,
  });
  if (!cfg?.enabled || !eligible.length) return null;

  return (
    <SettingRow
      title={t('reading.largeFiles.title')}
      description={t('reading.largeFiles.description', { threshold: fileSize(cfg.threshold), days: cfg.linkDays, quota: fileSize(cfg.quota) })}
    >
      <ul className="space-y-2">
        {eligible.map((a) => {
          const u = usage?.[a.id];
          return (
            <li key={a.id} className="flex items-center justify-end gap-2.5">
              <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-text-2">
                <AccountDot color={a.color} />
                <span className="truncate">{a.displayName || a.email}</span>
              </span>
              <span className="shrink-0 text-[12.5px] text-text-3 tabular">
                {u ? (u.exists ? t('reading.largeFiles.used', { used: fileSize(u.used), quota: fileSize(u.quota) }) : t('reading.largeFiles.noAccount')) : '…'}
              </span>
            </li>
          );
        })}
      </ul>
    </SettingRow>
  );
}
