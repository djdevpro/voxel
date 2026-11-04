import { lazy, Suspense, useEffect, useRef, type PointerEvent as RPointerEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Inbox, PenLine, Search, Menu, Plus, Mail, Settings } from 'lucide-react';
import { useAccounts, useAllMailboxData } from '@/hooks/useData';
import { useSync } from '@/hooks/useSync';
import { useReminders } from '@/hooks/useReminders';
import { useReconnect, useIsMobile } from '@/hooks/useEnvironment';
import { useShortcuts } from '@/hooks/useShortcuts';
import { ALL, useUi } from '@/store/ui';
import { useNav } from '@/nav/useNav';
import { goView, openSettings } from '@/nav/nav';
import { useSettings } from '@/store/settings';
import { AccountRail } from '@/components/rail/AccountRail';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { MessageList } from '@/components/list/MessageList';
import { Reader } from '@/components/reader/Reader';
import { SummaryList } from '@/components/ai/summaries/SummaryList';
import { SummaryReader } from '@/components/ai/summaries/SummaryReader';
import { ComposerHost } from '@/components/compose/ComposerHost';
import { AddContactDialog } from '@/components/contacts/AddContactDialog';
import { CommandPalette, ConfirmHost, OfflineBanner, ShortcutsHelp } from '@/components/common/Overlays';
import { EmptyState, AnimatedNumber } from '@/components/common/bits';
import { Button } from '@/components/ui/button';
import { restoreComposers, startCompose } from '@/components/compose/startCompose';
import { roleId } from '@/lib/mail';
import { tBase, tSlow } from '@/lib/motion';
import { setActiveAccent } from '@/lib/accent';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { Direction } from 'radix-ui';
import { useDirection } from '@/hooks/useDirection';

const SettingsDialog = lazy(() => import('@/components/settings/SettingsDialog'));
const ContactsView = lazy(() => import('@/components/contacts/ContactsView'));
const CalendarView = lazy(() => import('@/components/calendar/CalendarView'));

/** Poignée de redimensionnement des colonnes. */
function Resizer({ onResize, axis = 'x', className }: { onResize: (delta: number) => void; axis?: 'x' | 'y'; className?: string }) {
  const start = useRef<number | null>(null);
  const rtl = useDirection() === 'rtl';
  const onDown = (e: RPointerEvent) => {
    start.current = axis === 'x' ? e.clientX : e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };
  const onMove = (e: RPointerEvent) => {
    if (start.current === null) return;
    const pos = axis === 'x' ? e.clientX : e.clientY;
    // en RTL les colonnes se suivent de droite à gauche : tirer vers la gauche élargit
    onResize(axis === 'x' && rtl ? start.current - pos : pos - start.current);
    start.current = pos;
  };
  const onUp = () => {
    start.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      className={cn(
        'group relative z-10 shrink-0',
        axis === 'x' ? '-mx-[3px] w-[7px] cursor-col-resize' : '-my-[3px] h-[7px] cursor-row-resize',
        className,
      )}
    >
      <div
        className={cn(
          'absolute bg-line voxel-transition group-hover:bg-voxel-accent group-active:bg-voxel-accent',
          axis === 'x' ? 'inset-y-0 start-[3px] w-px' : 'inset-x-0 top-[3px] h-px',
        )}
      />
    </div>
  );
}

function DesktopLayout() {
  const pane = useSettings((s) => s.readingPane);
  const sidebarWidth = useSettings((s) => s.sidebarWidth);
  const listWidth = useSettings((s) => s.listWidth);
  const listHeight = useSettings((s) => s.listHeight);
  const setLayout = useSettings((s) => s.setLayout);
  const nav = useNav();
  const openThread = nav.thread;

  // écran Résumés : disposition de la messagerie, toujours côte à côte
  if (nav.route === 'summaries') {
    return (
      <div className="flex min-h-0 flex-1">
        <AccountRail />
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-ss-[14px] border-t border-s border-line bg-panel shadow-[0_0_0_1px_var(--voxel-line)]">
          <Sidebar className="shrink-0" />
          <Resizer onResize={(d) => setLayout({ sidebarWidth: Math.min(380, Math.max(200, sidebarWidth + d)) })} />
          <SummaryList className="shrink-0" />
          <Resizer onResize={(d) => setLayout({ listWidth: Math.min(760, Math.max(320, listWidth + d)) })} />
          <SummaryReader className="flex-1" />
        </div>
        <SidebarSizer />
      </div>
    );
  }

  // écrans Contacts et Agenda : le rail reste, les colonnes de la messagerie laissent la place
  if (nav.route === 'contacts' || nav.route === 'calendar') {
    return (
      <div className="flex min-h-0 flex-1">
        <AccountRail />
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-ss-[14px] border-t border-s border-line bg-panel shadow-[0_0_0_1px_var(--voxel-line)]">
          <Suspense fallback={null}>{nav.route === 'calendar' ? <CalendarView mobile={false} /> : <ContactsView mobile={false} />}</Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <AccountRail />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-ss-[14px] border-t border-s border-line bg-panel shadow-[0_0_0_1px_var(--voxel-line)] md:my-0">
        <Sidebar className="shrink-0" />
        <Resizer onResize={(d) => setLayout({ sidebarWidth: Math.min(380, Math.max(200, sidebarWidth + d)) })} />
        {pane === 'right' && (
          <>
            <MessageList className="shrink-0" />
            <Resizer onResize={(d) => setLayout({ listWidth: Math.min(760, Math.max(320, listWidth + d)) })} />
            <Reader className="flex-1" />
          </>
        )}
        {pane === 'bottom' && (
          <div className="flex min-w-0 flex-1 flex-col">
            <MessageList className="shrink-0" />
            <Resizer axis="y" onResize={(d) => setLayout({ listHeight: Math.min(window.innerHeight - 220, Math.max(180, listHeight + d)) })} />
            <Reader className="min-h-0 flex-1" />
          </div>
        )}
        {pane === 'none' && (
          <div className="relative min-w-0 flex-1">
            <AnimatePresence initial={false} mode="popLayout">
              {openThread ? (
                <motion.div key="reader" className="absolute inset-0 flex" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, pointerEvents: 'none' }} transition={tBase}>
                  <Reader className="flex-1" />
                </motion.div>
              ) : (
                <motion.div key="list" className="absolute inset-0 flex" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, pointerEvents: 'none' }} transition={tBase}>
                  <MessageList className="flex-1" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
      <SidebarSizer />
    </div>
  );
}

/** Applique les largeurs via variables CSS (évite de re-rendre les colonnes). */
function SidebarSizer() {
  const sidebarWidth = useSettings((s) => s.sidebarWidth);
  const listWidth = useSettings((s) => s.listWidth);
  const listHeight = useSettings((s) => s.listHeight);
  const readingPane = useSettings((s) => s.readingPane);
  // les résumés gardent la disposition côte à côte, quel que soit le volet de lecture
  const pane = useNav().route === 'summaries' ? 'right' : readingPane;
  const css = `
    aside[data-pane="sidebar"]{width:${sidebarWidth}px}
    ${pane === 'right' ? `section[data-pane="list"]{width:${listWidth}px}` : ''}
    ${pane === 'bottom' ? `section[data-pane="list"]{height:${listHeight}px}` : ''}
  `;
  return <style>{css}</style>;
}

function MobileLayout() {
  const nav = useNav();
  const view = nav.view;
  const drawer = useUi((s) => s.drawerOpen);
  const setDrawer = useUi((s) => s.setDrawer);
  const focusSearch = useUi((s) => s.focusSearch);
  const { data: accounts } = useAccounts();
  const { map } = useAllMailboxData();
  const ids = view.accountId === ALL ? (accounts ?? []).map((a) => a.id) : [view.accountId];
  const unread = ids.reduce((s, id) => {
    const d = map[id];
    return s + (d?.mailboxes.find((m) => m.id === roleId(d, 'inbox'))?.unreadThreads ?? 0);
  }, 0);
  // la colonne affichée découle de l'URL : Retour (bouton, geste) ramène naturellement à la liste
  const summaries = nav.route === 'summaries';
  const showReader = summaries ? !!nav.summary : !!nav.thread;
  const { t } = useTranslation();
  const rtl = useDirection() === 'rtl';
  // sens des glissements : le lecteur arrive par la fin de ligne (droite en LTR, gauche en RTL)
  const s = rtl ? -1 : 1;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-panel">
      <div className="relative min-h-0 flex-1">
        <motion.div className="absolute inset-0 flex" animate={{ x: showReader ? `${-24 * s}%` : 0, opacity: showReader ? 0.6 : 1 }} transition={tBase}>
          {summaries ? <SummaryList className="flex-1" /> : <MessageList className="flex-1" />}
        </motion.div>
        <AnimatePresence>
          {showReader && (
            <motion.div
              key="reader"
              className="absolute inset-0 z-10 flex bg-panel shadow-float"
              initial={{ x: `${100 * s}%` }}
              animate={{ x: 0 }}
              exit={{ x: `${100 * s}%` }}
              transition={tSlow}
            >
              {summaries ? <SummaryReader className="flex-1" /> : <Reader className="flex-1" />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* barre du bas */}
      {!showReader && (
        <nav aria-label={t('nav.main')} className="flex h-[58px] shrink-0 items-stretch border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          {[
            { id: 'inbox', label: t('nav.inbox'), icon: Inbox, onClick: () => goView({ accountId: view.accountId, mailbox: { kind: 'role', role: 'inbox' } }), badge: unread, active: !summaries && view.mailbox.kind === 'role' && view.mailbox.role === 'inbox' && !nav.q },
            { id: 'folders', label: t('nav.folders'), icon: Menu, onClick: () => setDrawer(true) },
            { id: 'compose', label: t('nav.compose'), icon: PenLine, onClick: () => startCompose(), primary: true },
            { id: 'search', label: t('nav.search'), icon: Search, onClick: () => focusSearch() },
            { id: 'settings', label: t('nav.settings'), icon: Settings, onClick: () => openSettings() },
          ].map((b) => (
            <button
              key={b.id}
              type="button"
              aria-label={b.primary ? b.label : undefined}
              onClick={b.onClick}
              className={cn('relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium', b.active ? 'text-text-1' : 'text-text-3')}
            >
              {b.primary ? (
                <span className="voxel-btn-tonal flex size-10 items-center justify-center rounded-full">
                  <b.icon className="size-[18px]" />
                </span>
              ) : (
                <>
                  <b.icon className="size-5" />
                  {b.label}
                </>
              )}
              {!!b.badge && (
                <span className="absolute top-1.5 start-1/2 ms-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-voxel-accent px-1 text-[10px] font-semibold text-on-accent">
                  <AnimatedNumber value={b.badge} max={99} />
                </span>
              )}
            </button>
          ))}
        </nav>
      )}
      {/* tiroir : rail + dossiers */}
      <AnimatePresence>
        {drawer && (
          <>
            <motion.div key="scrim" className="fixed inset-0 z-40 bg-(--voxel-overlay)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tBase} onClick={() => setDrawer(false)} />
            <motion.div
              key="drawer"
              className="fixed inset-y-0 start-0 z-50 flex w-[86%] max-w-[340px] border-e border-(--voxel-float-border) bg-sidebar pt-[env(safe-area-inset-top)] shadow-(--voxel-float-shadow)"
              initial={{ x: `${-100 * s}%` }}
              animate={{ x: 0 }}
              exit={{ x: `${-100 * s}%` }}
              transition={tSlow}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={rtl ? { left: 0, right: 0.5 } : { left: 0.5, right: 0 }}
              onDragEnd={(_, info) => info.offset.x * s < -70 && setDrawer(false)}
            >
              <AccountRail />
              <Sidebar className="min-w-0 flex-1" onNavigate={() => setDrawer(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function NoAccounts() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={<Mail />}
        title={t('noAccounts.title')}
        description={t('noAccounts.description')}
        action={
          <Button onClick={() => openSettings('accounts')}>
            <Plus /> {t('noAccounts.add')}
          </Button>
        }
      />
    </div>
  );
}

export default function MailApp() {
  const { data: accounts, isLoading } = useAccounts();
  const nav = useNav();
  const view = nav.view;
  const settingsOpen = !!nav.settings;
  const hydrate = useSettings((s) => s.hydrate);
  const mobile = useIsMobile();
  const dir = useDirection();
  useSync(accounts);
  useReminders(accounts);
  useReconnect();
  useShortcuts();

  useEffect(() => {
    void hydrate();
    void restoreComposers();
  }, [hydrate]);

  // Vue unifiée avec une seule boîte : on bascule sur cette boîte (même dossier)
  useEffect(() => {
    if (accounts?.length === 1 && nav.scope === 'all') goView({ accountId: accounts[0]!.id, mailbox: view.mailbox }, { replace: true });
  }, [accounts, nav.scope, view.mailbox]);

  const accent = view.accountId === ALL ? undefined : accounts?.find((a) => a.id === view.accountId)?.color;

  // accent de la boîte active, rendu lisible pour la collection et le mode (posé sur <html> : portails compris)
  useEffect(() => {
    setActiveAccent(accent);
  }, [accent]);
  useEffect(() => () => setActiveAccent(null), []);

  return (
    <Direction.Provider dir={dir}>
    <div className="flex h-full flex-col bg-rail">
      <OfflineBanner />
      {isLoading && !accounts ? (
        <div className="flex flex-1" />
      ) : !accounts?.length ? (
        <NoAccounts />
      ) : mobile ? (
        nav.route === 'contacts' ? (
          <Suspense fallback={null}>
            <ContactsView mobile />
          </Suspense>
        ) : nav.route === 'calendar' ? (
          <Suspense fallback={null}>
            <div className="flex h-full min-h-0 flex-col bg-panel">
              <CalendarView mobile />
            </div>
          </Suspense>
        ) : (
          <MobileLayout />
        )
      ) : (
        <DesktopLayout />
      )}
      <ComposerHost />
      <CommandPalette />
      <ShortcutsHelp />
      <ConfirmHost />
      <AddContactDialog />
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog />
        </Suspense>
      )}
    </div>
    </Direction.Provider>
  );
}
