import { LoaderCircle, Newspaper } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAiEnabled } from '@/lib/ai/store';
import { useSummary, useSummaryJob } from '@/lib/ai/summaries';
import { useNav } from '@/nav/useNav';
import { RouteLink } from '@/nav/links';
import { cn } from '@/lib/utils';
import { localIsoDate } from './dates';

const SUMMARIES_LINK = { to: '/summaries', params: {}, search: {} };

/** Rubrique « Résumés » de la barre latérale (même apparence qu'une ligne de dossier). */
export function SummariesNavRow({ onNavigate }: { onNavigate?: () => void }) {
  const enabled = useAiEnabled();
  const nav = useNav();
  const today = useSummary(localIsoDate());
  const running = useSummaryJob((s) => s.date !== null && s.progress !== null);
  const { t } = useTranslation('ai-summaries');
  if (!enabled) return null;
  const active = nav.route === 'summaries';
  return (
    <div
      className={cn(
        'group relative flex h-[30px] items-center gap-2 rounded-md ps-2 pe-1.5 text-[13.5px] voxel-transition select-none',
        active ? 'bg-voxel-accent-soft font-medium text-text-1' : 'text-text-2 hover:bg-black/[0.04] hover:text-text-1 dark:hover:bg-white/[0.05]',
      )}
    >
      <span className={cn('flex size-4 shrink-0 items-center justify-center [&_svg]:size-[15px]', active ? 'text-voxel-accent-strong' : 'text-text-3 group-hover:text-text-2')}>
        <Newspaper />
      </span>
      <RouteLink
        link={SUMMARIES_LINK}
        onClick={(e) => {
          if (!e.defaultPrevented && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) onNavigate?.();
        }}
        aria-current={active ? 'page' : undefined}
        aria-label={t('nav')}
        className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-voxel-accent"
      />
      <span className="pointer-events-none relative min-w-0 flex-1 truncate">{t('nav')}</span>
      {running ? (
        <LoaderCircle aria-hidden className="pointer-events-none relative size-3 animate-spin text-text-3" />
      ) : (
        today?.read === false && <span aria-hidden className="pointer-events-none relative me-1 size-1.5 rounded-full bg-voxel-accent" />
      )}
    </div>
  );
}
