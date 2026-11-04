import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAccounts, useIdentities } from '@/hooks/useData';
import { effectiveTemplates, templateLabel, useAiSettings } from '@/lib/ai/store';
import { tFast } from '@/lib/motion';
import { useAiChat } from '@/store/aiChat';

/** Discussion vide : salutation et suggestions (modèles de prompts « chat »). */
export function ChatEmpty() {
  const { t } = useTranslation('ai-chat');
  const { data: accounts } = useAccounts();
  // abonnement aux modèles : la liste suit les réglages
  const templates = useAiSettings((s) => s.templates);
  const ask = useAiChat((s) => s.ask);
  const setDraft = useAiChat((s) => s.setDraft);
  const account = accounts?.[0];
  const { data: identities } = useIdentities(account?.id);
  // nom de la boîte, sinon celui de la première identité, sinon salutation sans nom
  const fullName = account?.displayName?.trim() || identities?.[0]?.name?.trim();
  const name = fullName ? fullName.split(/\s+/)[0] : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => effectiveTemplates('chat'), [templates]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={tFast}
      className="flex min-h-[50%] flex-col items-center justify-center gap-3 py-10 text-center"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-voxel-accent-soft text-voxel-accent-strong">
        <Sparkles className="size-5" />
      </span>
      <p className="text-[17px] font-semibold text-text-1">{name ? t('empty.greeting', { name }) : t('empty.greetingAnonymous')}</p>
      <p className="max-w-[420px] text-[13.5px] text-text-2">{t('empty.subtitle')}</p>
      {list.length > 0 && (
        <div className="mt-1 flex max-w-[520px] flex-wrap justify-center gap-2">
          {list.map((tpl) => (
            <Button key={tpl.id} variant="outline" size="sm" onClick={() => (tpl.send ? ask(tpl.prompt) : setDraft(tpl.prompt))}>
              {templateLabel(tpl)}
            </Button>
          ))}
        </div>
      )}
      <p className="mt-2 max-w-[420px] text-[12px] text-text-3">{t('empty.tip')}</p>
    </motion.div>
  );
}
