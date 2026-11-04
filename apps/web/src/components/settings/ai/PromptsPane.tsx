import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAccounts } from '@/hooks/useData';
import { systemPromptText, useAiSettings } from '@/lib/ai/store';
import type { SystemPromptKey } from '@/lib/ai/types';
import { cn } from '@/lib/utils';
import { MailboxPicker, usePickedMailbox } from '../MailboxPicker';
import { SectionIntro, inputCls } from '../ui';
import { TemplatesEditor } from './TemplatesEditor';

const KEYS: SystemPromptKey[] = ['base', 'chat', 'writing', 'summary', 'planner'];
const VARIABLES = ['language', 'date', 'user', 'mailboxes', 'mailbox_style'] as const;

/** Zone de texte enregistrée 400 ms après la dernière frappe et à la perte du focus. */
function DebouncedTextarea({ value, onCommit, className, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<ComponentProps<'textarea'>, 'value' | 'onChange'>) {
  const [local, setLocal] = useState(value);
  const sent = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const localRef = useRef(local);
  localRef.current = local;

  // valeur changée ailleurs (Rétablir) : la reprendre
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setLocal(value);
    }
  }, [value]);

  const flush = () => {
    clearTimeout(timer.current);
    if (localRef.current !== sent.current) {
      sent.current = localRef.current;
      commitRef.current(localRef.current);
    }
  };

  // fermeture du dialogue pendant la frappe : ne rien perdre
  useEffect(() => flush, []);

  return (
    <textarea
      {...rest}
      className={cn(inputCls, 'h-auto resize-y py-2', className)}
      value={local}
      onChange={(e) => {
        setLocal(e.target.value);
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, 400);
      }}
      onBlur={flush}
    />
  );
}

export function PromptsPane() {
  const { t } = useTranslation('ai');
  return (
    <div className="space-y-8">
      <section>
        <h3 className="mb-2 text-[14px] font-semibold text-text-1">{t('settings.prompts.systemTitle')}</h3>
        <SectionIntro>{t('settings.prompts.intro')}</SectionIntro>
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="me-1 text-[12px] text-text-3">{t('settings.prompts.variables')}</span>
          {VARIABLES.map((v) => (
            <code key={v} dir="ltr" title={t(`settings.prompts.vars.${v}`)} className="cursor-help rounded-md border border-line px-1.5 py-0.5 font-mono text-[11.5px] text-text-2">
              {`{{${v}}}`}
            </code>
          ))}
        </div>
        <div className="space-y-5">
          {KEYS.map((k) => (
            <SystemPromptEditor key={k} promptKey={k} />
          ))}
        </div>
      </section>
      <MailboxStyle />
      <section>
        <h3 className="mb-3 text-[14px] font-semibold text-text-1">{t('settings.prompts.templatesTitle')}</h3>
        <TemplatesEditor />
      </section>
    </div>
  );
}

function SystemPromptEditor({ promptKey }: { promptKey: SystemPromptKey }) {
  const { t } = useTranslation('ai');
  const value = useAiSettings((s) => systemPromptText(promptKey, s));
  const modified = useAiSettings((s) => s.systemPrompts[promptKey] !== undefined);
  const setSystemPrompt = useAiSettings((s) => s.setSystemPrompt);
  const resetSystemPrompt = useAiSettings((s) => s.resetSystemPrompt);
  const title = t(`settings.prompts.keys.${promptKey}.title`);
  return (
    <div>
      <div className="mb-1.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium text-text-1">{title}</span>
            {modified && <span className="rounded-md bg-voxel-accent-soft px-1.5 text-[11px] text-voxel-accent-strong">{t('settings.prompts.modified')}</span>}
          </div>
          <div className="mt-0.5 text-[12.5px] text-text-2">{t(`settings.prompts.keys.${promptKey}.description`)}</div>
        </div>
        <Button variant="ghost" size="sm" disabled={!modified} onClick={() => resetSystemPrompt(promptKey)}>
          <RotateCcw /> {t('settings.prompts.reset')}
        </Button>
      </div>
      <DebouncedTextarea
        aria-label={title}
        dir="ltr"
        rows={8}
        spellCheck={false}
        className="font-mono text-[12.5px] leading-relaxed"
        value={value}
        onCommit={(v) => setSystemPrompt(promptKey, v)}
      />
    </div>
  );
}

function MailboxStyle() {
  const { t } = useTranslation('ai');
  const { data } = useAccounts();
  const accounts = data ?? [];
  const [accountId, setAccountId] = usePickedMailbox(accounts);
  const style = useAiSettings((s) => s.mailboxStyles[accountId] ?? '');
  const setMailboxStyle = useAiSettings((s) => s.setMailboxStyle);
  if (!accountId) return null;
  return (
    <section>
      <h3 className="mb-3 text-[14px] font-semibold text-text-1">{t('settings.prompts.styleTitle')}</h3>
      <MailboxPicker accounts={accounts} value={accountId} onChange={setAccountId} label={t('settings.prompts.mailbox')} />
      <DebouncedTextarea
        key={accountId}
        aria-label={t('settings.prompts.styleTitle')}
        dir="auto"
        rows={3}
        placeholder={t('settings.prompts.stylePlaceholder')}
        value={style}
        onCommit={(v) => setMailboxStyle(accountId, v)}
      />
      <p className="mt-1 text-[11.5px] text-text-3">{t('settings.prompts.styleHint')}</p>
    </section>
  );
}
