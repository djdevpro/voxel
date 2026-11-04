import { useId } from 'react';
import { PushSettings } from './PushSettings';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Check, Monitor, Moon, Sun, Rows3, Rows2, PanelRight, PanelBottom, PanelRightClose, PenLine, AtSign } from 'lucide-react';
import { toast } from 'sonner';
import { useSettings } from '@/store/settings';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from './Slider';
import { SettingRow, Segmented } from './ui';
import { ShortcutTable } from '@/components/common/Overlays';
import { SHORTCUTS } from '@/hooks/useShortcuts';
import { useIsDark } from '@/hooks/useEnvironment';
import { LANGUAGES, setLanguage, currentLocale, type LanguageCode } from '@/i18n';
import { THEMES, useThemeId, type ThemeId } from '@/lib/themes';
import { tBase } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * Miniature de l'appli dans les couleurs réelles d'une collection : le conteneur porte
 * data-theme (+ .dark), donc les jetons --voxel-* de la collection s'appliquent à l'intérieur
 * (avec l'accent par défaut de la collection, pas celui de la boîte active).
 */
function ThemeMiniature({ id, dark }: { id: ThemeId; dark: boolean }) {
  return (
    <div
      data-theme={id}
      aria-hidden
      className={cn('pointer-events-none relative flex h-[76px] w-full overflow-hidden rounded-lg border border-line bg-app text-text-1', dark && 'dark')}
    >
      {/* rail */}
      <div className="flex w-4 flex-col items-center gap-1 border-e border-line bg-rail pt-2">
        <div className="size-2 rounded-full bg-voxel-accent" />
        <div className="size-2 rounded-full bg-line-strong" />
      </div>
      {/* barre latérale */}
      <div className="flex w-[30%] flex-col gap-1 border-e border-line bg-sidebar p-1.5">
        <div className="voxel-btn-primary mb-0.5 flex h-2.5 items-center gap-0.5 rounded-[3px] px-1 [&_svg]:size-1.5">
          <PenLine />
          <div className="h-[2px] flex-1 rounded-full bg-current opacity-70" />
        </div>
        <div className="h-[3px] w-4/5 rounded-full" style={{ background: 'color-mix(in oklab, var(--voxel-accent) 40%, transparent)' }} />
        <div className="h-[3px] w-3/5 rounded-full bg-text-3 opacity-60" />
        <div className="h-[3px] w-2/3 rounded-full bg-text-3 opacity-60" />
      </div>
      {/* liste */}
      <div className="flex flex-1 flex-col bg-panel">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn('flex items-center gap-1 border-b border-line px-1.5 py-[5px]', i === 0 && 'bg-row-selected')}>
            <div className={cn('size-[5px] shrink-0 rounded-full', i === 0 ? 'bg-voxel-accent' : 'bg-transparent')} />
            <div className="flex flex-1 flex-col gap-[3px]">
              <div className={cn('h-[3px] rounded-full bg-text-1', i === 0 ? 'w-3/4' : 'w-1/2 opacity-80')} />
              <div className="h-[3px] w-full rounded-full bg-text-2 opacity-45" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ThemeTile({ id, active, dark, layoutGroup, onSelect }: { id: ThemeId; active: boolean; dark: boolean; layoutGroup: string; onSelect: () => void }) {
  const { t } = useTranslation('themes');
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-theme-id={id}
      onClick={onSelect}
      className={cn(
        'group relative flex min-w-0 flex-col gap-2 rounded-xl border p-1.5 pb-2 text-start voxel-transition',
        active ? 'border-transparent' : 'border-line hover:border-line-strong hover:bg-row-hover',
      )}
    >
      {active && (
        <motion.span
          layoutId={`${layoutGroup}-ring`}
          transition={tBase}
          className="pointer-events-none absolute -inset-px rounded-xl border-[1.5px] border-voxel-accent ring-[3px] ring-voxel-accent-soft"
        />
      )}
      <ThemeMiniature id={id} dark={dark} />
      <span className="flex min-w-0 items-start gap-1.5 px-0.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-text-1">{t(`${id}.name`)}</span>
          <span className="block truncate text-[11.5px] text-text-3" title={t(`${id}.description`)}>
            {t(`${id}.description`)}
          </span>
        </span>
        <motion.span
          initial={false}
          animate={{ opacity: active ? 1 : 0, scale: active ? 1 : 0.6 }}
          transition={tBase}
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-voxel-accent text-on-accent [&_svg]:size-2.5"
        >
          <Check strokeWidth={3} />
        </motion.span>
      </span>
    </button>
  );
}

export function AppearanceSection() {
  const { t, i18n } = useTranslation('appearance');
  const s = useSettings();
  const dark = useIsDark();
  const [themeId, setThemeId] = useThemeId();
  const layoutGroup = useId();
  // i18n.resolvedLanguage change à chaque changement de langue : le composant se re-rend
  const lang: LanguageCode = i18n.resolvedLanguage ? currentLocale() : 'en';

  return (
    <div className="max-w-[680px]">
      <div className="border-b border-line pb-5">
        <div className="text-[13.5px] font-medium text-text-1">{t('collection.title')}</div>
        <div className="mt-0.5 mb-3 text-[12.5px] leading-relaxed text-text-2">{t('collection.description')}</div>
        <div role="radiogroup" aria-label={t('collection.label')} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
          {THEMES.map((th) => (
            <ThemeTile key={th.id} id={th.id} active={th.id === themeId} dark={dark} layoutGroup={layoutGroup} onSelect={() => setThemeId(th.id)} />
          ))}
        </div>
      </div>
      <SettingRow title={t('mode.title')} description={t('mode.description')}>
        <Segmented
          value={s.theme}
          onChange={(theme) => s.set({ theme })}
          options={[
            { value: 'light', label: t('mode.light'), icon: <Sun /> },
            { value: 'dark', label: t('mode.dark'), icon: <Moon /> },
            { value: 'system', label: t('mode.system'), icon: <Monitor /> },
          ]}
        />
      </SettingRow>
      <SettingRow title={t('language.title')} description={t('language.description')}>
        <Select value={lang} onValueChange={(v) => void setLanguage(v as LanguageCode)}>
          <SelectTrigger size="sm" aria-label={t('language.title')} className="min-w-[160px] border-line-strong bg-panel text-[13px] text-text-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
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
      <SettingRow title={t('density.title')} description={t('density.description')}>
        <Segmented
          value={s.density}
          onChange={(density) => s.set({ density })}
          options={[
            { value: 'comfortable', label: t('density.comfortable'), icon: <Rows3 /> },
            { value: 'compact', label: t('density.compact'), icon: <Rows2 /> },
          ]}
        />
      </SettingRow>
      <SettingRow title={t('readingPane.title')} description={t('readingPane.description')}>
        <Segmented
          value={s.readingPane}
          onChange={(readingPane) => s.set({ readingPane })}
          options={[
            { value: 'right', label: t('readingPane.right'), icon: <PanelRight className="rtl:-scale-x-100" /> },
            { value: 'bottom', label: t('readingPane.bottom'), icon: <PanelBottom /> },
            { value: 'none', label: t('readingPane.none'), icon: <PanelRightClose className="rtl:-scale-x-100" /> },
          ]}
        />
      </SettingRow>
      <p className="mt-3 text-[12px] text-text-3">{t('accentHint')}</p>
    </div>
  );
}

export function ReadingSection() {
  const { t } = useTranslation('appearance');
  const s = useSettings();
  return (
    <div className="max-w-[680px]">
      <SettingRow title={t('reading.undoSend.title')} description={t('reading.undoSend.description', { count: s.undoSendSeconds })}>
        <div className="flex w-56 items-center gap-3">
          <Slider min={5} max={30} step={5} value={s.undoSendSeconds} label={t('reading.undoSend.label')} onChange={(v) => s.set({ undoSendSeconds: v })} />
          <span className="min-w-10 shrink-0 text-end text-[13px] font-medium whitespace-nowrap text-text-1 tabular">{t('reading.undoSend.value', { count: s.undoSendSeconds })}</span>
        </div>
      </SettingRow>
      <SettingRow title={t('reading.remoteImages.title')} description={t('reading.remoteImages.description')}>
        <Segmented
          value={s.remoteImages}
          onChange={(remoteImages) => s.set({ remoteImages })}
          options={[
            { value: 'block', label: t('reading.remoteImages.block') },
            { value: 'allow', label: t('reading.remoteImages.allow') },
          ]}
        />
      </SettingRow>
      <SettingRow title={t('reading.receipts.title')} description={t('reading.receipts.description')}>
        <Segmented
          value={s.readReceipts}
          onChange={(readReceipts) => s.set({ readReceipts })}
          options={[
            { value: 'ask', label: t('reading.receipts.ask') },
            { value: 'always', label: t('reading.receipts.always') },
            { value: 'never', label: t('reading.receipts.never') },
          ]}
        />
      </SettingRow>
      {s.trustedSenders.length > 0 && (
        <SettingRow title={t('reading.trusted.title')} description={t('reading.trusted.description', { count: s.trustedSenders.length })}>
          <button type="button" className="text-[12.5px] font-medium text-voxel-accent-strong hover:underline" onClick={() => s.set({ trustedSenders: [] })}>
            {t('reading.trusted.reset')}
          </button>
        </SettingRow>
      )}
      <SettingRow title={t('reading.mailto.title')} description={t('reading.mailto.description')}>
        <Button variant="outline" size="sm" onClick={() => registerMailtoHandler(t)}>
          <AtSign /> {t('reading.mailto.button')}
        </Button>
      </SettingRow>
      <SettingRow title={t('reading.notifications.title')} description={t('reading.notifications.description')}>
        <Switch
          checked={s.notifications}
          aria-label={t('reading.notifications.title')}
          className="data-[state=checked]:bg-voxel-accent"
          onCheckedChange={async (v) => {
            if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
              const p = await Notification.requestPermission();
              if (p !== 'granted') return toast.error(t('reading.notifications.denied'));
            }
            s.set({ notifications: v });
          }}
        />
      </SettingRow>
      <PushSettings />
    </div>
  );
}

/** Gestionnaire `mailto:` : les liens e-mail des autres sites ouvrent `/compose?mailto=…`. */
function registerMailtoHandler(t: (k: string) => string) {
  const nav = navigator as Navigator & { registerProtocolHandler?: (scheme: string, url: string) => void };
  if (typeof nav.registerProtocolHandler !== 'function') {
    toast.error(t('reading.mailto.unsupported'));
    return;
  }
  try {
    nav.registerProtocolHandler('mailto', `${window.location.origin}/compose?mailto=%s`);
    toast(t('reading.mailto.done'));
  } catch {
    toast.error(t('reading.mailto.unsupported'));
  }
}

export function ShortcutsSection() {
  const { t } = useTranslation('appearance');
  return (
    <div>
      <p className="mb-5 text-[13px] text-text-2">{t('shortcuts.hint')}</p>
      <ShortcutTable groups={[...new Set(SHORTCUTS.map((s) => s.group))]} />
    </div>
  );
}
