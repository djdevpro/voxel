/** Indicateur de priorité d'un message : flèche haute (rouge) ou basse (discrète), rien si normale. */
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Priority } from '@voxel/jmap';
import { cn } from '@/lib/utils';

export function PriorityMark({ priority, className }: { priority: Priority | undefined; className?: string }) {
  const { t } = useTranslation('mail');
  if (!priority || priority === 'normal') return null;
  const label = t(`priority.${priority}`);
  const Icon = priority === 'high' ? ArrowUp : ArrowDown;
  return (
    <span role="img" aria-label={label} title={label} className={cn('inline-flex shrink-0', priority === 'high' ? 'text-danger' : 'text-text-3', className)}>
      <Icon className="size-3.5" strokeWidth={2.5} />
    </span>
  );
}
