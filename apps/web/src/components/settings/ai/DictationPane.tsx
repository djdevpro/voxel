import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LANGUAGES } from '@/i18n';
import { dictationSupported } from '@/lib/ai/dictation';
import { useAiSettings } from '@/lib/ai/store';
import type { AiDictationSettings } from '@/lib/ai/types';
import { cn } from '@/lib/utils';
import { Field, SettingRow, inputCls } from '../ui';
import { SecretField } from './SecretField';

export function DictationPane() {
  const { t } = useTranslation('ai');
  const dictation = useAiSettings((s) => s.dictation);
  const set = useAiSettings((s) => s.set);
  const [model, setModel] = useState(dictation.model);
  const update = (patch: Partial<AiDictationSettings>) => set({ dictation: { ...useAiSettings.getState().dictation, ...patch } });

  return (
    <div className="space-y-5">
      {!dictationSupported() && (
        <div role="alert" className="flex gap-2.5 rounded-xl border border-line p-3 text-[12.5px] text-text-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--voxel-warn,#f59e0b)]" />
          {t('dictation.unsupported')}
        </div>
      )}
      <SettingRow title={t('settings.dictation.enable')} description={t('settings.dictation.enableHint')} className="py-0 pb-4">
        <Switch checked={dictation.enabled} onCheckedChange={(enabled) => update({ enabled })} aria-label={t('settings.dictation.enable')} />
      </SettingRow>
      <div>
        <SecretField secretId="deepgram" label={t('settings.dictation.key')} />
        <a
          href="https://console.deepgram.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] text-voxel-accent-strong underline-offset-4 hover:underline"
        >
          {t('settings.dictation.createKey')} <ExternalLink className="size-3" />
        </a>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('settings.dictation.model')}>
          <input
            className={cn(inputCls, 'font-mono text-[12.5px]')}
            dir="ltr"
            spellCheck={false}
            placeholder="nova-3"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => {
              const m = model.trim() || 'nova-3';
              setModel(m);
              if (m !== dictation.model) update({ model: m });
            }}
          />
        </Field>
        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{t('settings.dictation.language')}</span>
          <Select value={dictation.language} onValueChange={(language) => update({ language })}>
            <SelectTrigger aria-label={t('settings.dictation.language')} className="w-full border-line-strong bg-panel text-[13px] text-text-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto" className="text-[13px]">
                {t('settings.dictation.langAuto')}
              </SelectItem>
              <SelectItem value="multi" className="text-[13px]">
                {t('settings.dictation.langMulti')}
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
        </div>
      </div>
    </div>
  );
}
