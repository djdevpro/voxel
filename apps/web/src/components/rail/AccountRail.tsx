import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Inbox, Plus, Settings, Sun, Moon, Command, BookUser, CalendarDays, Sparkles } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AccountBadge, AnimatedNumber } from '@/components/common/bits';
import { Logo } from '@/components/common/Logo';
import { useAccounts, useAllMailboxData } from '@/hooks/useData';
import { ALL, useUi } from '@/store/ui';
import { useNav } from '@/nav/useNav';
import { goCalendar, goContacts, goView, openSettings } from '@/nav/nav';
import { useSettings } from '@/store/settings';
import { useAiEnabled, useAiReady } from '@/lib/ai/store';
import { roleId } from '@/lib/mail';
import { cn } from '@/lib/utils';
import { tBase } from '@/lib/motion';
import { useMediaQuery } from '@/hooks/useEnvironment';
import { useIsRtl, useReconnect } from '@/components/auth/session';
import { AccountContextMenu, AccountDropdown } from './AccountMenu';
import { useAddMailbox } from './AddMailboxDialog';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

function RailItem({
  active,
  label,
  hint,
  unread,
  color,
  warn,
  onClick,
  wrap,
  children,
}: {
  active: boolean;
  label: string;
  hint?: string;
  unread: number;
  color?: string;
  warn?: string;
  onClick: () => void;
  wrap?: (node: ReactNode) => ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation('accounts');
  const rtl = useIsRtl();
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-label={[label, unread ? t('rail.unread', { count: unread }) : '', warn ?? ''].filter(Boolean).join(', ')}
      aria-current={active ? 'true' : undefined}
      className="group relative flex h-11 w-full items-center justify-center outline-none"
    >
      {active && (
        <motion.span
          layoutId="rail-indicator"
          className="absolute start-0 h-6 w-[3px] rounded-e-full"
          style={{ background: color ?? 'var(--voxel-text-1)' }}
          transition={tBase}
        />
      )}
      <span
        className={cn(
          'relative rounded-[12px] voxel-transition group-hover:scale-[1.04] group-active:scale-[0.97] group-focus-visible:ring-2 group-focus-visible:ring-voxel-accent group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-rail',
          !active && 'opacity-[0.82] saturate-[0.8] group-hover:opacity-100 group-hover:saturate-100',
        )}
      >
        {children}
        {unread > 0 && (
          <span className="absolute -end-1.5 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full border-2 border-rail bg-text-1 px-1 text-[10px] leading-none font-semibold text-app">
            <AnimatedNumber value={unread} max={99} />
          </span>
        )}
        {warn && <span aria-hidden className="absolute -end-0.5 -bottom-0.5 size-3 rounded-full border-2 border-rail bg-[var(--voxel-warn,#f59e0b)]" />}
      </span>
    </button>
  );
  return (
    <Tooltip>
      {wrap ? wrap(<TooltipTrigger asChild>{button}</TooltipTrigger>) : <TooltipTrigger asChild>{button}</TooltipTrigger>}
      <TooltipContent side={rtl ? 'left' : 'right'} className="flex items-center gap-2 border-0 bg-text-1 px-2 py-1 text-[11.5px] text-app">
        {label}
        {hint && (
          <span className="rounded bg-white/15 px-1 text-[10.5px] dark:bg-black/15" dir="ltr">
            {hint}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function AccountRail({ className }: { className?: string }) {
  const { t } = useTranslation('accounts');
  const rtl = useIsRtl();
  const { data: accounts } = useAccounts();
  const { map } = useAllMailboxData();
  const nav = useNav();
  const view = nav.view;
  // écrans hors messagerie : aucune boîte n'est « active » dans le rail
  const onContacts = nav.route === 'contacts' || nav.route === 'calendar';
  const hasContacts = (accounts ?? []).some((a) => a.capabilities.contacts);
  const hasCalendar = (accounts ?? []).some((a) => a.capabilities.calendars);
  const setView = goView;
  const setPalette = useUi((s) => s.setPalette);
  const theme = useSettings((s) => s.theme);
  const setSettings = useSettings((s) => s.set);
  const showAdd = useAddMailbox((s) => s.show);
  const reconnectIds = useReconnect((s) => s.ids);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const aiEnabled = useAiEnabled();
  const aiReady = useAiReady();

  const unreadOf = (id: string) => {
    const d = map[id];
    const inbox = roleId(d, 'inbox');
    return d?.mailboxes.find((m) => m.id === inbox)?.unreadThreads ?? 0;
  };
  const totalUnread = (accounts ?? []).reduce((s, a) => s + unreadOf(a.id), 0);
  const keepMailbox = (accountId: string) =>
    view.mailbox.kind === 'role' ? view.mailbox : accountId === view.accountId ? view.mailbox : ({ kind: 'role', role: 'inbox' } as const);
  const current = accounts?.find((a) => a.id === view.accountId) ?? (accounts?.length === 1 ? accounts[0] : undefined);
  const side = rtl ? 'left' : 'right';

  return (
    <nav aria-label={t('rail.label')} className={cn('flex w-[64px] shrink-0 flex-col items-center bg-rail py-3', className)}>
      <div className="mb-3 flex h-9 items-center">
        <Logo className="size-[30px]" />
      </div>
      <div className="flex w-full flex-1 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto py-1 [scrollbar-width:none]">
        {(accounts?.length ?? 0) > 1 && (
          <>
            <RailItem
              active={!onContacts && view.accountId === ALL}
              label={t('rail.all')}
              hint={`${MOD}+0`}
              unread={totalUnread}
              onClick={() => setView({ accountId: ALL, mailbox: view.mailbox.kind === 'role' ? view.mailbox : { kind: 'role', role: 'inbox' } })}
            >
              <span className="flex size-9 items-center justify-center rounded-[12px] border border-line-strong bg-panel text-text-1 shadow-soft">
                <Inbox className="size-[17px]" />
              </span>
            </RailItem>
            <div className="my-1.5 h-px w-6 bg-line-strong" />
          </>
        )}
        {(accounts ?? []).map((a, i) => (
          <RailItem
            key={a.id}
            active={!onContacts && view.accountId === a.id}
            label={a.displayName || a.email}
            hint={i < 9 ? `${MOD}+${i + 1}` : undefined}
            unread={unreadOf(a.id)}
            color={a.color}
            warn={reconnectIds.includes(a.id) ? t('rail.needsReconnect') : undefined}
            onClick={() => setView({ accountId: a.id, mailbox: keepMailbox(a.id) })}
            wrap={(node) => <AccountContextMenu mb={a}>{node}</AccountContextMenu>}
          >
            <AccountBadge color={a.color} label={a.displayName || a.email} />
          </RailItem>
        ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => showAdd()}
              aria-label={t('rail.add')}
              className="mt-1 flex size-9 items-center justify-center rounded-[12px] border border-dashed border-line-strong text-text-3 voxel-transition hover:border-text-3 hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none"
            >
              <Plus className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side={side} className="border-0 bg-text-1 px-2 py-1 text-[11.5px] text-app">
            {t('rail.add')}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-col items-center gap-1 pt-2">
        {aiEnabled && (
          <RailButton label={t('ai:nav')} onClick={() => openSettings('ai')} side={side} active={nav.settings === 'ai'} dot={!aiReady}>
            <Sparkles />
          </RailButton>
        )}
        {hasCalendar && (
          <RailButton label={t('calendar:nav')} hint="G A" onClick={() => goCalendar()} side={side} active={nav.route === 'calendar'}>
            <CalendarDays />
          </RailButton>
        )}
        {hasContacts && (
          <RailButton label={t('contacts:nav')} hint="G C" onClick={() => goContacts()} side={side} active={nav.route === 'contacts'}>
            <BookUser />
          </RailButton>
        )}
        <RailButton label={t('rail.palette')} hint={`${MOD}+K`} onClick={() => setPalette(true)} side={side}>
          <Command />
        </RailButton>
        <RailButton label={dark ? t('rail.lightTheme') : t('rail.darkTheme')} onClick={() => setSettings({ theme: dark ? 'light' : 'dark' })} side={side}>
          {dark ? <Sun /> : <Moon />}
        </RailButton>
        <RailButton label={t('rail.settings')} onClick={() => openSettings()} side={side}>
          <Settings />
        </RailButton>
        {current && (
          <AccountDropdown mb={current} side={side}>
            <button
              type="button"
              aria-label={t('rail.accountMenu', { email: current.email })}
              className="mt-1 flex size-9 items-center justify-center rounded-full outline-none voxel-transition hover:scale-[1.05] focus-visible:ring-2 focus-visible:ring-voxel-accent"
            >
              <AccountBadge color={current.color} label={current.displayName || current.email} size={28} className="!rounded-full" />
            </button>
          </AccountDropdown>
        )}
      </div>
    </nav>
  );
}

function RailButton({
  label,
  hint,
  onClick,
  side,
  active,
  dot,
  children,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  side: 'left' | 'right';
  active?: boolean;
  /** pastille d'accent (ex. IA activée mais pas encore configurée) */
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'relative flex size-9 items-center justify-center rounded-[10px] text-text-3 voxel-transition hover:bg-black/[0.05] hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none dark:hover:bg-white/[0.06] [&_svg]:size-[17px]',
            active && 'bg-voxel-accent-soft text-text-1',
          )}
        >
          {children}
          {dot && <span aria-hidden className="absolute end-1.5 top-1.5 size-2 rounded-full bg-voxel-accent ring-2 ring-rail" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="flex items-center gap-2 border-0 bg-text-1 px-2 py-1 text-[11.5px] text-app">
        {label}
        {hint && (
          <span className="rounded bg-white/15 px-1 text-[10.5px] dark:bg-black/15" dir="ltr">
            {hint}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
