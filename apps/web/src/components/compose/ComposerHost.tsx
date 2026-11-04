import { AnimatePresence, motion } from 'motion/react';
import { Maximize2, Minimize2, Minus, X, ChevronUp } from 'lucide-react';
import { threadKey, useUi, type ComposerState } from '@/store/ui';
import { useNav } from '@/nav/useNav';
import { Composer, ComposerTitle, requestCloseComposer } from './Composer';
import { IconButton } from '@/components/common/bits';
import { cn } from '@/lib/utils';
import { tBase, tSpring } from '@/lib/motion';
import { useIsMobile } from '@/hooks/useEnvironment';
import { useTranslation } from 'react-i18next';

function WindowHeader({ c, compact }: { c: ComposerState; compact?: boolean }) {
  const update = useUi((s) => s.updateComposer);
  const { t } = useTranslation('compose');
  return (
    <div
      className={cn(
        'flex shrink-0 cursor-default items-center gap-1 pe-1.5 ps-4 select-none',
        compact ? 'h-11' : 'h-11 border-b border-line',
        c.minimized ? 'bg-text-1 text-app' : 'bg-panel text-text-1',
      )}
      onClick={() => !c.fullscreen && update(c.id, { minimized: !c.minimized })}
      onDoubleClick={() => update(c.id, { fullscreen: !c.fullscreen, minimized: false })}
    >
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
        <ComposerTitle state={c} />
      </span>
      <div className={cn('flex items-center', c.minimized && '[&_button]:text-app/70 [&_button:hover]:bg-white/10 [&_button:hover]:text-app dark:[&_button:hover]:bg-black/10')} onClick={(e) => e.stopPropagation()}>
        <IconButton label={c.minimized ? t('window.expand') : t('window.minimize')} size="sm" onClick={() => update(c.id, { minimized: !c.minimized, fullscreen: false })}>
          {c.minimized ? <ChevronUp /> : <Minus />}
        </IconButton>
        <IconButton label={c.fullscreen ? t('window.exitFullscreen') : t('window.fullscreen')} size="sm" onClick={() => update(c.id, { fullscreen: !c.fullscreen, minimized: false })}>
          {c.fullscreen ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton label={t('window.closeKeep')} size="sm" onClick={() => requestCloseComposer(c.id)}>
          <X />
        </IconButton>
      </div>
    </div>
  );
}

export function ComposerHost() {
  const composers = useUi((s) => s.composers);
  const openThread = useNav().thread;
  const update = useUi((s) => s.updateComposer);
  const mobile = useIsMobile();
  const { t } = useTranslation('compose');
  const openKey = openThread ? threadKey(openThread.accountId, openThread.threadId) : null;
  const floating = composers.filter((c) => !c.inline || c.inline.threadKey !== openKey || mobile);
  const docked = floating.filter((c) => !c.fullscreen);
  const full = floating.find((c) => c.fullscreen && !c.minimized);

  if (mobile) {
    const active = floating.find((c) => !c.minimized) ?? null;
    return (
      <AnimatePresence>
        {active && (
          <motion.div
            key={active.id}
            className="fixed inset-0 z-50 flex flex-col bg-panel pt-[env(safe-area-inset-top)]"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={tSpring}
          >
            <div className="flex h-12 items-center gap-1 border-b border-line px-2">
              <IconButton label={t('common:actions.close')} onClick={() => requestCloseComposer(active.id)}>
                <X />
              </IconButton>
              <span className="flex-1 truncate text-[14px] font-semibold">
                <ComposerTitle state={active} />
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <Composer state={active} floating />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <>
      <div className="pointer-events-none fixed end-4 bottom-0 z-40 flex flex-row-reverse items-end gap-3">
        <AnimatePresence initial={false}>
          {docked.map((c) => (
            <motion.div
              key={c.id}
              layout
              initial={{ opacity: 0, y: 28, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.98 }}
              transition={tSpring}
              className={cn(
                'pointer-events-auto flex flex-col overflow-hidden rounded-t-xl border border-b-0 border-(--voxel-float-border) bg-panel shadow-(--voxel-float-shadow)',
                c.minimized ? 'w-[300px]' : 'h-[min(640px,calc(100vh-72px))] w-[560px]',
              )}
              role="dialog"
              aria-label={t('window.label')}
            >
              <WindowHeader c={c} compact={c.minimized} />
              {!c.minimized && (
                <div className="min-h-0 flex-1">
                  <Composer state={c} floating />
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {full && (
          <motion.div
            key="overlay"
            className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(12_10_9/0.36)] p-6 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tBase}
            onMouseDown={(e) => e.target === e.currentTarget && update(full.id, { fullscreen: false })}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 10 }}
              transition={tSpring}
              className="flex h-[min(860px,92vh)] w-[min(1000px,94vw)] flex-col overflow-hidden rounded-2xl border border-(--voxel-float-border) bg-panel shadow-(--voxel-float-shadow)"
              role="dialog"
              aria-modal
              aria-label={t('window.fullscreenLabel')}
            >
              <WindowHeader c={full} />
              <div className="min-h-0 flex-1">
                <Composer state={full} floating />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
