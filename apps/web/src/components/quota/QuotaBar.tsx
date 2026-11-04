/** Barre fine du quota : « 1,2 Go sur 5 Go », alerte à 90 %, rouge à 98 %. */
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { formatBytes, quotaRatio } from '@voxel/jmap';
import { useQuota } from '@/hooks/useQuota';
import type { MailboxInfo } from '@/lib/api';
import { cn } from '@/lib/utils';
import { tBase } from '@/lib/motion';

export function QuotaBar({ account, label, className }: { account: MailboxInfo; label?: string; className?: string }) {
  const { t, i18n } = useTranslation('mail');
  const q = useQuota(account);
  if (!q) return null;
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const text = t('quota.usage', { used: formatBytes(q.used, locale), limit: formatBytes(q.limit, locale) });
  const pct = Math.round(quotaRatio(q.used, q.limit) * 100);
  return (
    <div className={cn('text-[11.5px] text-text-3', className)}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate" dir="auto">
          {label ?? t('quota.title')}
        </span>
        <span className={cn('tabular shrink-0', q.level === 'danger' ? 'font-medium text-danger' : q.level === 'warn' ? 'font-medium text-warn' : '')}>{text}</span>
      </div>
      <div
        role="meter"
        aria-label={label ?? t('quota.title')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={text}
        className="h-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]"
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={tBase}
          className={cn('h-full rounded-full', q.level === 'danger' ? 'bg-danger' : q.level === 'warn' ? 'bg-warn' : 'bg-voxel-accent')}
        />
      </div>
    </div>
  );
}
