import { motion } from 'motion/react';
import { AtSign, Ban, FileText, FolderTree, Inbox, Keyboard, ListFilter, Palmtree, Paintbrush, Send, Sparkles, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useNav } from '@/nav/useNav';
import { accountByEmail, closeSettings, openSettings } from '@/nav/nav';
import { cn } from '@/lib/utils';
import { tFast } from '@/lib/motion';
import { AccountsSection } from './AccountsSection';
import { IdentitiesSection } from './IdentitiesSection';
import { VacationSection } from './VacationSection';
import { BlockedSection } from './BlockedSection';
import { FiltersSection } from './FiltersSection';
import { FoldersSection } from './FoldersSection';
import { TemplatesSection } from './TemplatesSection';
import { AiSection } from './ai/AiSection';
import { AppearanceSection, ReadingSection, ShortcutsSection } from './PreferenceSections';
import { useIsMobile } from '@/hooks/useEnvironment';
import { useAccounts } from '@/hooks/useData';
import { useTranslation } from 'react-i18next';
import { ALL } from '@/store/ui';

const TABS = [
  { id: 'accounts', icon: Inbox, el: AccountsSection },
  { id: 'identities', icon: AtSign, el: IdentitiesSection },
  { id: 'vacation', icon: Palmtree, el: VacationSection },
  { id: 'blocked', icon: Ban, el: BlockedSection },
  { id: 'filters', icon: ListFilter, el: FiltersSection },
  { id: 'folders', icon: FolderTree, el: FoldersSection },
  { id: 'templates', icon: FileText, el: TemplatesSection },
  { id: 'ai', icon: Sparkles, el: AiSection },
  { id: 'appearance', icon: Paintbrush, el: AppearanceSection },
  { id: 'reading', icon: Send, el: ReadingSection },
  { id: 'shortcuts', icon: Keyboard, el: ShortcutsSection },
] as const;

export default function SettingsDialog() {
  const nav = useNav();
  const settings = { open: !!nav.settings, tab: nav.settings ?? 'accounts' };
  const close = closeSettings;
  const mobile = useIsMobile();
  const { t: tr } = useTranslation('settings');
  const { data: accounts } = useAccounts();
  const viewAccount = accountByEmail(nav.settingsMailbox, accounts ?? [])?.id ?? nav.view.accountId;
  // Répondeur : seulement si la boîte courante (ou, en vue unifiée, au moins une boîte) le permet,
  // par JMAP (VacationResponse) ou par le script Sieve géré
  const vacationOk =
    viewAccount === ALL
      ? (accounts ?? []).some((a) => a.capabilities?.vacation || a.capabilities?.sieve)
      : !!accounts?.find((a) => a.id === viewAccount && (a.capabilities?.vacation || a.capabilities?.sieve));
  // Expéditeurs bloqués : même règle, avec JMAP for Sieve
  const sieveOk =
    viewAccount === ALL ? (accounts ?? []).some((a) => a.capabilities?.sieve) : !!accounts?.find((a) => a.id === viewAccount)?.capabilities?.sieve;
  // Filtres : même règle, avec JMAP for Sieve ; une capacité absente masque l'entrée
  const tabs = TABS.filter((t) => (t.id !== 'vacation' || vacationOk) && ((t.id !== 'blocked' && t.id !== 'filters') || sieveOk));
  const tab = tabs.find((t) => t.id === settings.tab) ?? tabs[0]!;
  const Section = tab.el;

  return (
    <Dialog open={settings.open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        showCloseButton={false}
        // focus sur le dialogue lui-même (pas d'anneau de focus parasite sur le premier onglet à l'ouverture)
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        className={cn(
          'flex gap-0 overflow-hidden p-0',
          mobile ? 'h-[100dvh] max-w-none flex-col rounded-none sm:max-w-none' : 'h-[min(720px,90vh)] w-[min(980px,94vw)] max-w-none sm:max-w-none',
        )}
      >
        <DialogTitle className="sr-only">{tr('title')}</DialogTitle>
        <DialogDescription className="sr-only">{tr('description')}</DialogDescription>
        <nav
          aria-label={tr('sections')}
          className={cn('shrink-0 bg-sidebar', mobile ? 'flex gap-1 overflow-x-auto border-b border-line p-2' : 'w-[220px] border-e border-line p-3')}
        >
          {!mobile && <div className="px-2 pt-1 pb-3 text-[15px] font-semibold text-text-1">{tr('title')}</div>}
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => openSettings(t.id)}
              aria-current={t.id === tab.id ? 'page' : undefined}
              className={cn(
                'relative flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-[13px] whitespace-nowrap voxel-transition',
                mobile ? '' : 'w-full',
                t.id === tab.id ? 'font-medium text-text-1' : 'text-text-2 hover:bg-black/[0.04] hover:text-text-1 dark:hover:bg-white/[0.05]',
              )}
            >
              {t.id === tab.id && <motion.span layoutId="settings-tab" className="absolute inset-0 rounded-md bg-voxel-accent-soft" transition={tFast} />}
              <t.icon className={cn('relative size-4', t.id === tab.id ? 'text-voxel-accent-strong' : 'text-text-3')} />
              <span className="relative">{tr(`tabs.${t.id}`)}</span>
            </button>
          ))}
        </nav>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-6">
            <h2 className="text-[15px] font-semibold text-text-1">{tr(`tabs.${tab.id}`)}</h2>
            <button type="button" onClick={close} aria-label={tr('close')} className="flex size-8 items-center justify-center rounded-md text-text-3 voxel-transition hover:bg-(--voxel-menu-hover) hover:text-text-1">
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* fondu à l'entrée seulement : le changement d'onglet n'attend jamais une animation de sortie */}
            <motion.div key={tab.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={tFast} className="px-6 py-5">
              <Section />
            </motion.div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
