import { useState } from 'react';
import { Command } from 'cmdk';
import { AnimatePresence, motion } from 'motion/react';
import { CloudOff, Inbox, Moon, PenLine, Search, Settings, Sun, Monitor, Keyboard, LogOut, Rows3, Rows2, PanelRight, PanelBottom, PanelRightClose, Folder } from 'lucide-react';
import { useAccounts, useAllMailboxData } from '@/hooks/useData';
import { ALL, useUi } from '@/store/ui';
import { useNav } from '@/nav/useNav';
import { applySearch, goView, openSettings } from '@/nav/nav';
import { useSettings } from '@/store/settings';
import { useConfirmStore } from '@/store/confirm';
import { roleLabel, SYSTEM_ROLES } from '@/lib/mail';
import { useTranslation } from 'react-i18next';
import { ROLE_ICONS } from '@/components/sidebar/Sidebar';
import { AccountBadge, Kbd } from './bits';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SHORTCUTS } from '@/hooks/useShortcuts';
import { startCompose } from '@/components/compose/startCompose';
import { logoutAll } from '@/components/auth/session';
import { tBase, tFast } from '@/lib/motion';
import { useOnline } from '@/hooks/useEnvironment';
import { useOutboxCount } from '@/hooks/useOutboxCount';
import { flattenTree, mailboxTree } from '@voxel/jmap';
import { MOD } from '@/components/rail/AccountRail';

// ------------------------------------------------------------------ palette

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const view = useNav().view;
  const setView = goView;
  const setSearch = applySearch;
  const setHelp = useUi((s) => s.setHelp);
  const { data: accounts } = useAccounts();
  const { map } = useAllMailboxData();
  const set = useSettings((s) => s.set);
  const [q, setQ] = useState('');
  const { t } = useTranslation('shortcuts');

  const run = (fn: () => void) => {
    setOpen(false);
    setQ('');
    setTimeout(fn, 10);
  };

  const folders = view.accountId !== ALL && map[view.accountId]
    ? flattenTree(mailboxTree(map[view.accountId]!.mailboxes.filter((m) => !m.role || !SYSTEM_ROLES.includes(m.role as never))))
    : [];

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(''); }}>
      <DialogContent showCloseButton={false} className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
        <Command loop className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-text-3 [&_[cmdk-group-heading]]:uppercase">
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search className="size-4 text-text-3" />
            <Command.Input
              value={q}
              onValueChange={setQ}
              placeholder={t('palette.placeholder')}
              className="h-12 flex-1 bg-transparent text-[14px] text-text-1 outline-none placeholder:text-text-3"
            />
            <Kbd>{t('keys.esc')}</Kbd>
          </div>
          <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5 pb-2">
            <Command.Empty className="py-10 text-center text-[13px] text-text-3">{t('palette.empty')}</Command.Empty>
            {q.trim().length > 1 && (
              <Command.Group heading={t('palette.groups.search')}>
                <Item icon={<Search />} onSelect={() => run(() => setSearch({ chips: [], text: q.trim() }))} value={`${t('palette.searchKeyword')} ${q}`}>
                  {t('palette.searchFor', { query: q.trim() })}
                </Item>
              </Command.Group>
            )}
            <Command.Group heading={t('palette.groups.actions')}>
              <Item icon={<PenLine />} shortcut="C" onSelect={() => run(() => startCompose())}>
                {t('items.compose')}
              </Item>
              <Item icon={<Settings />} onSelect={() => run(() => openSettings())}>
                {t('palette.settings')}
              </Item>
              <Item icon={<Keyboard />} shortcut="?" onSelect={() => run(() => setHelp(true))}>
                {t('help.title')}
              </Item>
            </Command.Group>
            <Command.Group heading={t('palette.groups.goTo')}>
              {SYSTEM_ROLES.map((r) => {
                const Icon = ROLE_ICONS[r];
                return (
                  <Item key={r} icon={<Icon />} onSelect={() => run(() => setView({ accountId: view.accountId, mailbox: { kind: 'role', role: r } }))}>
                    {roleLabel(r)}
                  </Item>
                );
              })}
              {folders.map((f) => (
                <Item key={f.id} icon={<Folder />} value={`${t('palette.folderKeyword')} ${f.path}`} onSelect={() => run(() => setView({ accountId: view.accountId, mailbox: { kind: 'id', id: f.id } }))}>
                  {f.path}
                </Item>
              ))}
            </Command.Group>
            <Command.Group heading={t('palette.groups.mailboxes')}>
              {(accounts?.length ?? 0) > 1 && (
                <Item icon={<Inbox />} shortcut={`${MOD} 0`} onSelect={() => run(() => setView({ accountId: ALL, mailbox: { kind: 'role', role: 'inbox' } }))}>
                  {t('items.allMailboxes')}
                </Item>
              )}
              {(accounts ?? []).map((a, i) => (
                <Item
                  key={a.id}
                  icon={<AccountBadge color={a.color} label={a.displayName || a.email} size={18} />}
                  shortcut={i < 9 ? `${MOD} ${i + 1}` : undefined}
                  value={`${t('palette.mailboxKeyword')} ${a.displayName} ${a.email}`}
                  onSelect={() => run(() => setView({ accountId: a.id, mailbox: { kind: 'role', role: 'inbox' } }))}
                >
                  {a.displayName || a.email}
                  <span className="ms-2 text-text-3">{a.email}</span>
                </Item>
              ))}
            </Command.Group>
            <Command.Group heading={t('palette.groups.appearance')}>
              <Item icon={<Sun />} onSelect={() => run(() => set({ theme: 'light' }))}>{t('palette.themeLight')}</Item>
              <Item icon={<Moon />} onSelect={() => run(() => set({ theme: 'dark' }))}>{t('palette.themeDark')}</Item>
              <Item icon={<Monitor />} onSelect={() => run(() => set({ theme: 'system' }))}>{t('palette.themeSystem')}</Item>
              <Item icon={<Rows3 />} onSelect={() => run(() => set({ density: 'comfortable' }))}>{t('palette.densityComfortable')}</Item>
              <Item icon={<Rows2 />} onSelect={() => run(() => set({ density: 'compact' }))}>{t('palette.densityCompact')}</Item>
              <Item icon={<PanelRight />} onSelect={() => run(() => set({ readingPane: 'right' }))}>{t('palette.paneRight')}</Item>
              <Item icon={<PanelBottom />} onSelect={() => run(() => set({ readingPane: 'bottom' }))}>{t('palette.paneBottom')}</Item>
              <Item icon={<PanelRightClose />} onSelect={() => run(() => set({ readingPane: 'none' }))}>{t('palette.paneNone')}</Item>
            </Command.Group>
            <Command.Group heading={t('palette.groups.session')}>
              <Item
                icon={<LogOut className="rtl:-scale-x-100" />}
                onSelect={() =>
                  run(async () => {
                    await logoutAll();
                  })
                }
              >
                {t('palette.logout')}
              </Item>
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Item({ icon, children, shortcut, onSelect, value }: { icon: React.ReactNode; children: React.ReactNode; shortcut?: string; onSelect: () => void; value?: string }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-9 cursor-default items-center gap-3 rounded-lg px-3 text-[13.5px] text-text-1 data-[selected=true]:bg-accent [&>span:first-child_svg]:size-4"
    >
      <span className="flex w-4 items-center justify-center text-text-3">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center truncate">{children}</span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </Command.Item>
  );
}

// ------------------------------------------------------------------ aide raccourcis

export function ShortcutsHelp() {
  const open = useUi((s) => s.helpOpen);
  const setOpen = useUi((s) => s.setHelp);
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  const { t } = useTranslation('shortcuts');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">{t('help.title')}</DialogTitle>
          <DialogDescription>{t('help.description')}</DialogDescription>
        </DialogHeader>
        <ShortcutTable groups={groups} />
      </DialogContent>
    </Dialog>
  );
}

/** Touche affichée : touches nommées traduites, `ctrl` → ⌘ sur Mac. */
function keyLabel(k: string, t: (key: string) => string): string {
  if (k === 'ctrl') return MOD;
  if (k === 'shift') return '⇧';
  if (k === 'enter' || k === 'esc') return t(`keys.${k}`);
  return k;
}

export function ShortcutTable({ groups }: { groups: string[] }) {
  const { t } = useTranslation('shortcuts');
  return (
    <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
      {groups.map((g) => (
        <div key={g}>
          <h3 className="mb-2 text-[11.5px] font-medium tracking-wide text-text-3 uppercase">{t(`groups.${g}`)}</h3>
          <ul className="space-y-0.5">
            {SHORTCUTS.filter((s) => s.group === g).map((s) => (
              <li key={s.label + s.keys.join()} className="flex h-7 items-center justify-between gap-3 text-[13px] text-text-2">
                <span>{t(`items.${s.label}`)}</span>
                <span className="flex items-center gap-1">
                  {s.keys.map((k, i) => (
                    <Kbd key={i}>{keyLabel(k, t)}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ confirmation

export function ConfirmHost() {
  const req = useConfirmStore((s) => s.req);
  const set = useConfirmStore((s) => s.set);
  const { t } = useTranslation();
  const close = (ok: boolean) => {
    req?.resolve(ok);
    set(null);
  };
  return (
    <AlertDialog open={!!req} onOpenChange={(o) => !o && close(false)}>
      <AlertDialogContent className="sm:max-w-[420px]">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[16px]">{req?.title}</AlertDialogTitle>
          {req?.description && <AlertDialogDescription className="text-[13.5px]">{req.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => close(false)}>{t('actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            autoFocus
            onClick={() => close(true)}
            variant={req?.destructive ? 'destructive' : 'default'}
          >
            {req?.confirmLabel ?? t('actions.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ------------------------------------------------------------------ bandeau hors ligne

export function OfflineBanner() {
  const online = useOnline();
  const pending = useOutboxCount();
  const { t } = useTranslation();
  return (
    <AnimatePresence initial={false}>
      {!online && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={tBase}
          className="shrink-0 overflow-hidden"
          role="status"
        >
          <div className="flex h-8 items-center justify-center gap-2 bg-text-1 text-[12.5px] text-app">
            <CloudOff className="size-3.5 opacity-80" />
            <span>{t('offline.banner')}</span>
            <AnimatePresence>
              {pending > 0 && (
                <motion.span initial={{ opacity: 0 }} animate={{ opacity: 0.7 }} exit={{ opacity: 0 }} transition={tFast}>
                  · {t('offline.pending', { count: pending })}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
