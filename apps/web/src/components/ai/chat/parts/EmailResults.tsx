import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flag, ListFilter, Paperclip } from 'lucide-react';
import { AccountDot, SenderAvatar } from '@/components/common/bits';
import { useAccounts } from '@/hooks/useData';
import { useNav } from '@/nav/useNav';
import { applySearch } from '@/nav/nav';
import { openHit } from '../../openHit';
import { listDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { EmailsResult } from '@/lib/ai/tools';
import { useAiChat } from '@/store/aiChat';
import { searchToQuery } from '../searchChips';

const FIRST = 5;

/** Carte des e-mails trouvés : un clic ouvre la conversation dans le lecteur, sans quitter la discussion. */
/** `single` : carte d'une seule conversation (outil `open_email`), sans en-tête ni pied. */
export function EmailResults({ result, single }: { result: EmailsResult; single?: boolean }) {
  const { t } = useTranslation('ai-chat');
  const { data: accounts } = useAccounts();
  const current = useNav().thread;
  const closeChat = useAiChat((s) => s.closeChat);
  const [all, setAll] = useState(false);
  const multi = (accounts?.length ?? 0) > 1;
  const items = all ? result.items : result.items.slice(0, FIRST);

  if (!result.items.length) return <p className="text-[13px] text-text-3">{t('results.none')}</p>;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      {!single && <div className="border-b border-line px-3 py-2 text-[11.5px] font-medium tracking-wide text-text-3 uppercase">{t('results.count', { count: result.total })}</div>}
      <ul>
        {items.map((h) => {
          const sender = h.from?.name || h.from?.email || '';
          const color = multi ? accounts?.find((a) => a.id === h.accountId)?.color : undefined;
          const active = current?.accountId === h.accountId && current.threadId === h.threadId;
          return (
            <li key={`${h.accountId}:${h.threadId}`} className="border-b border-line/70 last:border-b-0">
              <button
                type="button"
                aria-label={[sender, h.subject, listDate(h.receivedAt)].filter(Boolean).join(', ')}
                aria-current={active || undefined}
                onClick={() => openHit({ accountId: h.accountId, threadId: h.threadId })}
                className={cn(
                  'flex w-full items-start gap-3 px-3 py-2 text-start voxel-transition outline-none focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:ring-inset',
                  active ? 'bg-row-selected' : 'hover:bg-row-hover',
                )}
              >
                <SenderAvatar name={h.from?.name ?? ''} email={h.from?.email ?? sender} size={28} className="mt-0.5" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    {h.unread && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-voxel-accent" />}
                    <span className={cn('min-w-0 truncate text-[13px] text-text-1', h.unread ? 'font-semibold' : 'font-medium')}>{sender}</span>
                    <span className="ms-auto flex shrink-0 items-center gap-1.5 text-[11.5px] text-text-3 tabular">
                      {h.hasAttachment && <Paperclip className="size-3" />}
                      {h.flagged && <Flag className="size-3 fill-flag text-flag" />}
                      {color && <AccountDot color={color} />}
                      {listDate(h.receivedAt)}
                    </span>
                  </span>
                  <span className={cn('truncate text-[12.5px]', h.unread ? 'text-text-1' : 'text-text-2')}>{h.subject}</span>
                  {h.preview && <span className="truncate text-[12px] text-text-3">{h.preview}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!single && (
      <div className="flex items-center gap-2 border-t border-line px-1.5 py-1">
        {!all && result.items.length > FIRST && (
          <button type="button" onClick={() => setAll(true)} className="h-7 rounded-md px-2 text-[12px] font-medium text-voxel-accent-strong hover:bg-row-hover">
            {t('results.showMore', { count: result.items.length - FIRST })}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            closeChat();
            applySearch(searchToQuery(result.input));
          }}
          className="ms-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-text-2 hover:bg-row-hover hover:text-text-1"
        >
          <ListFilter className="size-3.5" />
          {t('results.showInList')}
        </button>
      </div>
      )}
    </div>
  );
}
