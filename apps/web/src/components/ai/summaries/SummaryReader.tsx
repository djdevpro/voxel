import { useCallback, useEffect } from 'react';
import { AlertCircle, ArrowLeft, ChevronRight, Copy, Newspaper, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AiMarkdown, type AiRef } from '@/components/ai/AiMarkdown';
import { EmptyState, IconButton } from '@/components/common/bits';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Trace, TraceLine, TraceTitle } from '@/components/ui/trace';
import { shortModelName } from '@/lib/ai/errors';
import { cancelSummaryJob, deleteSummary, markSummaryRead, startSummaryJob, useSummaries, useSummary, useSummaryJob } from '@/lib/ai/summaries';
import type { AiSummary } from '@/lib/ai/types';
import { useIsMobile } from '@/hooks/useEnvironment';
import { useNav } from '@/nav/useNav';
import { goSummaries, openSettings } from '@/nav/nav';
import { confirmDialog } from '@/store/confirm';
import { cn } from '@/lib/utils';
import { longDate, shortTime } from './dates';
import { openSource, senderName } from './sources';

/** Lecture d'un résumé, ou sa génération en direct. */
export function SummaryReader({ className }: { className?: string }) {
  const { t } = useTranslation('ai-summaries');
  const nav = useNav();
  const date = nav.summary;
  const mobile = useIsMobile();
  const summaries = useSummaries();
  const summary = useSummary(date ?? undefined);
  const job = useSummaryJob();
  const live = !!date && job.date === date && job.progress ? job.progress : null;
  const error = !!date && job.date === date && !job.progress ? job.error : null;

  // ouverture d'un résumé non lu → lu
  useEffect(() => {
    if (summary && !summary.read) void markSummaryRead(summary.id);
  }, [summary]);

  let body;
  if (!date) {
    body = <EmptyState icon={<Newspaper />} title={t('reader.pick')} className="flex-1" />;
  } else if (live) {
    body = (
      <div aria-live="polite" className="space-y-4">
        <p className="text-[12.5px] text-text-3">{longDate(date)}</p>
        <Trace>
          {live.stage === 'collect' ? (
            <TraceLine status="running">
              <TraceTitle>{t('reader.collecting')}</TraceTitle>
            </TraceLine>
          ) : (
            <TraceLine>
              <TraceTitle>{t('reader.read', { count: live.emailCount ?? 0 })}</TraceTitle>
            </TraceLine>
          )}
        </Trace>
        {live.stage === 'write' && <AiMarkdown markdown={live.markdown ?? ''} streaming className="text-[14px]" />}
        <Button variant="ghost" size="sm" className="text-text-3" onClick={() => cancelSummaryJob()}>
          <Square /> {t('actions.stop')}
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        {error && (
          <div role="alert" className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-start gap-2.5 text-[13px] text-text-1">
              <AlertCircle className="mt-px size-4 shrink-0 text-destructive" />
              <p className="min-w-0 flex-1">{error}</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 ps-6.5">
              <Button size="sm" variant="outline" onClick={() => startSummaryJob(date)}>
                {t('error.retry')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openSettings('ai')}>
                {t('error.settings')}
              </Button>
            </div>
          </div>
        )}
        {summary ? (
          <SummaryView summary={summary} />
        ) : (
          !error && summaries && <EmptyState icon={<Newspaper />} title={t('reader.pick')} />
        )}
      </>
    );
  }

  return (
    <section aria-label={t('reader.region')} className={cn('flex min-h-0 min-w-0 flex-col bg-panel', className)}>
      {mobile && date && (
        <div className="flex shrink-0 items-center px-2 pt-2">
          <IconButton label={t('reader.back')} onClick={() => goSummaries()}>
            <ArrowLeft className="rtl:-scale-x-100" />
          </IconButton>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className={cn('mx-auto w-full max-w-[720px] px-6 py-6', !date && 'flex flex-1 items-center justify-center')}>{body}</div>
      </div>
    </section>
  );
}

function SummaryView({ summary }: { summary: AiSummary }) {
  const { t } = useTranslation('ai-summaries');
  const running = useSummaryJob((s) => s.date !== null && s.progress !== null);

  const resolveRef = useCallback(
    (ref: string): AiRef | null => {
      const s = summary.sources.find((x) => x.ref === ref);
      return s ? { label: senderName(s.from), title: s.subject, onOpen: () => openSource(s) } : null;
    },
    [summary.sources],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`# ${summary.title}\n\n${summary.markdown}`);
      toast(t('actions.copied'));
    } catch {
      /* presse-papiers refusé */
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({ title: t('actions.deleteTitle'), confirmLabel: t('actions.delete'), destructive: true });
    if (!ok) return;
    await deleteSummary(summary.id);
    goSummaries();
  };

  const meta = [t('reader.generatedAt', { time: shortTime(summary.createdAt) }), t('list.emails', { count: summary.emailCount }), summary.model ? shortModelName(summary.model) : null].filter(Boolean);

  return (
    <article>
      <p className="text-[12.5px] text-text-3">{longDate(summary.id)}</p>
      <div className="mt-1 flex items-start gap-3">
        <h1 dir="auto" className="min-w-0 flex-1 text-[22px] font-semibold tracking-[-0.01em] text-text-1">
          {summary.title}
        </h1>
        <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
          <IconButton label={t('actions.regenerate')} disabled={running} onClick={() => startSummaryJob(summary.id)}>
            <RotateCcw />
          </IconButton>
          <IconButton label={t('actions.copy')} onClick={() => void copy()}>
            <Copy />
          </IconButton>
          <IconButton label={t('actions.delete')} onClick={() => void remove()}>
            <Trash2 />
          </IconButton>
        </div>
      </div>
      <p className="mt-1 text-[12px] text-text-3">{meta.join(' · ')}</p>
      <AiMarkdown markdown={summary.markdown} resolveRef={resolveRef} className="mt-5 text-[14px]" />
      {summary.sources.length > 0 && (
        <Collapsible className="mt-8 border-t border-line pt-4">
          <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-md text-[13px] font-medium text-text-2 outline-none hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent">
            <ChevronRight className="size-3.5 transition-transform duration-150 group-data-[state=open]:rotate-90 rtl:-scale-x-100 rtl:group-data-[state=open]:-rotate-90" />
            {t('reader.sources', { count: summary.sources.length })}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 space-y-px">
              {summary.sources.map((s) => (
                <li key={s.ref}>
                  <button
                    type="button"
                    onClick={() => openSource(s)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-[13px] outline-none voxel-transition hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-voxel-accent"
                  >
                    <span className="shrink-0 rounded-md bg-voxel-accent-soft px-1.5 text-[11px] font-medium text-voxel-accent-strong tabular-nums">{s.ref}</span>
                    <span dir="auto" className="max-w-[35%] shrink-0 truncate font-medium text-text-1">
                      {senderName(s.from)}
                    </span>
                    <span dir="auto" className="min-w-0 flex-1 truncate text-text-2">
                      {s.subject}
                    </span>
                    <span className="shrink-0 text-[12px] text-text-3 tabular-nums">{shortTime(s.receivedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </article>
  );
}
