import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { AccountDot } from '@/components/common/bits';
import { useAccounts } from '@/hooks/useData';
import { useAiSettings } from '@/lib/ai/store';
import type { AiSummarySettings } from '@/lib/ai/types';
import { cn } from '@/lib/utils';
import { SettingRow, inputCls } from '../ui';

/** Champ numérique borné : la saisie reste libre, la valeur est bornée à la validation (perte du focus, Entrée). */
function NumberInput({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    const v = Number.isFinite(n) && text.trim() ? Math.min(max, Math.max(min, Math.round(n / step) * step)) : value;
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      className={cn(inputCls, 'w-24 tabular-nums')}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

export function SummariesPane() {
  const { t } = useTranslation('ai');
  const summary = useAiSettings((s) => s.summary);
  const set = useAiSettings((s) => s.set);
  const { data } = useAccounts();
  const accounts = data ?? [];
  const update = (patch: Partial<AiSummarySettings>) => set({ summary: { ...useAiSettings.getState().summary, ...patch } });

  return (
    <div>
      <SettingRow title={t('settings.summaries.auto')} description={t('settings.summaries.autoHint')}>
        <Switch checked={summary.auto} onCheckedChange={(auto) => update({ auto })} aria-label={t('settings.summaries.auto')} />
      </SettingRow>
      <SettingRow title={t('settings.summaries.maxEmails')}>
        <NumberInput label={t('settings.summaries.maxEmails')} value={summary.maxEmails} min={5} max={100} onChange={(maxEmails) => update({ maxEmails })} />
      </SettingRow>
      <SettingRow title={t('settings.summaries.maxChars')}>
        <div className="flex items-center gap-2">
          <NumberInput label={t('settings.summaries.maxChars')} value={summary.maxCharsPerEmail} min={500} max={20000} step={500} onChange={(maxCharsPerEmail) => update({ maxCharsPerEmail })} />
          <span className="text-[12.5px] text-text-2">{t('settings.summaries.chars')}</span>
        </div>
      </SettingRow>
      <SettingRow title={t('settings.summaries.includeRead')}>
        <Switch checked={summary.includeRead} onCheckedChange={(includeRead) => update({ includeRead })} aria-label={t('settings.summaries.includeRead')} />
      </SettingRow>
      {accounts.length > 0 && (
        <div className="border-b border-line py-4">
          <div className="mb-2 text-[13.5px] font-medium text-text-1">{t('settings.summaries.mailboxes')}</div>
          <div className="space-y-1">
            {accounts.map((a) => (
              <label key={a.id} className="flex cursor-pointer items-center gap-2.5 rounded-md py-1.5 text-[13px]">
                <Checkbox
                  checked={!summary.excludedAccounts.includes(a.id)}
                  onCheckedChange={(v) => {
                    const rest = summary.excludedAccounts.filter((id) => id !== a.id);
                    update({ excludedAccounts: v === true ? rest : [...rest, a.id] });
                  }}
                />
                <AccountDot color={a.color} />
                <span dir="auto" className="text-text-1">
                  {a.displayName || a.email}
                </span>
                {a.displayName && (
                  <span dir="ltr" className="truncate text-text-3">
                    {a.email}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
      <p className="pt-4 text-[12px] text-text-3">{t('settings.summaries.never')}</p>
    </div>
  );
}
