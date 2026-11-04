import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion } from 'motion/react';
import {
  Archive,
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  CircleSlash,
  Flag,
  FolderInput,
  Inbox,
  Mail,
  MailOpen,
  Paperclip,
  RefreshCw,
  SearchX,
  Send,
  Trash2,
  X,
  AlertCircle,
  File,
  Archive as ArchiveIcon,
  Menu,
  ShieldCheck,
} from 'lucide-react';
import { flattenTree, mailboxTree } from '@voxel/jmap';
import { useAccounts, useAllMailboxData, useThreads } from '@/hooks/useData';
import { useThreadActions } from '@/hooks/useThreadActions';
import { ALL, threadKey, useUi, viewKey } from '@/store/ui';
import { useNav } from '@/nav/useNav';
import { useAiReady } from '@/lib/ai/store';
import { useAiChat } from '@/store/aiChat';
import { ChatHeader } from '@/components/ai/chat/ChatHeader';
import { ChatInput } from '@/components/ai/chat/ChatInput';
import { openThread as navOpenThread, threadTarget, toggleQuick, type Target } from '@/nav/nav';
import { useElementScrollRestoration } from '@tanstack/react-router';
import { useSettings } from '@/store/settings';
import { mailboxLabel, roleLabel, SYSTEM_ROLES, roleId, threadQuery, viewMailboxId, type ThreadItem } from '@/lib/mail';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ThreadRow } from './ThreadRow';
import { SearchBar } from './SearchBar';
import { AnimatedNumber, EmptyState, IconButton } from '@/components/common/bits';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { tBase, tFast } from '@/lib/motion';
import { queryClient } from '@/lib/queryClient';
import { openDraft } from '@/components/compose/startCompose';
import type { Identity } from '@voxel/jmap';
import { useIsMobile } from '@/hooks/useEnvironment';
import { formatList } from '@/lib/format';

function SkeletonRows({ count = 9, compact }: { count?: number; compact: boolean }) {
  return (
    <div aria-hidden className="px-3">
      {Array.from({ length: count }).map((_, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 - i * 0.07 }}
          transition={{ ...tBase, delay: i * 0.025 }}
          className="flex h-[var(--voxel-row-h)] items-center gap-3 border-b border-line/60"
        >
          {!compact && <div className="voxel-skeleton ms-1.5 size-8 shrink-0 rounded-full" />}
          <div className="flex-1 space-y-2">
            <div className="voxel-skeleton h-3 rounded" style={{ width: `${28 + ((i * 37) % 30)}%` }} />
            {!compact && <div className="voxel-skeleton h-2.5 rounded" style={{ width: `${55 + ((i * 53) % 35)}%` }} />}
          </div>
          <div className="voxel-skeleton h-2.5 w-10 rounded" />
        </motion.div>
      ))}
    </div>
  );
}

function emptyFor(role: string | null, searching: boolean, t: TFunction<'mail'>) {
  const e = (key: string, icon: React.ReactNode, withDescription = true) => ({
    icon,
    title: t(`empty.${key}.title`),
    description: withDescription ? t(`empty.${key}.description`) : undefined,
  });
  if (searching) return e('search', <SearchX />);
  switch (role) {
    case 'inbox':
      return e('inbox', <Inbox />);
    case 'flagged':
      return e('flagged', <Flag />);
    case 'drafts':
      return e('drafts', <File />);
    case 'sent':
      return e('sent', <Send className="rtl:-scale-x-100" />, false);
    case 'archive':
      return e('archive', <ArchiveIcon />);
    case 'junk':
      return e('junk', <ShieldCheck />);
    case 'trash':
      return e('trash', <Trash2 />, false);
    default:
      return e('folder', <Inbox />, false);
  }
}

// moteur IA (AI SDK) chargé à l'ouverture de la discussion
const AiConversation = lazy(() => import('@/components/ai/chat/AiConversation').then((m) => ({ default: m.AiConversation })));

/** Attente discrète pendant le chargement de la discussion. */
function ChatLoading() {
  return (
    <div aria-hidden className="mx-auto flex w-full max-w-[760px] flex-col gap-2 px-4 py-5">
      <div className="voxel-skeleton h-3.5 w-40 rounded" />
    </div>
  );
}

export function MessageList({ className }: { className?: string }) {
  const nav = useNav();
  const sortAsc = useUi((s) => s.sortAsc);
  const k = `${viewKey(nav.view)}|${nav.q}|${nav.filter ?? ''}|${sortAsc}`;
  const { t } = useTranslation('mail');
  const aiReady = useAiReady('chat');
  const chatOpen = useAiChat((s) => s.open) && aiReady;
  const session = useAiChat((s) => s.session);
  const ask = useAiChat((s) => s.ask);
  const closeChat = useAiChat((s) => s.closeChat);

  // changement de dossier ou de boîte : la liste revient (la discussion est gardée)
  const view = viewKey(nav.view);
  const firstView = useRef(view);
  useEffect(() => {
    if (firstView.current === view) return;
    firstView.current = view;
    closeChat();
  }, [view, closeChat]);

  return (
    <section aria-label={t('list.region')} data-pane="list" className={cn('flex min-h-0 min-w-0 flex-col bg-panel', className)}>
      {chatOpen ? <ChatHeader /> : <ListHeader />}
      <div className="relative min-h-0 flex-1">
        <AnimatePresence initial={false}>
          {chatOpen ? (
            <motion.div
              key={`chat-${session}`}
              className="absolute inset-0 flex flex-col"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, pointerEvents: 'none' }}
              transition={tBase}
            >
              <Suspense fallback={<ChatLoading />}>
                <AiConversation />
              </Suspense>
            </motion.div>
          ) : (
            <motion.div key={k} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, pointerEvents: 'none' }} transition={tBase}>
              <ListBody />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="shrink-0 border-t border-line px-3 pt-2.5 pb-3">
        {chatOpen ? <ChatInput /> : <SearchBar placement="bottom" onAsk={aiReady ? ask : undefined} />}
      </div>
    </section>
  );
}

function ListHeader() {
  const { data: accounts } = useAccounts();
  const { map } = useAllMailboxData();
  const nav = useNav();
  const view = nav.view;
  const quick = nav.quick;
  const sortAsc = useUi((s) => s.sortAsc);
  const setSortAsc = useUi((s) => s.setSortAsc);
  const selected = useUi((s) => s.selected);
  const setSelected = useUi((s) => s.setSelected);
  const clearSelection = useUi((s) => s.clearSelection);
  const setDrawer = useUi((s) => s.setDrawer);
  const searching = nav.search.chips.length > 0 || nav.search.text.length > 0;
  const { items, total, refetch, isFetching } = useThreads();
  const actions = useThreadActions();
  const mobile = useIsMobile();
  const { t } = useTranslation('mail');

  const account = accounts?.find((a) => a.id === view.accountId);
  const viewMailbox = view.mailbox.kind === 'id' ? map[view.accountId]?.mailboxes.find((m) => m.id === (view.mailbox as { id: string }).id) : undefined;
  const title = searching
    ? t('list.results')
    : view.mailbox.kind === 'role'
      ? roleLabel(view.mailbox.role)
      : viewMailbox
        ? mailboxLabel(viewMailbox)
        : t('list.folder');
  const subtitle = view.accountId === ALL ? t('list.allMailboxes') : (account?.displayName ?? account?.email ?? '');

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.key));
  const someSelected = selected.size > 0;
  const selItems = items.filter((i) => selected.has(i.key));
  const selAccounts = new Set(selItems.map((i) => i.accountId));
  const moveAccount = selAccounts.size === 1 ? [...selAccounts][0]! : view.accountId !== ALL ? view.accountId : null;
  const moveTargets = useMemo(() => {
    if (!moveAccount) return [];
    const d = map[moveAccount];
    if (!d) return [];
    const current = viewMailboxId(d, view, moveAccount);
    const custom = d.mailboxes.filter((m) => !m.role || !SYSTEM_ROLES.includes(m.role as never));
    const sys = (['inbox', 'archive'] as const)
      .map((r) => d.mailboxes.find((m) => m.id === roleId(d, r)))
      .filter((m) => m && m.id !== current)
      .map((m) => ({ id: m!.id, name: mailboxLabel(m!), depth: 0, sep: false }));
    const folders = flattenTree(mailboxTree(custom.map((m) => (m.parentId && !custom.some((c) => c.id === m.parentId) ? { ...m, parentId: null } : m))))
      .filter((m) => m.id !== current)
      .map((m, i) => ({ id: m.id, name: m.name, depth: m.depth, sep: i === 0 && sys.length > 0 }));
    return [...sys, ...folders];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveAccount, map, view, t]);
  const anyUnread = selItems.some((i) => i.unread);
  const allFlagged = selItems.length > 0 && selItems.every((i) => i.flagged);
  const junkView = selItems.length > 0 && selItems.every((i) => actions.isJunkView(i));

  return (
    <header className="@container shrink-0 border-b border-line">
      <div className="relative h-11">
        <AnimatePresence initial={false} mode="popLayout">
          {someSelected ? (
            <motion.div
              key="bulk"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={tFast}
              className="absolute inset-0 flex items-center gap-1 px-3"
            >
              <Checkbox
                checked={allSelected ? true : 'indeterminate'}
                onCheckedChange={() => (allSelected ? clearSelection() : setSelected(new Set(items.map((i) => i.key))))}
                aria-label={t('list.selectAll')}
                className="me-1.5 ms-[13px] size-[18px] rounded-[5px] border-line-strong data-[state=checked]:border-voxel-accent data-[state=checked]:bg-voxel-accent data-[state=indeterminate]:border-voxel-accent data-[state=indeterminate]:bg-voxel-accent data-[state=indeterminate]:text-on-accent"
              />
              <span className="me-2 text-[13px] font-medium text-text-1 tabular">
                <AnimatedNumber value={selected.size} /> <span className="font-normal text-text-2">{t('list.selected', { count: selected.size })}</span>
              </span>
              <IconButton label={t('actions.archive')} shortcut="E" onClick={() => actions.archive()}>
                <Archive />
              </IconButton>
              <IconButton label={t('actions.delete')} shortcut="#" onClick={() => actions.trash()}>
                <Trash2 />
              </IconButton>
              <IconButton label={junkView ? t('actions.notSpam') : t('actions.spam')} shortcut="!" onClick={() => actions.spam()}>
                <CircleSlash />
              </IconButton>
              <IconButton label={anyUnread ? t('actions.markRead') : t('actions.markUnread')} shortcut={anyUnread ? '⇧I' : '⇧U'} onClick={() => actions.markRead(anyUnread)}>
                {anyUnread ? <MailOpen /> : <Mail />}
              </IconButton>
              <IconButton label={allFlagged ? t('actions.unflag') : t('actions.flag')} shortcut="S" onClick={() => actions.toggleFlag()}>
                <Flag className={cn(allFlagged && 'fill-flag text-flag')} />
              </IconButton>
              <DropdownMenu>
                <DropdownMenuTrigger asChild disabled={!moveAccount}>
                  <IconButton label={moveAccount ? t('actions.moveTo') : t('list.multiAccountSelection')}>
                    <FolderInput />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-80 w-56">
                  <DropdownMenuLabel className="text-[11.5px] font-medium text-text-3">{t('actions.moveTo')}</DropdownMenuLabel>
                  {moveTargets.map((m) => (
                    <div key={m.id}>
                      {m.sep && <DropdownMenuSeparator />}
                      <DropdownMenuItem onSelect={() => actions.move(m.id, m.name)} style={{ paddingInlineStart: 8 + m.depth * 12 }}>
                        {m.name}
                      </DropdownMenuItem>
                    </div>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="flex-1" />
              <IconButton label={t('list.clearSelection')} shortcut={t('shortcuts:keys.esc')} onClick={clearSelection}>
                <X />
              </IconButton>
            </motion.div>
          ) : (
            <motion.div
              key="title"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={tFast}
              className="absolute inset-0 flex items-center gap-2 px-4"
            >
              {mobile && (
                <IconButton label={t('common:nav.menu')} onClick={() => setDrawer(true)} className="-ms-2">
                  <Menu />
                </IconButton>
              )}
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-text-1">{title}</h2>
                <span className="hidden truncate text-[12px] text-text-3 @[400px]:inline">
                  {subtitle}
                  {total !== undefined && total > 0 && (
                    <>
                      {' · '}
                      <AnimatedNumber value={total} max={99999} />
                    </>
                  )}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {(
                  [
                    ['unread', Mail],
                    ['flagged', Flag],
                    ['attachment', Paperclip],
                  ] as const
                ).map(([key, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={quick[key]}
                    title={t(`list.quick.${key}Long`)}
                    aria-label={t(`list.quick.${key}Long`)}
                    onClick={() => toggleQuick(key)}
                    className={cn(
                      'flex h-7 items-center gap-1.5 rounded-full border px-2 text-[12px] font-medium whitespace-nowrap voxel-transition @[520px]:px-2.5',
                      quick[key]
                        ? 'border-transparent bg-voxel-accent-soft text-voxel-accent-strong'
                        : 'border-line text-text-2 hover:border-line-strong hover:text-text-1',
                    )}
                  >
                    <Icon className="size-3" />
                    <span className="hidden @[520px]:inline">{t(`list.quick.${key}`)}</span>
                  </button>
                ))}
                <IconButton label={sortAsc ? t('list.oldestFirst') : t('list.newestFirst')} onClick={() => setSortAsc(!sortAsc)} size="sm">
                  {sortAsc ? <ArrowUpNarrowWide /> : <ArrowDownNarrowWide />}
                </IconButton>
                <IconButton label={t('common:actions.refresh')} onClick={() => refetch()} size="sm">
                  <RefreshCw className={cn(isFetching && 'animate-spin [animation-duration:900ms]')} />
                </IconButton>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}

function ListBody() {
  const { data: accounts } = useAccounts();
  const nav = useNav();
  const view = nav.view;
  const selected = useUi((s) => s.selected);
  const openThread = nav.thread;
  const focusedKey = useUi((s) => s.focusedKey);
  const leaving = useUi((s) => s.leaving);
  const searching = nav.search.chips.length > 0 || nav.search.text.length > 0;
  const density = useSettings((s) => s.density);
  const compact = density === 'compact';
  const mobile = useIsMobile();
  const { items, isLoading, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, accountErrors } = useThreads();
  const actions = useThreadActions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation('mail');

  const rowH = compact ? 52 : 68;
  // position de défilement restaurée au retour (Retour du navigateur)
  const scrollEntry = useElementScrollRestoration({ id: 'thread-list' });
  const virtualizer = useVirtualizer({
    initialOffset: scrollEntry?.scrollY,
    count: items.length + (hasNextPage ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 8,
    getItemKey: (i) => items[i]?.key ?? `loader-${i}`,
  });

  const vItems = virtualizer.getVirtualItems();
  const last = vItems[vItems.length - 1];
  useEffect(() => {
    if (!last) return;
    if (last.index >= items.length - 8 && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [last?.index, items.length, hasNextPage, isFetchingNextPage, fetchNextPage, last]);

  // Garde la ligne focalisée visible (navigation j/k)
  useEffect(() => {
    if (!focusedKey) return;
    const idx = items.findIndex((i) => i.key === focusedKey);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedKey]);

  const accountMeta = useMemo(() => Object.fromEntries((accounts ?? []).map((a) => [a.id, { color: a.color, label: a.displayName || a.email }])), [accounts]);
  const roleOfView = view.mailbox.kind === 'role' ? view.mailbox.role : null;
  const sentView = !searching && roleOfView === 'sent';
  const draftsView = !searching && roleOfView === 'drafts';

  /**
   * Clic sur une ligne (lien) : Maj+clic = plage, Ctrl/⌘+clic = bascule si une sélection est en cours
   * (sinon le navigateur ouvre la conversation dans un nouvel onglet), clic simple = ouvrir (push).
   */
  const onOpen = useCallback(
    async (t: ThreadItem, e: MouseEvent) => {
      const ui = useUi.getState();
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && ui.selected.size === 0) return; // nouvel onglet
      if (e.button !== 0) return;
      e.preventDefault();
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        const next = new Set(ui.selected);
        if (e.shiftKey && ui.anchorKey) {
          const a = items.findIndex((i) => i.key === ui.anchorKey);
          const b = items.findIndex((i) => i.key === t.key);
          if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(items[i]!.key);
        } else if (next.has(t.key)) next.delete(t.key);
        else next.add(t.key);
        ui.setSelected(next, t.key);
        return;
      }
      if (t.draft && (draftsView || t.count === 1)) {
        try {
          const data = await queryClient.fetchQuery(threadQuery(t.accountId, t.threadId));
          const email = data.emails.find((x) => x.id === t.emailId) ?? data.emails[data.emails.length - 1];
          if (email) openDraft(email, t.accountId, queryClient.getQueryData<Identity[]>(['identities', t.accountId]));
        } catch {
          /* ignore */
        }
        return;
      }
      ui.setSelected(ui.selected, t.key);
      ui.setFocused(t.key);
      navOpenThread({ accountId: t.accountId, threadId: t.threadId });
    },
    [items, draftsView],
  );

  // cibles des liens des lignes (vrais <a href>) : même dossier, même recherche
  const linkFor = useCallback(
    (t: ThreadItem): Target | null => threadTarget(view, { accountId: t.accountId, threadId: t.threadId }, { q: nav.q, filter: nav.filter }, accounts ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewKey(view), nav.q, nav.filter, accounts],
  );
  const fromListState = useMemo(() => ({ voxelFromList: nav.route === 'list' }), [nav.route]);

  const onToggleSelect = useCallback(
    (t: ThreadItem, shift: boolean) => {
      const ui = useUi.getState();
      const next = new Set(ui.selected);
      if (shift && ui.anchorKey) {
        const a = items.findIndex((i) => i.key === ui.anchorKey);
        const b = items.findIndex((i) => i.key === t.key);
        if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(items[i]!.key);
      } else if (next.has(t.key)) next.delete(t.key);
      else next.add(t.key);
      ui.setSelected(next, t.key);
    },
    [items],
  );

  const handlers = useMemo(
    () => ({
      linkFor,
      linkState: fromListState,
      onOpen,
      onToggleSelect,
      onArchive: (t: ThreadItem) => actions.archive([t.key]),
      onTrash: (t: ThreadItem) => void actions.trash([t.key]),
      onToggleRead: (t: ThreadItem) => actions.toggleRead([t.key]),
      onToggleFlag: (t: ThreadItem) => actions.toggleFlag([t.key]),
      getDragKeys: (t: ThreadItem) => {
        const sel = useUi.getState().selected;
        return sel.has(t.key) ? [...sel] : [t.key];
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linkFor, fromListState, onOpen, onToggleSelect, actions.archive, actions.trash, actions.toggleRead, actions.toggleFlag],
  );

  if (isLoading) return <SkeletonRows compact={compact} />;
  if (isError && !items.length)
    return (
      <EmptyState
        icon={<AlertCircle />}
        title={t('list.loadError')}
        description={(error as Error)?.message || t('list.serverDown')}
        action={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw /> {t('common:actions.retry')}
          </Button>
        }
      />
    );
  if (!items.length) {
    const e = emptyFor(roleOfView, searching, t);
    return <EmptyState icon={e.icon} title={e.title} description={e.description} />;
  }

  const openKey = openThread ? threadKey(openThread.accountId, openThread.threadId) : null;
  const errs = Object.keys(accountErrors);

  return (
    <div ref={scrollRef} data-scroll-restoration-id="thread-list" className="h-full overflow-y-auto overscroll-contain" role="listbox" aria-multiselectable aria-label={t('list.conversations')}>
      {errs.length > 0 && (
        <div className="flex items-center gap-2 border-b border-line bg-[color-mix(in_oklab,var(--voxel-warn)_10%,transparent)] px-4 py-2 text-[12.5px] text-text-2">
          <AlertCircle className="size-3.5 text-[var(--voxel-warn)]" />
          {t('list.partialError', { accounts: formatList(errs.map((a) => accountMeta[a]?.label ?? a)) })}
        </div>
      )}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {vItems.map((v) => {
          const t = items[v.index];
          return (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
            >
              {t ? (
                <ThreadRow
                  item={t}
                  selected={selected.has(t.key)}
                  selectionMode={selected.size > 0}
                  active={openKey === t.key}
                  focused={focusedKey === t.key}
                  leaving={leaving.has(t.key)}
                  compact={compact}
                  showAccount={view.accountId === ALL && (accounts?.length ?? 0) > 1 ? accountMeta[t.accountId] : undefined}
                  sentView={sentView}
                  mobile={mobile}
                  {...handlers}
                />
              ) : (
                <SkeletonRows count={2} compact={compact} />
              )}
            </div>
          );
        })}
      </div>
      {!hasNextPage && items.length > 12 && <div className="py-6 text-center text-[11.5px] text-text-3">{t('list.end')}</div>}
    </div>
  );
}
