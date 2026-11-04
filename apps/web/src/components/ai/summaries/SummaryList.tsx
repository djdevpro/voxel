import { useEffect, useRef } from 'react';
import { Menu, Newspaper, RotateCcw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAiReady, useAiSettings } from '@/lib/ai/store';
import { prefetchSummaryGenerator, startSummaryJob, useSummaries, useSummaryJob } from '@/lib/ai/summaries';
import type { AiSummary } from '@/lib/ai/types';
import { useNav } from '@/nav/useNav';
import { goSummaries, openSettings } from '@/nav/nav';
import { useIsMobile } from '@/hooks/useEnvironment';
import { useUi } from '@/store/ui';
import { EmptyState, IconButton } from '@/components/common/bits';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { dayLabel, localIsoDate } from './dates';
import { previewText } from './sources';

function summarize(date: string) {
  startSummaryJob(date);
  goSummaries(date);
}

const ROW = 'block w-full border-b border-line/60 px-4 py-3 text-start outline-none voxel-transition hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:ring-inset';

/** Colonne des jours de l'écran Résumés. */
export function SummaryList({ className }: { className?: string }) {
  const { t } = useTranslation('ai-summaries');
  const nav = useNav();
  const mobile = useIsMobile();
  const setDrawer = useUi((s) => s.setDrawer);
  const ready = useAiReady('summary');
  const auto = useAiSettings((s) => s.summary.auto);
  const summaries = useSummaries();
  const job = useSummaryJob();
  const running = job.date !== null && job.progress !== null;
  const today = localIsoDate();
  const hasToday = !!summaries?.some((s) => s.id === today);
  const autoChecked = useRef(false);

  // moteur des résumés préchargé dès que l'écran s'affiche avec l'IA prête
  useEffect(() => {
    if (ready) prefetchSummaryGenerator();
  }, [ready]);

  useEffect(() => {
    if (!summaries) return;
    // génération automatique du jour : une seule fois par montage
    if (!autoChecked.current) {
      autoChecked.current = true;
      const j = useSummaryJob.getState();
      if (ready && auto && !hasToday && !(j.date !== null && j.progress !== null)) {
        startSummaryJob(today);
        if (!nav.summary) goSummaries(today, { replace: true });
        return;
      }
    }
    // bureau : le plus récent s'ouvre par défaut
    if (!mobile && !nav.summary && summaries[0]) goSummaries(summaries[0].id, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaries, nav.summary, mobile]);

  const ghost = running && job.date && !summaries?.some((s) => s.id === job.date) ? job.date : null;

  const headerAction = !ready ? (
    <Button variant="outline" size="sm" onClick={() => openSettings('ai')}>
      {t('actions.configure')}
    </Button>
  ) : !hasToday ? (
    <Button size="sm" className="voxel-btn-tonal" disabled={running} onClick={() => summarize(today)}>
      <Sparkles /> {t('actions.today')}
    </Button>
  ) : (
    <IconButton label={t('actions.regenerate')} disabled={running} onClick={() => summarize(today)}>
      <RotateCcw />
    </IconButton>
  );

  return (
    <section data-pane="list" aria-label={t('list.region')} className={cn('flex min-h-0 min-w-0 flex-col border-e border-line bg-panel', className)}>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 pt-3 pb-2.5">
        {mobile && (
          <IconButton label={t('common:nav.menu')} onClick={() => setDrawer(true)} className="-ms-1.5">
            <Menu />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-text-1">{t('title')}</h2>
          <p className="truncate text-[12px] text-text-3">{t('subtitle')}</p>
        </div>
        {headerAction}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!ready && !summaries?.length ? (
          <EmptyState
            icon={<Newspaper />}
            title={t('notReady.title')}
            description={t('notReady.description')}
            action={
              <Button variant="outline" onClick={() => openSettings('ai')}>
                {t('actions.configure')}
              </Button>
            }
          />
        ) : summaries && !summaries.length && !ghost ? (
          <EmptyState
            icon={<Newspaper />}
            title={t('empty.title')}
            description={t('empty.description')}
            action={
              <Button className="voxel-btn-tonal" disabled={running} onClick={() => summarize(today)}>
                <Sparkles /> {t('actions.today')}
              </Button>
            }
          />
        ) : (
          <ul>
            {ghost && (
              <li>
                <button type="button" onClick={() => goSummaries(ghost)} aria-current={nav.summary === ghost ? 'true' : undefined} className={cn(ROW, nav.summary === ghost && 'bg-row-selected')}>
                  <span className="block text-[12px] font-medium text-text-3">{dayLabel(ghost)}</span>
                  <span className="mt-0.5 block text-[13.5px] text-text-1 shimmer">{t('list.generating')}</span>
                  <span aria-hidden className="voxel-skeleton mt-2 block h-2.5 w-full rounded" />
                  <span aria-hidden className="voxel-skeleton mt-1.5 block h-2.5 w-2/3 rounded" />
                </button>
              </li>
            )}
            {summaries?.map((s) => <SummaryRow key={s.id} summary={s} selected={nav.summary === s.id} />)}
          </ul>
        )}
      </div>
    </section>
  );
}

function SummaryRow({ summary, selected }: { summary: AiSummary; selected: boolean }) {
  const { t } = useTranslation('ai-summaries');
  const preview = previewText(summary.markdown);
  return (
    <li>
      <button type="button" onClick={() => goSummaries(summary.id)} aria-current={selected ? 'true' : undefined} className={cn(ROW, selected && 'bg-row-selected')}>
        <span className="flex items-center gap-2 text-[12px] font-medium text-text-3">
          <span className="min-w-0 flex-1 truncate">{dayLabel(summary.id)}</span>
          <span className="shrink-0 tabular-nums">{t('list.emails', { count: summary.emailCount })}</span>
        </span>
        <span className={cn('mt-0.5 flex items-center gap-1.5 text-[13.5px] text-text-1', !summary.read && 'font-semibold')}>
          {!summary.read && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-voxel-accent" />}
          <span dir="auto" className="min-w-0 truncate">
            {summary.title}
          </span>
        </span>
        {preview && (
          <span dir="auto" className="mt-0.5 line-clamp-2 text-[12.5px] text-text-2">
            {preview}
          </span>
        )}
      </button>
    </li>
  );
}
