import { useTranslation } from 'react-i18next';
import { useChat } from '@ai-sdk/react';
import { PenLine, Search } from 'lucide-react';
import { SenderAvatar } from '@/components/common/bits';
import { startCompose } from '@/components/compose/startCompose';
import { getChat } from '@/lib/ai/chat';
import type { ContactsResult } from '@/lib/ai/tools';
import { useAiChat } from '@/store/aiChat';

const ACTION =
  'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-text-2 hover:bg-row-hover hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent outline-none disabled:pointer-events-none disabled:opacity-40';

/** Contacts trouvés : un clic choisit le contact (réponse à « lequel ? »). */
export function ContactResults({ result }: { result: ContactsResult }) {
  const { t } = useTranslation('ai-chat');
  const { status } = useChat({ chat: getChat() });
  const busy = status === 'submitted' || status === 'streaming';
  if (!result.items.length) return <p className="text-[13px] text-text-3">{t('contacts.none')}</p>;
  // par ask() : attend l'arrêt d'une génération en cours
  const send = (text: string) => useAiChat.getState().ask(text);

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {result.items.map((c) => {
        const name = c.name || c.email;
        return (
          <div key={c.email} className="flex flex-col gap-1.5 rounded-xl border border-line p-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => send(t('contacts.pick', { name, email: c.email }))}
              className="flex min-w-0 items-center gap-2.5 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-voxel-accent disabled:cursor-default"
            >
              <SenderAvatar name={c.name ?? ''} email={c.email} size={32} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-medium text-text-1">{name}</span>
                <span className="truncate text-[12px] text-text-3" dir="ltr">
                  {c.email}
                </span>
              </span>
            </button>
            <div className="flex items-center gap-1">
              <button type="button" className={ACTION} onClick={() => startCompose({ to: [{ name: c.name ?? '', email: c.email }] })}>
                <PenLine className="size-3" />
                {t('contacts.write')}
              </button>
              <button type="button" className={ACTION} disabled={busy} onClick={() => send(t('contacts.emailsPrompt', { name, email: c.email }))}>
                <Search className="size-3" />
                {t('contacts.emails')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
