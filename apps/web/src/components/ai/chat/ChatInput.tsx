import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Mic, Square } from 'lucide-react';
import { IconButton } from '@/components/common/bits';
import { ModelPicker } from '@/components/ai/ModelPicker';
import { useDictation } from '@/hooks/useDictation';
import { cn } from '@/lib/utils';
import { useUi } from '@/store/ui';
import { useAiChat } from '@/store/aiChat';

/** Arrête la génération (le moteur est déjà chargé quand une génération tourne). */
function stopChat() {
  void import('@/lib/ai/chat').then(({ getChat }) => getChat().stop());
}

const MAX_LINES = 6;
const LINE = 21; // 13.5px × leading 1.55 environ

/** Saisie du mode discussion. */
export function ChatInput() {
  const { t, i18n } = useTranslation('ai-chat');
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const draft = useAiChat((s) => s.draft);
  const setDraft = useAiChat((s) => s.setDraft);
  const ask = useAiChat((s) => s.ask);
  const closeChat = useAiChat((s) => s.closeChat);
  const tick = useUi((s) => s.searchFocusTick);
  const busy = useAiChat((s) => s.busy);
  const dictation = useDictation({
    language: i18n.resolvedLanguage ?? 'en',
    onFinal: (said) => setText((cur) => (cur && !/\s$/.test(cur) ? `${cur} ${said}` : `${cur}${said}`)),
  });
  const listening = dictation.state === 'listening' || dictation.state === 'connecting';

  // texte proposé (suggestion « sans envoi ») : il remplace la saisie
  useEffect(() => {
    if (!draft) return;
    setText(draft);
    setDraft('');
    requestAnimationFrame(() => {
      const el = area.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }, [draft, setDraft]);
  useEffect(() => {
    area.current?.focus();
  }, []);
  useEffect(() => {
    if (tick) area.current?.focus();
  }, [tick]);

  // hauteur automatique (repli si `field-sizing: content` n'est pas pris en charge)
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || CSS.supports('field-sizing', 'content')) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES * LINE + 8)}px`;
  }, [text]);

  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    if (listening) dictation.stop();
    ask(value);
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (busy) stopChat();
      else if (!text) closeChat();
    }
  };

  return (
    <div
      onClick={() => area.current?.focus()}
      className="flex flex-col gap-1 rounded-[12px] border border-voxel-accent bg-panel px-2.5 pt-2 pb-1.5 shadow-[0_0_0_3px_var(--voxel-accent-soft)]"
    >
      <div className="relative">
        <textarea
          ref={area}
          rows={1}
          value={text}
          dir="auto"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={t('input.placeholder')}
          aria-label={t('input.placeholder')}
          className="block max-h-[134px] min-h-[21px] w-full resize-none bg-transparent px-1 text-[13.5px] leading-[1.55] text-text-1 outline-none [field-sizing:content] placeholder:text-text-3"
        />
        {dictation.interim && (
          <p aria-live="polite" className="px-1 text-[13.5px] leading-[1.55] text-text-3" dir="auto">
            {dictation.interim}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1">
        <ModelPicker feature="chat" side="top" />
        <div className="flex-1" />
        {dictation.available && (
          <IconButton
            size="sm"
            side="top"
            label={listening ? t('input.stopDictation') : t('input.dictate')}
            aria-pressed={listening}
            onClick={(e) => {
              e.stopPropagation();
              dictation.toggle();
            }}
            className={cn(listening && 'animate-pulse text-danger hover:text-danger')}
          >
            <Mic />
          </IconButton>
        )}
        {busy ? (
          <button
            type="button"
            aria-label={t('input.stop')}
            title={t('input.stop')}
            onClick={(e) => {
              e.stopPropagation();
              stopChat();
            }}
            className="voxel-btn-primary flex size-7 items-center justify-center rounded-lg focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:ring-offset-1 outline-none"
          >
            <Square className="size-3 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={t('input.send')}
            title={t('input.send')}
            disabled={!text.trim()}
            onClick={(e) => {
              e.stopPropagation();
              send();
            }}
            className="voxel-btn-primary flex size-7 items-center justify-center rounded-lg focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:ring-offset-1 outline-none disabled:pointer-events-none disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
