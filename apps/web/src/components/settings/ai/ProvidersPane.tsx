import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { availablePresets, type ProviderPreset } from '@/lib/ai/defaults';
import { shortModelName } from '@/lib/ai/errors';
import { useAiSettings } from '@/lib/ai/store';
import type { AiFeature, AiModelRef } from '@/lib/ai/types';
import { SectionIntro, SettingRow } from '../ui';
import { ProviderCard } from './ProviderCard';

const SEP = '\u0000';
const FEATURES: AiFeature[] = ['chat', 'writing', 'summary'];

const refKey = (r: AiModelRef | null | undefined) => (r ? `${r.providerId}${SEP}${r.model}` : '');
function parseRef(v: string): AiModelRef | null {
  const i = v.indexOf(SEP);
  return i > 0 ? { providerId: v.slice(0, i), model: v.slice(i + 1) } : null;
}

export function ProvidersPane() {
  const { t } = useTranslation('ai');
  const providers = useAiSettings((s) => s.providers);
  const upsertProvider = useAiSettings((s) => s.upsertProvider);
  // carte d'un fournisseur fraîchement créé : ouverte
  const [created, setCreated] = useState<string | null>(null);

  const add = (preset: ProviderPreset) => {
    const id = crypto.randomUUID();
    upsertProvider({ id, name: t(`presets.${preset.id}`), preset: preset.id, protocol: preset.protocol, baseUrl: preset.baseUrl, models: [...preset.models] });
    setCreated(id);
  };

  if (!providers.length) {
    return (
      <div>
        <SectionIntro>{t('settings.providers.intro')}</SectionIntro>
        <div className="grid gap-2 sm:grid-cols-2">
          {availablePresets().map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => add(p)}
              className="flex flex-col items-start gap-1 rounded-xl border border-line p-4 text-start voxel-transition hover:border-line-strong hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none"
            >
              <span className="text-[13.5px] font-medium text-text-1">{t(`presets.${p.id}`)}</span>
              <span className="text-[12.5px] leading-relaxed text-text-2">{t(`settings.providers.presetHelp.${p.id}`)}</span>
              {p.baseUrl && (
                <span dir="ltr" className="truncate font-mono text-[11.5px] text-text-3">
                  {p.baseUrl}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const hasModels = providers.some((p) => p.models.length > 0);

  return (
    <div>
      <SectionIntro>{t('settings.providers.intro')}</SectionIntro>
      <div className="space-y-2">
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} defaultOpen={p.id === created} />
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" className="mt-3">
            <Plus /> {t('settings.providers.add')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[220px]">
          {availablePresets().map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => add(p)}>
              {t(`presets.${p.id}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {hasModels && (
        <div className="mt-6">
          <DefaultModelRow />
          {FEATURES.map((f) => (
            <FeatureModelRow key={f} feature={f} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Options du Select de modèle, groupées par fournisseur. */
function ModelOptions() {
  const providers = useAiSettings((s) => s.providers);
  return (
    <>
      {providers
        .filter((p) => p.models.length)
        .map((p) => (
          <SelectGroup key={p.id}>
            <SelectLabel>{p.name}</SelectLabel>
            {p.models.map((m) => (
              <SelectItem key={m} value={`${p.id}${SEP}${m}`} className="text-[13px]">
                <span className="truncate" title={m}>
                  {shortModelName(m)}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
    </>
  );
}

const triggerCls = 'w-[240px] max-w-full border-line-strong bg-panel text-[13px] text-text-1';

function DefaultModelRow() {
  const { t } = useTranslation('ai');
  const value = useAiSettings((s) => refKey(s.defaultModel));
  const set = useAiSettings((s) => s.set);
  return (
    <SettingRow title={t('settings.providers.defaultModel')}>
      <Select value={value} onValueChange={(v) => set({ defaultModel: parseRef(v) })}>
        <SelectTrigger size="sm" aria-label={t('settings.providers.defaultModel')} className={triggerCls}>
          <SelectValue placeholder={t('model.pick')} />
        </SelectTrigger>
        <SelectContent>
          <ModelOptions />
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

function FeatureModelRow({ feature }: { feature: AiFeature }) {
  const { t } = useTranslation('ai');
  const value = useAiSettings((s) => refKey(s.featureModels[feature]) || 'default');
  const setFeatureModel = useAiSettings((s) => s.setFeatureModel);
  const title = t(`settings.providers.feature.${feature}`);
  return (
    <SettingRow title={title}>
      <Select value={value} onValueChange={(v) => setFeatureModel(feature, v === 'default' ? null : parseRef(v))}>
        <SelectTrigger size="sm" aria-label={title} className={triggerCls}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default" className="text-[13px]">
            {t('settings.providers.sameAsDefault')}
          </SelectItem>
          <SelectSeparator />
          <ModelOptions />
        </SelectContent>
      </Select>
    </SettingRow>
  );
}
