import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronDown, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { IconButton } from '@/components/common/bits';
import { PROVIDER_PRESETS } from '@/lib/ai/defaults';
import { describeAiError } from '@/lib/ai/errors';
import { listModels, testProvider } from '@/lib/ai/models';
import { useAiSecretSet } from '@/lib/ai/secrets';
import { useAiSettings } from '@/lib/ai/store';
import type { AiProvider } from '@/lib/ai/types';
import { confirmDialog } from '@/store/confirm';
import { cn } from '@/lib/utils';
import { Field, inputCls } from '../ui';
import { SecretField } from './SecretField';

/** JSON vide ou objet : valide. */
function validExtraBody(raw: string): boolean {
  if (!raw.trim()) return true;
  try {
    const v: unknown = JSON.parse(raw);
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

export function ProviderCard({ provider: p, defaultOpen }: { provider: AiProvider; defaultOpen: boolean }) {
  const { t } = useTranslation('ai');
  const [open, setOpen] = useState(defaultOpen);
  const [advanced, setAdvanced] = useState(false);
  const upsertProvider = useAiSettings((s) => s.upsertProvider);
  const removeProvider = useAiSettings((s) => s.removeProvider);
  const defaultModel = useAiSettings((s) => s.defaultModel);
  const hasKey = useAiSecretSet(p.id);
  const preset = PROVIDER_PRESETS.find((x) => x.id === p.preset);
  const isDemo = p.preset === 'demo';

  const [name, setName] = useState(p.name);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [newModel, setNewModel] = useState('');
  const [extra, setExtra] = useState(p.extraBody ?? '');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const extraValid = validExtraBody(extra);

  const update = (patch: Partial<AiProvider>) => upsertProvider({ ...p, ...patch });

  const keyState: 'saved' | 'missing' | 'none' = hasKey ? 'saved' : preset?.needsKey ? 'missing' : 'none';

  const remove = async () => {
    const ok = await confirmDialog({
      title: t('settings.providers.removeTitle', { name: p.name }),
      description: t('settings.providers.removeText'),
      confirmLabel: t('settings.providers.remove'),
      destructive: true,
    });
    if (ok) removeProvider(p.id);
  };

  const addModel = () => {
    const m = newModel.trim();
    if (!m) return;
    if (!p.models.includes(m)) update({ models: [...p.models, m] });
    setNewModel('');
  };

  const fetchModels = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const ids = await listModels(p);
      // la carte peut avoir changé pendant l'appel : relire l'état courant
      const cur = useAiSettings.getState().providers.find((x) => x.id === p.id);
      if (cur) upsertProvider({ ...cur, models: [...cur.models, ...ids] });
      toast(t('settings.providers.fetched', { count: ids.length }));
    } catch (e) {
      const d = describeAiError(e, p);
      setFetchError({ message: d.message, notFound: d.code === 'not_found' });
    } finally {
      setFetching(false);
    }
  };

  const testModel = defaultModel?.providerId === p.id && p.models.includes(defaultModel.model) ? defaultModel.model : p.models[0];
  const test = async () => {
    if (!testModel) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testProvider(p, testModel);
      setTestResult({ ok: true, text: t(r.tools ? 'settings.providers.testOk' : 'settings.providers.testOkNoTools', { ms: r.ms }) });
    } catch (e) {
      setTestResult({ ok: false, text: describeAiError(e, p).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-line">
      <div className="flex items-center gap-2 pe-2">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-4 py-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-voxel-accent"
          >
            <ChevronDown className={cn('size-4 shrink-0 text-text-3 voxel-transition', !open && '-rotate-90 rtl:rotate-90')} />
            <span dir="auto" className="truncate text-[13.5px] font-medium text-text-1">
              {p.name}
            </span>
            <span className="rounded-md bg-black/[0.05] px-1.5 text-[11px] text-text-2 dark:bg-white/[0.06]">{p.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}</span>
            {!isDemo && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-[11.5px]',
                  keyState === 'saved' ? 'text-success' : keyState === 'missing' ? 'text-[var(--voxel-warn,#f59e0b)]' : 'text-text-3',
                )}
              >
                <span aria-hidden className="size-1.5 rounded-full bg-current" />
                {t(`settings.providers.key.${keyState}`)}
              </span>
            )}
            <span className="text-[11.5px] text-text-3">{t('settings.providers.modelCount', { count: p.models.length })}</span>
          </button>
        </CollapsibleTrigger>
        <IconButton label={t('settings.providers.remove')} onClick={remove} size="sm">
          <Trash2 />
        </IconButton>
      </div>
      <CollapsibleContent>
        <div className="space-y-4 border-t border-line p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('settings.providers.name')}>
              <input className={inputCls} dir="auto" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== p.name && update({ name: name.trim() })} />
            </Field>
            {!isDemo && (
              <Field label={t('settings.providers.baseUrl')} hint={t(p.protocol === 'anthropic' ? 'settings.providers.baseUrlHintAnthropic' : 'settings.providers.baseUrlHint')}>
                <input
                  className={cn(inputCls, 'font-mono text-[12.5px]')}
                  dir="ltr"
                  spellCheck={false}
                  placeholder="https://…/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  onBlur={() => baseUrl !== p.baseUrl && update({ baseUrl })}
                />
              </Field>
            )}
          </div>

          {!isDemo && <SecretField secretId={p.id} label={t('settings.providers.apiKey')} optional={p.preset === 'ollama' || p.preset === 'custom'} />}

          <div>
            <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{t('settings.providers.models')}</span>
            {p.models.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {p.models.map((m) => (
                  <span key={m} dir="ltr" className="inline-flex h-7 items-center gap-1 rounded-md border border-line ps-2 pe-1 font-mono text-[12.5px] text-text-1">
                    {m}
                    <button
                      type="button"
                      aria-label={t('settings.providers.removeModel', { model: m })}
                      onClick={() => update({ models: p.models.filter((x) => x !== m) })}
                      className="flex size-5 items-center justify-center rounded text-text-3 voxel-transition hover:bg-black/[0.05] hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none dark:hover:bg-white/[0.07]"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <input
                className={cn(inputCls, 'min-w-[180px] flex-1 font-mono text-[12.5px]')}
                dir="ltr"
                spellCheck={false}
                aria-label={t('settings.providers.addModel')}
                placeholder={t('settings.providers.addModel')}
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addModel();
                  }
                }}
              />
              <Button variant="secondary" onClick={fetchModels} disabled={fetching}>
                <RefreshCw className={cn(fetching && 'animate-spin')} /> {t('settings.providers.fetch')}
              </Button>
            </div>
            {fetchError && (
              <p role="alert" className="mt-1.5 text-[12px] text-danger">
                {fetchError.message}
                {fetchError.notFound && <> {t('settings.providers.noModelList')}</>}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" onClick={test} disabled={!testModel || testing}>
              {testing && <Loader2 className="animate-spin" />}
              {t('settings.providers.test')}
            </Button>
            <span aria-live="polite" className={cn('min-w-0 text-[12.5px]', testResult?.ok ? 'text-success' : 'text-danger')}>
              {testResult?.text}
            </span>
          </div>

          <Collapsible open={advanced} onOpenChange={setAdvanced}>
            <CollapsibleTrigger className="inline-flex items-center gap-1 rounded text-[12.5px] text-text-3 voxel-transition hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none">
              <ChevronDown className={cn('size-3.5 voxel-transition', !advanced && '-rotate-90 rtl:rotate-90')} />
              {t('settings.providers.advanced')}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-3">
              {p.protocol === 'openai' && (
                <label className="block">
                  <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{t('settings.providers.extraBody')}</span>
                  <textarea
                    rows={3}
                    dir="ltr"
                    spellCheck={false}
                    aria-invalid={!extraValid}
                    className={cn(inputCls, 'h-auto resize-y py-2 font-mono text-[12.5px]', !extraValid && 'border-danger focus:border-danger')}
                    value={extra}
                    onChange={(e) => setExtra(e.target.value)}
                    onBlur={() => extraValid && extra.trim() !== (p.extraBody ?? '') && update({ extraBody: extra.trim() || undefined })}
                  />
                  <span className="mt-1 block text-[11.5px] text-text-3">{t('settings.providers.extraBodyHint')}</span>
                </label>
              )}
              {import.meta.env.DEV && (
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-text-1">{t('settings.providers.devProxy')}</div>
                    <div className="mt-0.5 text-[12px] text-text-2">{t('settings.providers.devProxyHint')}</div>
                  </div>
                  <Switch checked={!!p.devProxy} onCheckedChange={(v) => update({ devProxy: v })} aria-label={t('settings.providers.devProxy')} />
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
