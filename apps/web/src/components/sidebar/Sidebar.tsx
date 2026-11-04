import { Fragment, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Download as DownloadIcon, Upload as UploadIcon } from 'lucide-react';
import { exportMailbox, importIntoMailbox, IMPORT_ACCEPT, pickFiles } from '@/lib/mailboxTransfer';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  Archive,
  ChevronRight,
  CircleSlash,
  File,
  Flag,
  Folder,
  FolderPlus,
  Inbox,
  MailCheck,
  MoreHorizontal,
  Palette,
  PenLine,
  Plus,
  Send,
  Clock,
  Trash2,
  CloudOff,
  CornerDownRight,
  EyeOff,
  FolderTree,
} from 'lucide-react';
import { mailboxTree, type Mailbox, type MailboxNode } from '@voxel/jmap';
import { useAccounts, useAllMailboxData } from '@/hooks/useData';
import { useThreadActions } from '@/hooks/useThreadActions';
import { useLocalState } from '@/hooks/useLocalState';
import { ALL, type MailboxSel, type SystemRole, type View } from '@/store/ui';
import { useNav } from '@/nav/useNav';
import { goView, listTarget, openSettings } from '@/nav/nav';
import { RouteLink } from '@/nav/links';
import { SummariesNavRow } from '@/components/ai/summaries/SummariesNavRow';
import { useSettings } from '@/store/settings';
import { confirmDialog } from '@/store/confirm';
import { roleLabel, SYSTEM_ROLES, roleId, type MailboxData } from '@/lib/mail';
import { useTranslation } from 'react-i18next';
import { archiveThreads, createMailbox, deleteMailbox, markMailboxRead, moveThreads, renameMailbox, setFlagged, spamThreads, trashThreads } from '@/lib/actions';
import { AccountDot, AnimatedNumber } from '@/components/common/bits';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { tBase, tFast } from '@/lib/motion';
import { useOutboxCount } from '@/hooks/useOutboxCount';
import { useOnline } from '@/hooks/useEnvironment';
import { startCompose } from '@/components/compose/startCompose';
import { QuotaBar } from '@/components/quota/QuotaBar';
import { compareMailboxes, moveMailboxTo, setSubscribed } from '@/lib/folders';
import { confirmEmptyFolder } from '@/components/settings/emptyFolder';
import { errorMessage } from '@/lib/api';

export const ROLE_ICONS: Record<SystemRole, typeof Inbox> = {
  inbox: Inbox,
  flagged: Flag,
  drafts: File,
  sent: Send,
  scheduled: Clock,
  archive: Archive,
  junk: CircleSlash,
  trash: Trash2,
};

export const FOLDER_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'];

const DND_TYPE = 'application/x-voxel-threads';
/** Glisser un dossier sur un autre pour l'y imbriquer. */
const DND_FOLDER = 'application/x-voxel-folder';

export function readDragKeys(e: DragEvent): string[] | null {
  const raw = e.dataTransfer.getData(DND_TYPE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
}
export { DND_TYPE };

function roleCount(role: SystemRole, d: MailboxData | undefined): number {
  if (!d) return 0;
  const id = roleId(d, role);
  const m = d.mailboxes.find((x) => x.id === id);
  if (!m) return 0;
  if (role === 'drafts' || role === 'scheduled') return m.totalEmails;
  if (role === 'inbox' || role === 'junk') return m.unreadThreads;
  return 0;
}

// ------------------------------------------------------------------ ligne

interface MenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  separatorBefore?: boolean;
  colors?: { current?: string; onPick: (c: string | null) => void };
}

function FolderRow({
  label,
  icon,
  count,
  countMuted,
  active,
  depth = 0,
  color,
  expandable,
  expanded,
  onToggle,
  to,
  onClick,
  onDropKeys,
  dragFolder,
  onDropFolder,
  menu,
  editing,
  onRename,
  onCancelEdit,
}: {
  label: string;
  icon: ReactNode;
  count?: number;
  countMuted?: boolean;
  active: boolean;
  depth?: number;
  color?: string;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  /** vue ouverte par la ligne : vrai lien `<a href>` (Ctrl+clic = nouvel onglet) */
  to: View;
  onClick?: () => void;
  onDropKeys?: (keys: string[]) => void;
  /** `<compte>:<id>` du dossier perso que l'on peut glisser */
  dragFolder?: string;
  /** dépôt d'un dossier glissé (`<compte>:<id>`) : imbrication */
  onDropFolder?: (key: string) => void;
  menu?: MenuItem[];
  editing?: boolean;
  onRename?: (name: string) => void;
  onCancelEdit?: () => void;
}) {
  const [over, setOver] = useState(false);
  const depthRef = useRef(0);
  const { t } = useTranslation('mail');
  const accepts = (e: DragEvent) => (!!onDropKeys && e.dataTransfer.types.includes(DND_TYPE)) || (!!onDropFolder && e.dataTransfer.types.includes(DND_FOLDER));
  const row = (
    <div
      role="treeitem"
      aria-selected={active}
      aria-expanded={expandable ? expanded : undefined}
      tabIndex={-1}
      draggable={!!dragFolder && !editing}
      onDragStart={(e) => {
        if (!dragFolder) return;
        e.dataTransfer.setData(DND_FOLDER, dragFolder);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnter={(e) => {
        if (!accepts(e)) return;
        depthRef.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDragLeave={() => {
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        depthRef.current = 0;
        setOver(false);
        const keys = readDragKeys(e);
        if (keys && onDropKeys) {
          e.preventDefault();
          onDropKeys(keys);
          return;
        }
        const folder = e.dataTransfer.getData(DND_FOLDER);
        if (folder && onDropFolder) {
          e.preventDefault();
          onDropFolder(folder);
        }
      }}
      className={cn(
        'group relative flex h-[30px] items-center gap-2 rounded-md pe-1.5 text-[13.5px] voxel-transition select-none',
        active ? 'bg-voxel-accent-soft font-medium text-text-1' : 'text-text-2 hover:bg-black/[0.04] hover:text-text-1 dark:hover:bg-white/[0.05]',
        over && 'bg-voxel-accent-soft ring-1 ring-voxel-accent ring-inset',
      )}
      style={{ paddingInlineStart: 8 + depth * 14 }}
    >
      {expandable ? (
        <button
          type="button"
          aria-label={expanded ? t('sidebar.collapse') : t('sidebar.expand')}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          className="-ms-1 flex size-4 items-center justify-center rounded text-text-3 hover:text-text-1"
        >
          <ChevronRight className={cn('size-3.5 transition-transform duration-150 ease-voxel rtl:-scale-x-100', expanded && 'rotate-90 rtl:-rotate-90')} />
        </button>
      ) : depth > 0 ? (
        <span className="-ms-1 w-4" />
      ) : null}
      <span
        className={cn('flex size-4 shrink-0 items-center justify-center [&_svg]:size-[15px]', active ? 'text-voxel-accent-strong' : 'text-text-3 group-hover:text-text-2')}
        style={color ? { color } : undefined}
      >
        {icon}
      </span>
      {editing ? (
        <input
          autoFocus
          defaultValue={label}
          aria-label={t('sidebar.folderName')}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onRename?.((e.target as HTMLInputElement).value.trim());
            if (e.key === 'Escape') onCancelEdit?.();
          }}
          onBlur={(e) => onRename?.(e.target.value.trim())}
          className="h-6 min-w-0 flex-1 rounded border border-voxel-accent bg-panel px-1.5 text-[13px] text-text-1 outline-none ring-2 ring-voxel-accent-soft"
        />
      ) : (
        <RouteLink
          link={listTarget(to)}
          draggable={dragFolder ? false : undefined}
          onClick={(e) => {
            if (!e.defaultPrevented && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) onClick?.();
          }}
          aria-current={active ? 'page' : undefined}
          className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-voxel-accent"
          aria-label={label}
        />
      )}
      {!editing && (
        <span dir="auto" className="pointer-events-none relative min-w-0 flex-1 truncate rtl:text-right">
          {label}
        </span>
      )}
      {!editing && !!count && (
        <span className={cn('pointer-events-none relative text-[11.5px] tabular group-hover:opacity-0', countMuted ? 'text-text-3' : 'font-semibold text-text-1', menu && 'transition-opacity')}>
          <AnimatedNumber value={count} />
        </span>
      )}
      {!editing && menu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('sidebar.actionsFor', { name: label })}
              className="absolute end-1 flex size-6 items-center justify-center rounded text-text-3 opacity-0 voxel-transition group-hover:opacity-100 hover:bg-black/[0.06] hover:text-text-1 focus-visible:opacity-100 data-[state=open]:opacity-100 dark:hover:bg-white/[0.08]"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            {menu.map((m) => (
              <MenuEntry key={m.id} m={m} kind="dropdown" />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
  if (!menu) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {menu.map((m) => (
          <MenuEntry key={m.id} m={m} kind="context" />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MenuEntry({ m, kind }: { m: MenuItem; kind: 'context' | 'dropdown' }) {
  const { t } = useTranslation('mail');
  const Item = kind === 'context' ? ContextMenuItem : DropdownMenuItem;
  const Sep = kind === 'context' ? ContextMenuSeparator : DropdownMenuSeparator;
  const Sub = kind === 'context' ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger = kind === 'context' ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent = kind === 'context' ? ContextMenuSubContent : DropdownMenuSubContent;
  return (
    <>
      {m.separatorBefore && <Sep />}
      {m.colors ? (
        <Sub>
          <SubTrigger className="gap-2 [&_svg:not([class*='text-'])]:text-text-3">
            {m.icon}
            {m.label}
          </SubTrigger>
          <SubContent className="p-2">
            <div className="grid grid-cols-5 gap-1.5">
              <button
                type="button"
                aria-label={t('sidebar.noColor')}
                onClick={() => m.colors!.onPick(null)}
                className={cn('flex size-6 items-center justify-center rounded-full border border-line-strong text-text-3', !m.colors.current && 'ring-2 ring-voxel-accent ring-offset-1 ring-offset-popover')}
              >
                <CircleSlash className="size-3" />
              </button>
              {FOLDER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={t('sidebar.colorValue', { color: c })}
                  onClick={() => m.colors!.onPick(c)}
                  className={cn('size-6 rounded-full voxel-transition hover:scale-110', m.colors!.current === c && 'ring-2 ring-offset-1 ring-offset-popover')}
                  style={{ background: c, ['--tw-ring-color' as string]: c }}
                />
              ))}
            </div>
          </SubContent>
        </Sub>
      ) : (
        <Item onSelect={m.onSelect} variant={m.destructive ? 'destructive' : 'default'} className="gap-2 [&_svg:not([class*='text-'])]:text-text-3">
          {m.icon}
          {m.label}
        </Item>
      )}
    </>
  );
}

// ------------------------------------------------------------------ arbre perso

/** Export `.mbox` et import `.eml`/`.mbox` d'un dossier. */
function transferItems(accountId: string, mailboxId: string, name: string, t: (k: string) => string): MenuItem[] {
  return [
    { id: 'export', label: t('transfer.export'), icon: <DownloadIcon />, separatorBefore: true, onSelect: () => void exportMailbox(accountId, mailboxId, name) },
    {
      id: 'import',
      label: t('transfer.import'),
      icon: <UploadIcon />,
      onSelect: () => void pickFiles(IMPORT_ACCEPT).then((files) => importIntoMailbox(accountId, mailboxId, name, files)),
    },
  ];
}

function useFolderOps(accountId: string) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  const folderColors = useSettings((s) => s.folderColors);
  const setSettings = useSettings((s) => s.set);
  const setColor = (id: string, c: string | null) => {
    const next = { ...folderColors };
    if (c) next[`${accountId}:${id}`] = c;
    else delete next[`${accountId}:${id}`];
    setSettings({ folderColors: next });
  };
  return { editing, setEditing, creatingUnder, setCreatingUnder, folderColors, setColor };
}

function NewFolderInput({ depth, onDone }: { depth: number; onDone: (name: string | null) => void }) {
  const { t } = useTranslation('mail');
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 30 }} exit={{ opacity: 0, height: 0 }} transition={tFast} className="flex items-center gap-2 overflow-hidden pe-1.5" style={{ paddingInlineStart: 8 + depth * 14 }}>
      {depth > 0 && <CornerDownRight className="size-3.5 shrink-0 text-text-3 rtl:-scale-x-100" />}
      <Folder className="size-[15px] shrink-0 text-text-3" />
      <input
        autoFocus
        placeholder={t('sidebar.folderName')}
        aria-label={t('sidebar.folderName')}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') onDone((e.target as HTMLInputElement).value.trim() || null);
          if (e.key === 'Escape') onDone(null);
        }}
        onBlur={(e) => onDone(e.target.value.trim() || null)}
        className="h-6 min-w-0 flex-1 rounded border border-voxel-accent bg-panel px-1.5 text-[13px] text-text-1 outline-none ring-2 ring-voxel-accent-soft placeholder:text-text-3"
      />
    </motion.div>
  );
}

function CustomTree({
  accountId,
  data,
  onNavigate,
  onLinkNavigate,
  creatingRoot,
  setCreatingRoot,
}: {
  accountId: string;
  data: MailboxData;
  onNavigate: (sel: MailboxSel, accountId: string) => void;
  /** après un clic sur un dossier (fermeture du tiroir mobile) */
  onLinkNavigate?: () => void;
  creatingRoot: boolean;
  setCreatingRoot: (v: boolean) => void;
}) {
  const view = useNav().view;
  const ops = useFolderOps(accountId);
  const actions = useThreadActions();
  const [expanded, setExpanded] = useLocalState<Record<string, boolean>>('voxel-folders-expanded', {});
  const { t } = useTranslation('mail');

  const roots = useMemo(() => {
    // dossiers non abonnés masqués (Paramètres → Dossiers)
    const custom = data.mailboxes.filter((m) => (!m.role || !SYSTEM_ROLES.includes(m.role as SystemRole)) && m.isSubscribed !== false).sort(compareMailboxes);
    const roleIds = new Set(data.mailboxes.filter((m) => m.role && SYSTEM_ROLES.includes(m.role as SystemRole)).map((m) => m.id));
    const normalized: Mailbox[] = custom.map((m) => (m.parentId && roleIds.has(m.parentId) ? { ...m, parentId: null } : m));
    return mailboxTree(normalized);
  }, [data.mailboxes]);

  const create = async (name: string | null, parentId: string | null) => {
    ops.setCreatingUnder(undefined);
    setCreatingRoot(false);
    if (!name) return;
    try {
      await createMailbox(accountId, name, parentId);
      if (parentId) setExpanded((e) => ({ ...e, [`${accountId}:${parentId}`]: true }));
      toast(t('sidebar.folderCreated', { name }));
    } catch (e) {
      toast.error(t('errors.createFolder'), { description: (e as Error).message });
    }
  };

  const render = (nodes: MailboxNode[]): ReactNode =>
    nodes.map((n) => {
      const key = `${accountId}:${n.id}`;
      const isOpen = expanded[key] ?? n.depth < 1;
      const active = view.accountId === accountId && view.mailbox.kind === 'id' && view.mailbox.id === n.id;
      const color = ops.folderColors[key];
      const menu: MenuItem[] = [
        { id: 'rename', label: t('sidebar.rename'), icon: <PenLine />, onSelect: () => setTimeout(() => ops.setEditing(n.id), 120) },
        { id: 'subfolder', label: t('sidebar.newSubfolder'), icon: <FolderPlus />, onSelect: () => setTimeout(() => ops.setCreatingUnder(n.id), 120) },
        { id: 'color', label: t('sidebar.color'), icon: <Palette />, onSelect: () => {}, colors: { current: color, onPick: (c) => ops.setColor(n.id, c) } },
        {
          id: 'markAllRead',
          label: t('actions.markAllRead'),
          icon: <MailCheck />,
          onSelect: async () => {
            try {
              const nb = await markMailboxRead(accountId, n.id);
              toast(nb ? t('sidebar.markedRead', { count: nb }) : t('sidebar.noUnread'));
            } catch (e) {
              toast.error(t('errors.action'), { description: (e as Error).message });
            }
          },
        },
        {
          id: 'hide',
          label: t('sidebar.hideFolder'),
          icon: <EyeOff />,
          separatorBefore: true,
          onSelect: () => {
            void setSubscribed(accountId, n.id, false)
              .then(() => toast(t('sidebar.folderHidden', { name: n.name }), { action: { label: t('sidebar.manageFolders'), onClick: () => openSettings('folders') } }))
              .catch((e) => toast.error(t('errors.action'), { description: errorMessage(e) }));
          },
        },
        { id: 'manage', label: t('sidebar.manageFolders'), icon: <FolderTree />, onSelect: () => openSettings('folders') },
        ...transferItems(accountId, n.id, n.name, t),
        {
          id: 'delete',
          label: t('actions.delete'),
          icon: <Trash2 />,
          destructive: true,
          separatorBefore: true,
          onSelect: async () => {
            const ok = await confirmDialog({
              title: t('sidebar.deleteTitle', { name: n.name }),
              description: n.children.length ? t('sidebar.deleteDescChildren') : t('sidebar.deleteDesc'),
              confirmLabel: t('sidebar.deleteConfirm'),
              destructive: true,
            });
            if (!ok) return;
            const tid = toast.loading(t('sidebar.deleting'));
            try {
              if (active) onNavigate({ kind: 'role', role: 'inbox' }, accountId);
              await deleteMailbox(accountId, n.id);
              toast.success(t('sidebar.folderDeleted', { name: n.name }), { id: tid });
            } catch (e) {
              toast.error(t('errors.delete'), { id: tid, description: (e as Error).message });
            }
          },
        },
      ];
      return (
        <div key={n.id} role="group">
          <FolderRow
            label={n.name}
            icon={<Folder />}
            color={color}
            count={n.unreadThreads}
            active={active}
            depth={n.depth}
            expandable={n.children.length > 0}
            expanded={isOpen}
            onToggle={() => setExpanded((e) => ({ ...e, [key]: !isOpen }))}
            to={{ accountId, mailbox: { kind: 'id', id: n.id } }}
            onClick={onLinkNavigate}
            onDropKeys={(keys) => {
              const own = keys.filter((k) => k.startsWith(`${accountId}:`));
              if (own.length < keys.length) toast(t('sidebar.otherAccountDrop'));
              if (own.length) actions.move(n.id, n.name, own);
            }}
            dragFolder={`${accountId}:${n.id}`}
            onDropFolder={(key) => {
              const [acc, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
              if (acc !== accountId) return void toast(t('sidebar.otherAccountDrop'));
              if (id === n.id) return;
              void moveMailboxTo(accountId, id, n.id)
                .then(() => setExpanded((e) => ({ ...e, [`${accountId}:${n.id}`]: true })))
                .catch((e) => toast.error(t('errors.action'), { description: errorMessage(e) }));
            }}
            menu={menu}
            editing={ops.editing === n.id}
            onCancelEdit={() => ops.setEditing(null)}
            onRename={async (name) => {
              ops.setEditing(null);
              if (!name || name === n.name) return;
              try {
                await renameMailbox(accountId, n.id, name);
              } catch (e) {
                toast.error(t('errors.rename'), { description: (e as Error).message });
              }
            }}
          />
          <AnimatePresence initial={false}>
            {ops.creatingUnder === n.id && <NewFolderInput key="new" depth={n.depth + 1} onDone={(name) => create(name, n.id)} />}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {isOpen && n.children.length > 0 && (
              <motion.div key="children" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tBase} className="overflow-hidden">
                {render(n.children)}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      );
    });

  return (
    <div role="tree" aria-label={t('sidebar.folders')}>
      {render(roots)}
      <AnimatePresence initial={false}>
        {creatingRoot && <NewFolderInput key="new-root" depth={0} onDone={(name) => create(name, null)} />}
      </AnimatePresence>
      {roots.length === 0 && !creatingRoot && (
        <button
          type="button"
          onClick={() => setCreatingRoot(true)}
          className="flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-[13px] text-text-3 voxel-transition hover:bg-black/[0.04] hover:text-text-2 dark:hover:bg-white/[0.05]"
        >
          <Plus className="size-[15px]" /> {t('sidebar.newFolder')}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ barre latérale

export function Sidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const { data: accounts } = useAccounts();
  const { map } = useAllMailboxData();
  const nav = useNav();
  const view = nav.view;
  const searching = nav.search.chips.length > 0 || nav.search.text.length > 0;
  const actions = useThreadActions();
  const online = useOnline();
  const pending = useOutboxCount();
  const [collapsed, setCollapsed] = useLocalState<Record<string, boolean>>('voxel-sections-collapsed', {});
  const [creatingRootFor, setCreatingRootFor] = useState<string | null>(null);
  const { t } = useTranslation('mail');

  const unified = view.accountId === ALL;
  const viewAccounts = unified ? (accounts ?? []) : (accounts ?? []).filter((a) => a.id === view.accountId);
  const navigate = (sel: MailboxSel, accountId: string) => {
    goView({ accountId, mailbox: sel });
    onNavigate?.();
  };

  const roles = SYSTEM_ROLES.filter((r) => r === 'flagged' || viewAccounts.some((a) => roleId(map[a.id], r)) || r === 'archive');

  const dropOnRole = (role: SystemRole, keys: string[]) => {
    const items = actions.resolve(keys);
    if (!items.length) return;
    switch (role) {
      case 'flagged':
        return void setFlagged(items, true);
      case 'archive':
        return void archiveThreads(items);
      case 'trash':
        return void trashThreads(items);
      case 'junk':
        return void spamThreads(items);
      case 'drafts':
      case 'scheduled':
        return void toast(t('sidebar.cannotMoveHere'));
      default:
        return void moveThreads(items, { role }, { label: t('toasts.movedTo', { name: roleLabel(role) }) });
    }
  };

  return (
    <aside aria-label={t('sidebar.folders')} data-pane="sidebar" className={cn('flex min-h-0 flex-col bg-sidebar', className)}>
      <div className="px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={() => startCompose()}
          className="voxel-btn-tonal group flex h-10 w-full items-center gap-2.5 rounded-[10px] px-3.5 text-[13.5px] font-medium active:scale-[0.985]"
        >
          <PenLine className="size-4" />
          {t('sidebar.compose')}
          <span className="ms-auto rounded bg-black/10 px-1.5 text-[11px] font-medium opacity-70 dark:bg-white/10">C</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <nav aria-label={t('sidebar.systemFolders')} className="space-y-px">
          {roles.map((role) => {
            const Icon = ROLE_ICONS[role];
            const count = viewAccounts.reduce((s, a) => s + roleCount(role, map[a.id]), 0);
            const active = nav.route !== 'summaries' && !searching && view.mailbox.kind === 'role' && view.mailbox.role === role;
            return (
              <Fragment key={role}>
              <FolderRow
                label={roleLabel(role)}
                icon={<Icon />}
                count={count}
                countMuted={role === 'drafts' || role === 'scheduled'}
                active={active}
                to={{ accountId: view.accountId, mailbox: { kind: 'role', role } }}
                onClick={onNavigate}
                onDropKeys={(keys) => dropOnRole(role, keys)}
                menu={
                  !unified && role !== 'flagged' && roleId(map[view.accountId], role)
                    ? [
                        ...(role === 'trash' || role === 'junk'
                          ? [
                              {
                                id: 'empty',
                                label: t('sidebar.emptyFolder'),
                                icon: <Trash2 />,
                                destructive: true,
                                onSelect: () => void confirmEmptyFolder(view.accountId, roleId(map[view.accountId], role)!),
                              },
                            ]
                          : []),
                        ...transferItems(view.accountId, roleId(map[view.accountId], role)!, roleLabel(role), t).map((m, i) => (i === 0 && role !== 'trash' && role !== 'junk' ? { ...m, separatorBefore: false } : m)),
                      ]
                    : undefined
                }
              />
              {role === 'inbox' && <SummariesNavRow onNavigate={onNavigate} />}
              </Fragment>
            );
          })}
        </nav>

        {viewAccounts.map((a) => {
          const d = map[a.id];
          if (!d) return null;
          const sectionKey = `${a.id}`;
          const isCollapsed = collapsed[sectionKey] ?? false;
          return (
            <section key={a.id} className="mt-5">
              <div className="group mb-1 flex h-6 items-center gap-1.5 px-2">
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [sectionKey]: !isCollapsed }))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px] font-medium tracking-wide text-text-3 uppercase voxel-transition hover:text-text-2"
                  aria-expanded={!isCollapsed}
                >
                  {unified && <AccountDot color={a.color} />}
                  <span dir="auto" className="truncate">{unified ? a.displayName || a.email : t('sidebar.folders')}</span>
                  <ChevronRight className={cn('size-3 shrink-0 opacity-0 transition-[transform,opacity] duration-150 ease-voxel group-hover:opacity-100 rtl:-scale-x-100', !isCollapsed && 'rotate-90 rtl:-rotate-90')} />
                </button>
                <button
                  type="button"
                  aria-label={t('sidebar.newFolder')}
                  onClick={() => {
                    setCollapsed((c) => ({ ...c, [sectionKey]: false }));
                    setCreatingRootFor(a.id);
                  }}
                  className="flex size-5 items-center justify-center rounded text-text-3 opacity-0 voxel-transition group-hover:opacity-100 hover:bg-black/[0.06] hover:text-text-1 focus-visible:opacity-100 dark:hover:bg-white/[0.08]"
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
              <AnimatePresence initial={false}>
                {!isCollapsed && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tBase} className="overflow-hidden">
                    <CustomTree
                      accountId={a.id}
                      data={d}
                      onNavigate={navigate}
                      onLinkNavigate={onNavigate}
                      creatingRoot={creatingRootFor === a.id}
                      setCreatingRoot={(v) => setCreatingRootFor(v ? a.id : null)}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          );
        })}
      </div>
      {/* quota de stockage, une barre par boîte affichée qui l'annonce */}
      {viewAccounts.some((a) => a.capabilities?.quota) && (
        <div className="space-y-2 border-t border-line px-4 py-2.5">
          {viewAccounts.map((a) => (
            <QuotaBar key={a.id} account={a} label={unified ? a.displayName || a.email : undefined} />
          ))}
        </div>
      )}
      <AnimatePresence initial={false}>
        {(!online || pending > 0) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={tBase}
            className="overflow-hidden border-t border-line"
          >
            <div className="flex items-center gap-2 px-4 py-2.5 text-[12px] text-text-2">
              <CloudOff className="size-3.5 text-text-3" />
              {pending > 0 ? t('common:offline.pendingActions', { count: pending }) : t('common:offline.offline')}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}
