import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { Copy, RotateCcw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { IconButton } from '@/components/common/bits';
import { AiMarkdown, type AiRef } from '@/components/ai/AiMarkdown';
import type { ChatMessage } from '@/lib/ai/chat';
import { shortModelName } from '@/lib/ai/errors';
import { resolveRef } from '@/lib/ai/refs';
import { openHit } from '@/components/ai/openHit';
import { tFast } from '@/lib/motion';
import { ReasoningLine } from './parts/ReasoningLine';
import { TraceRow, ToolLine, searchTitle } from './parts/ToolLine';
import { EmailResults } from './parts/EmailResults';
import { ContactResults } from './parts/ContactResults';

/** Références `[#3]` du texte → puces cliquables qui ouvrent la conversation dans le lecteur. */
function refResolver(ref: string): AiRef | null {
  const hit = resolveRef(ref);
  if (!hit) return null;
  // « Nom <adresse> » → le nom seul, sinon l'adresse
  const name = hit.from.replace(/\s*<[^>]*>\s*$/, '').trim() || hit.from.replace(/^<|>$/g, '').trim() || ref;
  return {
    label: name,
    title: hit.subject ? `${name} — ${hit.subject}` : name,
    onOpen: () => openHit({ accountId: hit.accountId, threadId: hit.threadId }),
  };
}

const textOf = (m: ChatMessage) =>
  m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n\n');

export function ChatMessageView({ message, streaming, last, onRegenerate }: { message: ChatMessage; streaming: boolean; last: boolean; onRegenerate: () => void }) {
  const { t } = useTranslation('ai-chat');

  if (message.role === 'user')
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={tFast} className="flex">
        <div dir="auto" className="ms-auto w-fit max-w-[85%] rounded-2xl rounded-ee-md bg-voxel-accent-soft px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-text-1">
          {textOf(message)}
        </div>
      </motion.div>
    );

  const text = textOf(message);
  const model = message.metadata?.model;

  return (
    <div className="group/message flex flex-col gap-2.5">
      {message.parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        const node = (() => {
          switch (part.type) {
            case 'reasoning':
              return <ReasoningLine text={part.text} running={part.state === 'streaming'} />;
            case 'tool-search_emails':
              return (
                <>
                  <ToolLine part={part} />
                  {part.state === 'output-available' && <EmailResults result={part.output} />}
                </>
              );
            case 'tool-find_contacts':
              return (
                <>
                  <ToolLine part={part} />
                  {part.state === 'output-available' && <ContactResults result={part.output} />}
                </>
              );
            case 'tool-open_email':
              return (
                <>
                  <ToolLine part={part} />
                  {part.state === 'output-available' && <EmailResults result={{ input: {}, total: 1, items: [part.output] }} single />}
                </>
              );
            case 'tool-read_email':
            case 'tool-compose_email':
              return <ToolLine part={part} />;
            case 'data-emails':
              return (
                <>
                  <TraceRow icon={Search} title={searchTitle(part.data.input, t)} description={t('tools.count', { count: part.data.total })} />
                  <EmailResults result={part.data} />
                </>
              );
            case 'data-contacts':
              return <ContactResults result={part.data} />;
            case 'text':
              return part.text ? <AiMarkdown markdown={part.text} streaming={part.state === 'streaming'} resolveRef={refResolver} /> : null;
            default:
              return null;
          }
        })();
        if (!node) return null;
        return (
          <motion.div key={key} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={tFast} className="flex min-w-0 flex-col gap-2.5">
            {node}
          </motion.div>
        );
      })}
      {!streaming && (text || model) && (
        <div className="flex items-center gap-0.5 opacity-0 voxel-transition group-hover/message:opacity-100 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100">
          {text && (
            <IconButton
              size="sm"
              label={t('message.copy')}
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => toast(t('message.copied')));
              }}
            >
              <Copy />
            </IconButton>
          )}
          {last && (
            <IconButton size="sm" label={t('message.regenerate')} onClick={onRegenerate}>
              <RotateCcw />
            </IconButton>
          )}
          {model && <span className="ms-1.5 truncate text-[11.5px] text-text-3">{shortModelName(model)}</span>}
        </div>
      )}
    </div>
  );
}
