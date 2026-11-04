import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { DEFAULT_TEMPLATES } from '@/lib/ai/defaults';
import { templateLabel, useAiSettings } from '@/lib/ai/store';
import type { AiPromptTemplate } from '@/lib/ai/types';
import { confirmDialog } from '@/store/confirm';
import { cn } from '@/lib/utils';
import { Field, Segmented, inputCls } from '../ui';

type Scope = AiPromptTemplate['scope'];
const SCOPES: Scope[] = ['compose', 'chat'];

/** Modèles de prompts : liste par portée à gauche, éditeur à droite (disposition de TemplatesSection). */
export function TemplatesEditor() {
  const { t } = useTranslation('ai');
  const stored = useAiSettings((s) => s.templates);
  const list = stored ?? DEFAULT_TEMPLATES;
  const { upsertTemplate, removeTemplate, moveTemplate, resetTemplates } = useAiSettings.getState();
  const [selected, setSelected] = useState<string | null>(null);
  const current = list.find((x) => x.id === selected) ?? list[0];

  /** Déplacer dans sa portée : franchir les modèles de l'autre portée, puis échanger avec le voisin. */
  const move = (tpl: AiPromptTemplate, delta: -1 | 1) => {
    const i = list.indexOf(tpl);
    let j = i + delta;
    while (j >= 0 && j < list.length && list[j]!.scope !== tpl.scope) j += delta;
    if (j < 0 || j >= list.length) return;
    for (let n = Math.abs(j - i); n > 0; n--) moveTemplate(tpl.id, delta);
  };

  const create = () => {
    const id = crypto.randomUUID();
    upsertTemplate({ id, scope: 'compose', prompt: '', name: '' });
    setSelected(id);
  };

  const reset = async () => {
    const ok = await confirmDialog({ title: t('settings.prompts.resetTemplatesTitle'), description: t('settings.prompts.resetTemplatesText'), confirmLabel: t('settings.prompts.resetTemplates'), destructive: true });
    if (!ok) return;
    resetTemplates();
    setSelected(null);
  };

  const remove = async (tpl: AiPromptTemplate) => {
    const label = templateLabel(tpl) || t('settings.prompts.newTemplate');
    const ok = await confirmDialog({ title: t('settings.prompts.deleteTitle', { name: label }), confirmLabel: t('settings.prompts.delete'), destructive: true });
    if (!ok) return;
    removeTemplate(tpl.id);
    setSelected(null);
  };

  return (
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      <div className="space-y-4">
        {SCOPES.map((scope) => {
          const items = list.filter((x) => x.scope === scope);
          return (
            <div key={scope}>
              <div className="mb-1.5 px-1 text-[11.5px] font-medium tracking-wide text-text-3 uppercase">{t(`settings.prompts.scope.${scope}`)}</div>
              <div className="space-y-1" role="list" aria-label={t(`settings.prompts.scope.${scope}`)}>
                {items.map((x, k) => (
                  <div role="listitem" key={x.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => setSelected(x.id)}
                      aria-current={current?.id === x.id ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center rounded-lg border py-2 ps-3 pe-14 text-start voxel-transition',
                        current?.id === x.id ? 'border-voxel-accent bg-voxel-accent-softer' : 'border-line hover:border-line-strong',
                      )}
                    >
                      <span dir="auto" className="block truncate text-[13px] font-medium text-text-1">
                        {templateLabel(x) || t('settings.prompts.newTemplate')}
                      </span>
                    </button>
                    <div className="absolute end-1.5 top-1/2 flex -translate-y-1/2 opacity-0 voxel-transition group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        aria-label={t('settings.prompts.moveUp')}
                        disabled={k === 0}
                        onClick={() => move(x, -1)}
                        className="flex size-6 items-center justify-center rounded text-text-3 hover:bg-black/[0.05] hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none disabled:opacity-30 dark:hover:bg-white/[0.07]"
                      >
                        <ChevronUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={t('settings.prompts.moveDown')}
                        disabled={k === items.length - 1}
                        onClick={() => move(x, 1)}
                        className="flex size-6 items-center justify-center rounded text-text-3 hover:bg-black/[0.05] hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none disabled:opacity-30 dark:hover:bg-white/[0.07]"
                      >
                        <ChevronDown className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          onClick={create}
          className="flex h-10 w-full items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 text-[13px] text-text-2 voxel-transition hover:text-text-1"
        >
          <Plus className="size-4" /> {t('settings.prompts.newTemplate')}
        </button>
        <Button variant="ghost" size="sm" onClick={reset} disabled={stored === null}>
          <RotateCcw /> {t('settings.prompts.resetTemplates')}
        </Button>
      </div>
      {current && <TemplateForm key={current.id} template={current} onSave={upsertTemplate} onDelete={() => remove(current)} />}
    </div>
  );
}

function TemplateForm({ template, onSave, onDelete }: { template: AiPromptTemplate; onSave: (t: AiPromptTemplate) => void; onDelete: () => void }) {
  const { t } = useTranslation('ai');
  const [name, setName] = useState(template.name ?? '');
  const [prompt, setPrompt] = useState(template.prompt);
  const save = (patch: Partial<AiPromptTemplate>) => onSave({ ...template, name, prompt, ...patch });

  return (
    <div className="space-y-4 rounded-xl border border-line p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('settings.prompts.name')}>
          <input
            className={inputCls}
            dir="auto"
            value={name}
            placeholder={template.builtin ? t(`templates.${template.builtin}`) : t('settings.prompts.newTemplate')}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== (template.name ?? '') && save({})}
          />
        </Field>
        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{t('settings.prompts.usedIn')}</span>
          <Segmented<Scope> value={template.scope} onChange={(scope) => save({ scope })} options={SCOPES.map((s) => ({ value: s, label: t(`settings.prompts.scope.${s}`) }))} />
        </div>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{t('settings.prompts.prompt')}</span>
        <textarea
          rows={6}
          dir="auto"
          className={cn(inputCls, 'h-auto resize-y py-2 leading-relaxed')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => prompt !== template.prompt && save({})}
        />
      </label>
      {template.scope === 'chat' ? (
        <ToggleRow label={t('settings.prompts.send')} checked={!!template.send} onChange={(send) => save({ send })} />
      ) : (
        <ToggleRow label={t('settings.prompts.replyOnly')} checked={!!template.replyOnly} onChange={(replyOnly) => save({ replyOnly })} />
      )}
      <div className="flex justify-end pt-1">
        <Button variant="ghost" className="text-danger hover:bg-danger/10 hover:text-danger" onClick={onDelete}>
          <Trash2 /> {t('settings.prompts.delete')}
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-text-1">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
