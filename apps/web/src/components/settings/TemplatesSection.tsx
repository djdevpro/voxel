/**
 * Paramètres → Réponses types (`?settings=templates`) : créer, modifier, supprimer (nom, objet
 * facultatif, corps riche). Par boîte, dans les réglages synchronisés entre appareils : même méthode
 * pour JMAP et IMAP. Insertion depuis le rédacteur (menu « Réponses types » ou Alt+T).
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { FileText, Plus, Trash2 } from 'lucide-react';
import type { MailTemplate } from '@voxel/jmap';
import { useAccounts } from '@/hooks/useData';
import { newTemplateId, saveTemplates, templatesQuery } from '@/lib/templates';
import { errorMessage } from '@/lib/api';
import { RichEditor, type EditorHandle } from '@/components/compose/Editor';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/store/confirm';
import { cn } from '@/lib/utils';
import { MailboxPicker, usePickedMailbox } from './MailboxPicker';
import { Field, SectionIntro, inputCls } from './ui';

export function TemplatesSection() {
  const { t } = useTranslation('settings');
  const { data: all } = useAccounts();
  const accounts = all ?? [];
  const [accountId, setAccountId] = usePickedMailbox(accounts);
  const { data: templates, isLoading } = useQuery({ ...templatesQuery(accountId), enabled: !!accountId });
  const [selected, setSelected] = useState<string | 'new' | null>(null);

  useEffect(() => {
    if (!templates) return;
    if (!selected || (selected !== 'new' && !templates.some((x) => x.id === selected))) setSelected(templates[0]?.id ?? 'new');
  }, [templates, selected]);

  const current = selected === 'new' ? null : (templates?.find((x) => x.id === selected) ?? null);

  const save = async (tpl: MailTemplate) => {
    const list = templates ?? [];
    const next = list.some((x) => x.id === tpl.id) ? list.map((x) => (x.id === tpl.id ? tpl : x)) : [...list, tpl];
    await saveTemplates(accountId, next);
    setSelected(tpl.id);
  };

  const remove = async (tpl: MailTemplate) => {
    const ok = await confirmDialog({ title: t('templates.deleteTitle', { name: tpl.name }), confirmLabel: t('templates.delete'), destructive: true });
    if (!ok) return;
    try {
      await saveTemplates(accountId, (templates ?? []).filter((x) => x.id !== tpl.id));
      setSelected(null);
      toast(t('templates.deleted'));
    } catch (e) {
      toast.error(t('templates.failed'), { description: errorMessage(e) });
    }
  };

  return (
    <div>
      <SectionIntro>{t('templates.intro')}</SectionIntro>
      <MailboxPicker
        accounts={accounts}
        value={accountId}
        onChange={(id) => {
          setAccountId(id);
          setSelected(null);
        }}
        label={t('templates.mailbox')}
      />
      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <div className="space-y-1" role="list" aria-label={t('tabs.templates')}>
          {isLoading && [0, 1].map((i) => <div key={i} className="voxel-skeleton h-10" />)}
          {(templates ?? []).map((x) => (
            <div role="listitem" key={x.id}>
              <button
                type="button"
                onClick={() => setSelected(x.id)}
                aria-current={selected === x.id ? 'true' : undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-start voxel-transition',
                  selected === x.id ? 'border-voxel-accent bg-voxel-accent-softer' : 'border-line hover:border-line-strong',
                )}
              >
                <FileText className="size-3.5 shrink-0 text-text-3" />
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="block truncate text-[13px] font-medium text-text-1">
                    {x.name}
                  </span>
                  {x.subject && (
                    <span dir="auto" className="block truncate text-[11.5px] text-text-3">
                      {x.subject}
                    </span>
                  )}
                </span>
              </button>
            </div>
          ))}
          {!isLoading && !templates?.length && <p className="px-1 pb-1 text-[12.5px] text-text-3">{t('templates.empty')}</p>}
          <button
            type="button"
            onClick={() => setSelected('new')}
            className={cn('flex h-10 w-full items-center gap-2 rounded-lg border border-dashed px-3 text-[13px] text-text-2 voxel-transition hover:text-text-1', selected === 'new' ? 'border-voxel-accent' : 'border-line-strong')}
          >
            <Plus className="size-4" /> {t('templates.new')}
          </button>
        </div>
        {selected && accountId && <TemplateEditor key={`${accountId}:${selected}`} template={current} onSave={save} onDelete={remove} />}
      </div>
    </div>
  );
}

function TemplateEditor({ template, onSave, onDelete }: { template: MailTemplate | null; onSave: (t: MailTemplate) => Promise<void>; onDelete: (t: MailTemplate) => void }) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState(template?.name ?? '');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const editor = useRef<EditorHandle>(null);

  const save = async () => {
    if (!name.trim()) {
      toast.error(t('templates.nameRequired'));
      return;
    }
    setBusy(true);
    try {
      const html = editor.current?.isEmpty() ? '' : (editor.current?.getHTML() ?? '');
      await onSave({ id: template?.id ?? newTemplateId(), name: name.trim(), subject: subject.trim() || undefined, html });
      setDirty(false);
      toast.success(template ? t('templates.saved') : t('templates.created'));
    } catch (e) {
      toast.error(t('templates.failed'), { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-line p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('templates.name')}>
          <input
            className={inputCls}
            value={name}
            dir="auto"
            autoFocus={!template}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            placeholder={t('templates.namePlaceholder')}
          />
        </Field>
        <Field label={t('templates.subject')} hint={t('templates.subjectHint')}>
          <input
            className={inputCls}
            value={subject}
            dir="auto"
            spellCheck
            onChange={(e) => {
              setSubject(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
      </div>
      <div>
        <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{t('templates.body')}</span>
        <div className="rounded-lg border border-line-strong px-3 py-2.5 focus-within:border-voxel-accent focus-within:ring-[3px] focus-within:ring-voxel-accent-soft">
          <RichEditor ariaLabel={t('templates.body')} handleRef={editor} initialHtml={template?.html ?? ''} placeholder={t('templates.bodyPlaceholder')} minHeight={140} onChange={() => setDirty(true)} />
        </div>
        <p className="mt-1.5 text-[11.5px] text-text-3">{t('templates.hint')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button onClick={save} disabled={busy || (!dirty && !!template)}>
          {template ? t('templates.save') : t('templates.create')}
        </Button>
        <div className="flex-1" />
        {template && (
          <Button variant="ghost" className="text-danger hover:bg-danger/10 hover:text-danger" onClick={() => onDelete(template)}>
            <Trash2 /> {t('templates.delete')}
          </Button>
        )}
      </div>
    </div>
  );
}
