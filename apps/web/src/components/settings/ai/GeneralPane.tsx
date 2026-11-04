import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CircleCheck, Loader2, Lock, Sparkles } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LANGUAGES } from '@/i18n';
import { findProvider, modelRefFor, useAiReady, useAiSettings } from '@/lib/ai/store';
import { describeAiError, shortModelName } from '@/lib/ai/errors';
import { testProvider } from '@/lib/ai/models';
import type { AiSettings } from '@/lib/ai/types';
import { SettingRow } from '../ui';

/** Nom d'une langue dans la langue de l'interface (« Français »), via Intl.DisplayNames. */
function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return code;
  }
}

export function GeneralPane({ onConfigure }: { onConfigure: () => void }) {
  const { t, i18n } = useTranslation('ai');
  const enabled = useAiSettings((s) => s.enabled);
  const responseLanguage = useAiSettings((s) => s.responseLanguage);
  const set = useAiSettings((s) => s.set);
  const ready = useAiReady();
  const ref = useAiSettings((s) => modelRefFor('chat', s));
  const provider = useAiSettings((s) => (ref ? findProvider(ref.providerId, s) : undefined));
  const [testing, setTesting] = useState(false);
  const ui = i18n.resolvedLanguage ?? i18n.language;

  const test = async () => {
    if (!ref || !provider) return;
    setTesting(true);
    try {
      const r = await testProvider(provider, ref.model);
      toast.success(t(r.tools ? 'settings.general.testOk' : 'settings.general.testOkNoTools', { ms: r.ms }));
    } catch (e) {
      toast.error(describeAiError(e, provider).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <SettingRow title={t('settings.general.enable')} description={t('settings.general.enableHint')}>
          <Switch checked={enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label={t('settings.general.enable')} />
        </SettingRow>
        <SettingRow title={t('settings.general.language')}>
          <Select value={responseLanguage} onValueChange={(v) => set({ responseLanguage: v as AiSettings['responseLanguage'] })}>
            <SelectTrigger size="sm" aria-label={t('settings.general.language')} className="min-w-[200px] border-line-strong bg-panel text-[13px] text-text-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto" className="text-[13px]">
                {t('settings.general.languageAuto', { name: languageName(ui, ui) })}
              </SelectItem>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code} className="text-[13px]">
                  <span lang={l.code} dir={l.dir}>
                    {l.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-4">
        {ready && ref && provider ? (
          <>
            <CircleCheck className="size-5 shrink-0 text-success" />
            <p className="min-w-0 flex-1 text-[13px] text-text-1">{t('settings.general.ready', { model: shortModelName(ref.model), provider: provider.name })}</p>
            <Button variant="secondary" size="sm" onClick={test} disabled={testing}>
              {testing && <Loader2 className="animate-spin" />}
              {t('settings.general.test')}
            </Button>
          </>
        ) : (
          <>
            <Sparkles className="size-5 shrink-0 text-voxel-accent-strong" />
            <p className="min-w-0 flex-1 text-[13px] text-text-1">{t('settings.general.notReady')}</p>
            <Button size="sm" onClick={onConfigure}>
              {t('settings.general.configure')}
            </Button>
          </>
        )}
      </div>

      <div className="flex gap-3 rounded-xl bg-black/[0.03] p-4 text-[12.5px] leading-relaxed text-text-2 dark:bg-white/[0.04]">
        <Lock className="mt-0.5 size-4 shrink-0 text-text-3" />
        <p>{t('settings.general.privacy')}</p>
      </div>
    </div>
  );
}
