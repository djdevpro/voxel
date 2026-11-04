import { useEffect, useRef, useState } from 'react';
import { Copy, MessageSquareText, RotateCcw, Settings2, Sparkles, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/common/bits';
import { AiMarkdown } from '@/components/ai/AiMarkdown';
import { modelRefFor, useAiSettings } from '@/lib/ai/store';
import { shortModelName } from '@/lib/ai/errors';
import { openSettings } from '@/nav/nav';
import type { AiWriting } from './useAiWriting';

/** Panneau du résultat d'une demande d'écriture (ou saisie d'une instruction libre), au-dessus du pied. */
export function AiSuggestionPanel({ writing }: { writing: AiWriting }) {
  const { t } = useTranslation('ai-compose');
  const model = useAiSettings((s) => modelRefFor('writing', s)?.model);
  const { run, prompting } = writing;
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!prompting) return;
    setValue('');
    // après la fermeture du menu, qui rend le focus
    const id = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [prompting]);

  const streaming = run?.status === 'streaming';

  return (
    <div
      className="mx-3 mb-2 overflow-hidden rounded-xl border border-s-2 border-line border-s-voxel-accent bg-panel shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          writing.close();
        }
      }}
    >
      {/* en-tête */}
      <div className="flex h-9 items-center gap-2 border-b border-line ps-3 pe-1 text-[12.5px]">
        {prompting ? (
          <>
            <MessageSquareText className="size-3.5 shrink-0 text-voxel-accent-strong" />
            <input
              ref={input}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && value.trim()) {
                  e.preventDefault();
                  writing.start(t('menu.custom'), value.trim());
                }
              }}
              placeholder={t('panel.customPlaceholder')}
              aria-label={t('menu.custom')}
              dir="auto"
              className="h-full min-w-0 flex-1 bg-transparent text-text-1 outline-none placeholder:text-text-3"
            />
          </>
        ) : (
          <>
            <Sparkles className="size-3.5 shrink-0 text-voxel-accent-strong" />
            <span className="truncate font-medium text-text-1" dir="auto">
              {run?.label}
            </span>
            {model && <span className="truncate text-text-3">· {shortModelName(model)}</span>}
            <span className="flex-1" />
          </>
        )}
        <IconButton label={t('panel.close')} size="sm" side="top" onClick={writing.close}>
          <X />
        </IconButton>
      </div>

      {run && (
        <>
          {/* texte */}
          <div className="max-h-56 overflow-y-auto px-3 py-2" aria-live="polite" aria-busy={streaming || undefined}>
            {run.status === 'error' ? (
              <p className="text-[13px] text-danger">{run.error}</p>
            ) : (
              <>
                {run.markdown && <AiMarkdown markdown={run.markdown} streaming={streaming} />}
                {streaming && <p className="shimmer text-[12.5px] text-text-3">{t('panel.writing')}</p>}
              </>
            )}
          </div>

          {/* pied */}
          <div className="flex h-11 items-center gap-1.5 border-t border-line px-2">
            {streaming ? (
              <Button size="sm" variant="outline" onClick={writing.stop}>
                <Square className="size-3" /> {t('panel.stop')}
              </Button>
            ) : run.status === 'error' ? (
              <>
                <Button size="sm" variant="outline" onClick={writing.retry}>
                  <RotateCcw /> {t('panel.retry')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openSettings('ai')}>
                  <Settings2 /> {t('panel.settings')}
                </Button>
              </>
            ) : (
              <>
                <span title={writing.stale ? t('panel.stale') : undefined}>
                  <Button size="sm" onClick={writing.replace} disabled={!run.markdown || writing.stale}>
                    {run.target.kind === 'selection' ? t('panel.replaceSelection') : t('panel.replace')}
                  </Button>
                </span>
                <Button size="sm" variant="outline" onClick={writing.insertBelow} disabled={!run.markdown}>
                  {t('panel.insert')}
                </Button>
                <IconButton label={t('panel.retry')} side="top" onClick={writing.retry} className="ms-1">
                  <RotateCcw />
                </IconButton>
                <IconButton label={t('panel.copy')} side="top" onClick={() => void writing.copy()} disabled={!run.markdown}>
                  <Copy />
                </IconButton>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
