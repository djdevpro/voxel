import { Check, ChevronDown, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, currentLocale, setLanguage, type LanguageCode } from '@/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/** Sélecteur de langue discret (écran de connexion). */
export function LanguagePicker({ className }: { className?: string }) {
  const { t, i18n } = useTranslation('auth');
  const current = (i18n.resolvedLanguage as LanguageCode | undefined) ?? currentLocale();
  const name = LANGUAGES.find((l) => l.code === current)?.name ?? current;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('language.label')}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-text-2 outline-none voxel-transition hover:bg-(--voxel-menu-hover) hover:text-text-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--voxel-accent-ring) data-[state=open]:bg-(--voxel-menu-hover) data-[state=open]:text-text-1',
          className,
        )}
      >
        <Globe className="size-3.5" />
        {name}
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {LANGUAGES.map((l) => (
          <DropdownMenuItem key={l.code} onSelect={() => void setLanguage(l.code)} className="justify-between" dir={l.dir} lang={l.code}>
            <span>{l.name}</span>
            {l.code === current && <Check className="size-3.5 text-voxel-accent-strong" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
