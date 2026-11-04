import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { shortModelName } from '@/lib/ai/errors';
import { modelRefFor, useAiSettings } from '@/lib/ai/store';
import type { AiFeature } from '@/lib/ai/types';
import { openSettings } from '@/nav/nav';
import { cn } from '@/lib/utils';

const SEP = '\u0000';

/** Choix du modèle d'une fonction (surcharge `featureModels`), avec un lien vers les réglages IA. */
export function ModelPicker({ feature, align = 'start', side = 'bottom', className }: { feature: AiFeature; align?: 'start' | 'end'; side?: 'top' | 'bottom'; className?: string }) {
  const { t } = useTranslation('ai');
  const providers = useAiSettings((s) => s.providers);
  const current = useAiSettings((s) => modelRefFor(feature, s));
  const setFeatureModel = useAiSettings((s) => s.setFeatureModel);
  if (!providers.length) return null;

  const value = current ? `${current.providerId}${SEP}${current.model}` : '';
  const onChange = (v: string) => {
    const i = v.indexOf(SEP);
    if (i > 0) setFeatureModel(feature, { providerId: v.slice(0, i), model: v.slice(i + 1) });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('model.pick')}
          className={cn(
            'voxel-transition inline-flex h-7 max-w-[220px] items-center gap-1 rounded-md px-2 text-[12px] text-text-2 hover:bg-(--voxel-menu-hover) focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none',
            className,
          )}
        >
          <span className="truncate">{current ? shortModelName(current.model) : t('model.none')}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className="max-h-[360px] min-w-[220px] overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {providers.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{p.name}</DropdownMenuLabel>
              {p.models.map((m) => (
                <DropdownMenuRadioItem key={m} value={`${p.id}${SEP}${m}`}>
                  <span className="truncate" title={m}>
                    {shortModelName(m)}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings('ai')}>{t('model.manage')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
