import { memo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { motion, useMotionValue, useTransform, animate, type PanInfo } from 'motion/react';
import { Archive, Flag, MailOpen, Mail, Paperclip, Trash2 } from 'lucide-react';
import type { ThreadItem } from '@/lib/mail';
import { displayName, firstName, formatNumber, listDate } from '@/lib/format';
import { AccountDot, SenderAvatar } from '@/components/common/bits';
import { PriorityMark } from '@/components/common/PriorityMark';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { DND_TYPE } from '@/components/sidebar/Sidebar';
import { EASE } from '@/lib/motion';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useDirection } from '@/hooks/useDirection';
import { RouteLink } from '@/nav/links';
import type { Target } from '@/nav/nav';

export interface RowHandlers {
  /** cible du lien de la ligne (vrai `<a href>` : nouvel onglet, copier le lien) */
  linkFor: (t: ThreadItem) => Target | null;
  linkState: Record<string, unknown>;
  onOpen: (t: ThreadItem, e: MouseEvent) => void;
  onToggleSelect: (t: ThreadItem, shift: boolean) => void;
  onArchive: (t: ThreadItem) => void;
  onTrash: (t: ThreadItem) => void;
  onToggleRead: (t: ThreadItem) => void;
  onToggleFlag: (t: ThreadItem) => void;
  getDragKeys: (t: ThreadItem) => string[];
}

interface Props extends RowHandlers {
  item: ThreadItem;
  selected: boolean;
  selectionMode: boolean;
  active: boolean;
  focused: boolean;
  leaving: boolean;
  compact: boolean;
  showAccount?: { color: string; label: string };
  sentView: boolean;
  mobile: boolean;
}

function senderLine(t: ThreadItem, sentView: boolean, tr: TFunction<'mail'>): string {
  if (sentView) {
    const names = t.to.slice(0, 3).map((a) => firstName(a));
    return names.length ? tr('row.to', { names: `${names.join(', ')}${t.to.length > 3 ? '…' : ''}` }) : tr('row.noRecipient');
  }
  if (t.senders.length <= 1) return displayName(t.from ?? t.senders[0]) || tr('row.unknownSender');
  const names = t.senders.map((s) => firstName(s));
  if (names.length > 3) return `${names[0]} … ${names.slice(-2).join(', ')}`;
  return names.join(', ');
}

const SWIPE = 88;

function ThreadRowBase(p: Props) {
  const t = p.item;
  const [dragging, setDragging] = useState(false);
  const { t: tr } = useTranslation('mail');
  // Glissement : vers la fin de ligne = archiver, vers le début = supprimer (inversé en RTL)
  const sign = useDirection() === 'rtl' ? -1 : 1;
  const x = useMotionValue(0);
  const forward = useTransform(x, (v) => v * sign);
  const archiveOpacity = useTransform(forward, [0, 24, SWIPE], [0, 0.6, 1]);
  const trashOpacity = useTransform(forward, [-SWIPE, -24, 0], [1, 0.6, 0]);
  const iconScaleR = useTransform(forward, [0, SWIPE], [0.7, 1]);
  const iconScaleL = useTransform(forward, [-SWIPE, 0], [1, 0.7]);
  const swiped = useRef(false);

  const onDragStart = (e: DragEvent) => {
    const keys = p.getDragKeys(t);
    e.dataTransfer.setData(DND_TYPE, JSON.stringify(keys));
    e.dataTransfer.effectAllowed = 'move';
    const ghost = document.createElement('div');
    ghost.textContent = keys.length > 1 ? tr('row.conversations', { count: keys.length }) : t.subject || tr('noSubject');
    ghost.dir = document.documentElement.dir || 'ltr';
    ghost.style.cssText =
      'position:fixed;top:-100px;left:-100px;padding:6px 12px;border-radius:8px;font:500 13px Inter Variable,system-ui;background:#1c1917;color:#fafaf9;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 8px 24px rgba(0,0,0,.18)';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 16);
    setTimeout(() => ghost.remove(), 0);
    setDragging(true);
  };

  const onPanEnd = (_: unknown, info: PanInfo) => {
    const dx = info.offset.x * sign;
    if (dx > SWIPE) {
      swiped.current = true;
      void animate(x, window.innerWidth * sign, { duration: 0.18, ease: EASE });
      p.onArchive(t);
    } else if (dx < -SWIPE) {
      swiped.current = true;
      void animate(x, -window.innerWidth * sign, { duration: 0.18, ease: EASE });
      p.onTrash(t);
    } else void animate(x, 0, { type: 'spring', bounce: 0, duration: 0.25 });
  };

  const date = listDate(t.receivedAt);
  const sender = senderLine(t, p.sentView, tr);

  const content = (
    <motion.div
      style={p.mobile ? { x } : undefined}
      drag={p.mobile ? 'x' : false}
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.9}
      dragMomentum={false}
      onDragEnd={p.mobile ? onPanEnd : undefined}
      className={cn(
        'group relative flex cursor-default items-center gap-3 border-b border-line/70 bg-panel px-3 voxel-transition select-none',
        p.compact ? 'h-[var(--voxel-row-h)]' : 'h-[var(--voxel-row-h)]',
        p.active ? 'bg-row-selected' : p.selected ? 'bg-row-selected' : 'hover:bg-row-hover',
        p.focused && !p.active && 'shadow-[inset_0_0_0_1.5px_var(--voxel-accent-ring)]',
        dragging && 'opacity-50',
      )}
    >
      {/* barre d'activité */}
      <span
        aria-hidden
        className={cn('absolute top-0 bottom-0 start-0 w-[2.5px] bg-voxel-accent transition-opacity duration-150 ease-voxel', p.active ? 'opacity-100' : 'opacity-0')}
      />
      {/* pastille non lu */}
      <span
        aria-hidden
        className={cn('absolute start-[5px] size-[6px] rounded-full bg-voxel-accent transition-[opacity,transform] duration-200 ease-voxel', t.unread ? 'scale-100 opacity-100' : 'scale-50 opacity-0')}
        style={{ top: '50%', marginTop: -3 }}
      />
      {/* avatar ↔ case à cocher */}
      <div className="relative z-10 ms-1.5 flex size-8 shrink-0 items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {!p.compact && (
          <SenderAvatar
            name={p.sentView ? displayName(t.to[0]) : displayName(t.from)}
            email={(p.sentView ? t.to[0]?.email : t.from?.email) ?? t.key}
            className={cn('transition-[opacity,transform] duration-150 ease-voxel', (p.selectionMode || p.selected) ? 'scale-75 opacity-0' : 'group-hover:scale-75 group-hover:opacity-0')}
          />
        )}
        <div
          className={cn(
            'absolute inset-0 flex items-center justify-center transition-opacity duration-150 ease-voxel',
            p.compact || p.selectionMode || p.selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <Checkbox
            checked={p.selected}
            aria-label={tr('row.select')}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              p.onToggleSelect(t, e.shiftKey);
            }}
            className="size-[18px] rounded-[5px] border-line-strong bg-panel data-[state=checked]:border-voxel-accent data-[state=checked]:bg-voxel-accent data-[state=checked]:text-on-accent"
          />
        </div>
      </div>

      <RouteLink
        link={p.linkFor(t)}
        state={p.linkState}
        resetScroll={false}
        draggable={!p.mobile}
        onDragStart={onDragStart}
        onDragEnd={() => setDragging(false)}
        onClick={(e) => {
          if (swiped.current) {
            e.preventDefault();
            return;
          }
          p.onOpen(t, e);
        }}
        className="absolute inset-0 z-0 outline-none"
        aria-label={`${sender}, ${t.subject || tr('noSubject')}${t.unread ? `, ${tr('row.unread')}` : ''}`}
        tabIndex={-1}
      />

      {p.compact ? (
        <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3">
          <span dir="auto" className={cn('w-[168px] shrink-0 truncate text-[13.5px] rtl:text-right', t.unread ? 'font-semibold text-text-1' : 'text-text-2')}>
            {sender}
            {t.count > 1 && <span className="ms-1 text-[11.5px] font-normal text-text-3">{formatNumber(t.count)}</span>}
          </span>
          <span dir="auto" className="min-w-0 flex-1 truncate text-[13.5px] rtl:text-right">
            {t.draft && <span className="me-1.5 text-danger">{tr('row.draft')}</span>}
            <span className={cn(t.unread ? 'font-semibold text-text-1' : 'text-text-1')}>{t.subject || tr('noSubject')}</span>
            <span className="text-text-3"> — {t.preview}</span>
          </span>
        </div>
      ) : (
        <div className="pointer-events-none relative min-w-0 flex-1 py-2">
          <div className="flex items-baseline gap-2">
            <span dir="auto" className={cn('min-w-0 truncate text-[14px] leading-5 rtl:text-right', t.unread ? 'font-semibold text-text-1' : 'font-medium text-text-2')}>
              {t.draft && <span className="me-1 font-medium text-danger">{tr('row.draft')} ·</span>}
              {sender}
            </span>
            {t.count > 1 && (
              <span className="shrink-0 rounded-[5px] bg-black/[0.05] px-1.5 text-[11px] leading-[17px] font-medium text-text-2 tabular dark:bg-white/[0.07]">{formatNumber(t.count)}</span>
            )}
          </div>
          <div dir="auto" className="mt-px truncate text-[13px] leading-5 rtl:text-right">
            <span className={cn(t.unread ? 'font-medium text-text-1' : 'text-text-1/90')}>{t.subject || tr('noSubject')}</span>
            {t.preview && <span className="text-text-3"> — {t.preview}</span>}
          </div>
        </div>
      )}

      {/* méta : date, icônes */}
      <div className={cn('pointer-events-none relative flex shrink-0 flex-col items-end justify-center gap-1', p.compact && 'flex-row items-center gap-2')}>
        <div className={cn('flex items-center gap-1.5 transition-opacity duration-150 ease-voxel', !p.mobile && 'group-hover:opacity-0')}>
          {p.showAccount && <AccountDot color={p.showAccount.color} className="size-[7px]" />}
          <span className={cn('text-[12px] tabular', t.unread ? 'font-semibold text-text-1' : 'text-text-3')}>{date}</span>
        </div>
        {!p.compact && (
          <div className={cn('flex h-4 items-center gap-1.5 text-text-3 transition-opacity duration-150 ease-voxel', !p.mobile && 'group-hover:opacity-0')}>
            <PriorityMark priority={t.priority} />
            {t.hasAttachment && <Paperclip className="size-3.5" aria-label={tr('row.attachment')} />}
            {t.flagged && <Flag className="size-3.5 fill-flag text-flag" aria-label={tr('row.flagged')} />}
          </div>
        )}
        {p.compact && (t.hasAttachment || t.flagged || (t.priority && t.priority !== 'normal')) && (
          <div className="flex items-center gap-1.5 text-text-3 group-hover:opacity-0">
            <PriorityMark priority={t.priority} />
            {t.hasAttachment && <Paperclip className="size-3.5" />}
            {t.flagged && <Flag className="size-3.5 fill-flag text-flag" />}
          </div>
        )}
      </div>

      {/* actions au survol */}
      {!p.mobile && (
        <div className="pointer-events-none absolute end-2 z-10 flex items-center gap-0.5 rounded-lg bg-row-hover ps-2 opacity-0 transition-opacity duration-150 ease-voxel group-hover:pointer-events-auto group-hover:opacity-100 group-[.bg-row-selected]:bg-row-selected">
          <HoverAction label={tr('actions.archive')} onClick={() => p.onArchive(t)}>
            <Archive />
          </HoverAction>
          <HoverAction label={tr('actions.delete')} onClick={() => p.onTrash(t)}>
            <Trash2 />
          </HoverAction>
          <HoverAction label={t.unread ? tr('actions.markRead') : tr('actions.markUnread')} onClick={() => p.onToggleRead(t)}>
            {t.unread ? <MailOpen /> : <Mail />}
          </HoverAction>
          <HoverAction label={t.flagged ? tr('actions.unflag') : tr('actions.flag')} onClick={() => p.onToggleFlag(t)}>
            <Flag className={cn(t.flagged && 'fill-flag text-flag')} />
          </HoverAction>
        </div>
      )}
    </motion.div>
  );

  return (
    <motion.div
      role="option"
      aria-selected={p.selected || p.active}
      initial={false}
      animate={p.leaving ? { height: 0, opacity: 0 } : { height: 'auto', opacity: 1 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="relative overflow-hidden"
    >
      {p.mobile && (
        <div className="absolute inset-0 flex items-center justify-between">
          <motion.div style={{ opacity: archiveOpacity }} className="flex h-full flex-1 items-center bg-success/90 ps-6 text-white">
            <motion.span style={{ scale: iconScaleR }} className="flex items-center gap-2 text-[13px] font-medium">
              <Archive className="size-5" /> {tr('actions.archive')}
            </motion.span>
          </motion.div>
          <motion.div style={{ opacity: trashOpacity }} className="absolute inset-0 flex items-center justify-end bg-danger/90 pe-6 text-white">
            <motion.span style={{ scale: iconScaleL }} className="flex items-center gap-2 text-[13px] font-medium">
              {tr('actions.delete')} <Trash2 className="size-5" />
            </motion.span>
          </motion.div>
        </div>
      )}
      {content}
    </motion.div>
  );
}

function HoverAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex size-8 items-center justify-center rounded-md text-text-2 voxel-transition hover:bg-black/[0.06] hover:text-text-1 active:scale-95 dark:hover:bg-white/[0.08] [&_svg]:size-[16px]"
    >
      {children}
    </button>
  );
}

export const ThreadRow = memo(ThreadRowBase);
