import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useChat } from '@ai-sdk/react';
import { motion } from 'motion/react';
import { AlertCircle, LoaderCircle, RotateCcw, Settings } from 'lucide-react';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Trace, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import { Button } from '@/components/ui/button';
import { getChat } from '@/lib/ai/chat';
import { describeAiError } from '@/lib/ai/errors';
import { openSettings } from '@/nav/nav';
import { useAiChat } from '@/store/aiChat';
import { tFast } from '@/lib/motion';
import { ChatEmpty } from './ChatEmpty';
import { ChatMessageView } from './ChatMessageView';

function PendingLine() {
  const { t } = useTranslation('ai-chat');
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={tFast}>
      <Trace className="text-[13px]">
        <TraceLine status="running">
          <TraceIcon>
            <LoaderCircle className="animate-spin" />
          </TraceIcon>
          <TraceTitle>{t('reasoning.running')}</TraceTitle>
        </TraceLine>
      </Trace>
    </motion.div>
  );
}

function ChatError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation('ai-chat');
  // message classé ; le message brut seulement pour une erreur inconnue qui en a un
  const described = describeAiError(error);
  const message = described.code === 'unknown' && described.detail ? described.detail : described.message || t('ai:errors.unknown');
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={tFast}
      className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/[0.06] p-3 text-[13px]"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-text-1 wrap-break-word">{message}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw />
            {t('error.retry')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openSettings('ai')}>
            <Settings />
            {t('error.settings')}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

/** Fil de la discussion courante. */
export function AiConversation() {
  const { t } = useTranslation('ai-chat');
  const chat = getChat();
  const { messages, status, error, regenerate, clearError } = useChat({ chat });
  const busy = status === 'submitted' || status === 'streaming';
  // la saisie (arbre principal, sans AI SDK) lit l'état de génération dans le store
  useEffect(() => {
    useAiChat.setState({ busy });
    return () => useAiChat.setState({ busy: false });
  }, [busy]);

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport aria-label={t('conversation.label')}>
          <MessageScrollerContent aria-busy={busy} aria-live="polite" className="mx-auto w-full max-w-[760px] gap-6 px-4 py-5">
            {messages.length === 0 && (
              <MessageScrollerItem messageId="empty" className="flex min-h-full flex-col justify-center">
                <ChatEmpty />
              </MessageScrollerItem>
            )}
            {messages.map((m, i) => (
              <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.role === 'user'}>
                <ChatMessageView message={m} streaming={busy && i === messages.length - 1} last={i === messages.length - 1} onRegenerate={() => void regenerate()} />
              </MessageScrollerItem>
            ))}
            {status === 'submitted' && (
              <MessageScrollerItem messageId="pending">
                <PendingLine />
              </MessageScrollerItem>
            )}
            {error && (
              <MessageScrollerItem messageId="error">
                <ChatError
                  error={error}
                  onRetry={() => {
                    clearError();
                    void regenerate();
                  }}
                />
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton label={t('conversation.scrollToEnd')} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
