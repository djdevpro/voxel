import { LoaderCircle, Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/components/common/bits';
import { cn } from '@/lib/utils';
import type { useDictation } from '@/hooks/useDictation';

type Dictation = ReturnType<typeof useDictation>;

/** Bouton micro du pied de l'éditeur : démarre ou arrête la dictée. */
export function DictationButton({ dictation }: { dictation: Dictation }) {
  const { t } = useTranslation('ai-compose');
  if (!dictation.available) return null;
  const listening = dictation.state === 'listening';
  const connecting = dictation.state === 'connecting';
  return (
    <IconButton
      label={listening || connecting ? t('dictation.stop') : t('dictation.start')}
      aria-pressed={listening}
      onClick={dictation.toggle}
      className="relative"
    >
      {listening && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-md bg-danger/15 transition-transform duration-100"
          style={{ transform: `scale(${1 + dictation.level * 0.6})` }}
        />
      )}
      {connecting ? <LoaderCircle className="animate-spin" /> : <Mic className={cn('relative', listening && 'text-danger')} />}
    </IconButton>
  );
}

/** Pastille de transcription au-dessus du pied, pendant la connexion et l'écoute. */
export function DictationPill({ dictation }: { dictation: Dictation }) {
  const { t } = useTranslation('ai-compose');
  const listening = dictation.state === 'listening';
  if (!listening && dictation.state !== 'connecting') return null;
  return (
    <div
      aria-live="polite"
      className="mx-3 mb-2 flex items-center gap-2 rounded-lg bg-black/[0.04] px-3 py-1.5 text-[12.5px] dark:bg-white/[0.05]"
    >
      <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-danger" />
      {listening && dictation.interim ? (
        <span className="truncate italic text-text-3" dir="auto">
          {dictation.interim}
        </span>
      ) : (
        <span className="text-text-2">{listening ? t('dictation.listening') : t('dictation.connecting')}</span>
      )}
    </div>
  );
}
