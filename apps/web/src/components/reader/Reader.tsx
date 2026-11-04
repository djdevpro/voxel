import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useMotionValue, animate } from 'motion/react';
import {
  Archive,
  ArrowLeft,
  Ban,
  ListFilter,
  ChevronDown,
  CircleSlash,
  Code2,
  Flag,
  Forward,
  ImageOff,
  Mail,
  MoreHorizontal,
  Printer,
  Reply,
  ReplyAll,
  Trash2,
  MailX,
  AlertCircle,
  RefreshCw,
  FolderInput,
  Paperclip,
  UserPlus,
} from 'lucide-react';
import { flattenTree, formatAddress, isFreemailDomain, mailboxTree, priorityOf, type Email, type EmailAddress } from '@voxel/jmap';
import { blockSender, blocklistErrorMessage, blocklistQuery, unblock } from '@/lib/blocklist';
import { newFilterId, useFilterDraft } from '@/store/filterDraft';
import { openSettings } from '@/nav/nav';
import { toast } from 'sonner';
import { useAccount, useAllMailboxData, useIdentities, useThreads } from '@/hooks/useData';
import { useThreadActions } from '@/hooks/useThreadActions';
import { threadKey, useUi } from '@/store/ui';
import { useNav } from '@/nav/useNav';
import { closeThread, goView } from '@/nav/nav';
import { useSettings } from '@/store/settings';
import { bodyHtml, bodyText, mailboxLabel, roleId, SYSTEM_ROLES, threadQuery, unsubscribeUrls, viewMailboxId } from '@/lib/mail';
import { Trans, useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { useDirection } from '@/hooks/useDirection';
import { markEmailsSeen } from '@/lib/actions';
import { displayName, listDate, longDate } from '@/lib/format';
import { plainToHtml } from '@/lib/sanitize';
import { EmailFrame } from './EmailFrame';
import { buildCidMap, fetchBlob, useCidMap } from '@/lib/blobs';
import { Attachments } from './Attachments';

// carte d'invitation : chargée seulement pour un message qui porte une partie text/calendar
const InvitationCard = lazy(() => import('@/components/calendar/InvitationCard'));
import { useContactNames } from '@/lib/contacts';
import { openAddContact } from '@/components/contacts/AddContactDialog';
import { AccountDot, EmptyState, IconButton, Kbd, SenderAvatar } from '@/components/common/bits';
import { Logo } from '@/components/common/Logo';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { EASE, tBase, tSlow } from '@/lib/motion';
import { openDraft, startForwardAsAttachment, startMailto, startReply } from '@/components/compose/startCompose';
import { PriorityMark } from '@/components/common/PriorityMark';
import { ReceiptBanner } from './ReceiptBanner';
import { Composer } from '@/components/compose/Composer';
import { emailDocument, sanitizeEmailHtml } from '@/lib/sanitize';
import { useIsMobile } from '@/hooks/useEnvironment';

export function Reader({ className }: { className?: string }) {
  const openThread = useNav().thread;
  const { t } = useTranslation('reader');
  const sign = useDirection() === 'rtl' ? -1 : 1;
  return (
    <section aria-label={t('region')} data-pane="reader" className={cn('relative flex min-h-0 min-w-0 flex-col bg-panel', className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        {openThread ? (
          <motion.div
            key={threadKey(openThread.accountId, openThread.threadId)}
            className="flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0, x: 8 * sign }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, pointerEvents: 'none' }}
            transition={tSlow}
          >
            <ThreadView accountId={openThread.accountId} threadId={openThread.threadId} targetId={openThread.emailId} />
          </motion.div>
        ) : (
          <motion.div key="empty" className="flex flex-1" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, pointerEvents: 'none' }} transition={tBase}>
            <ReaderPlaceholder />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function ReaderPlaceholder() {
  const { t } = useTranslation('reader');
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <Logo className="size-10 opacity-[0.14] grayscale" />
      <div>
        <p className="text-[14px] font-medium text-text-2">{t('placeholder.title')}</p>
        <p className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5 text-[12.5px] text-text-3">
          <Trans t={t} i18nKey="placeholder.hint" components={{ j: <Kbd />, k: <Kbd />, help: <Kbd /> }} />
        </p>
      </div>
    </div>
  );
}

function ReaderSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[860px] px-6 pt-6" aria-hidden>
      <div className="voxel-skeleton mb-6 h-6 w-2/3" />
      <div className="flex items-center gap-3">
        <div className="voxel-skeleton size-9 rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="voxel-skeleton h-3 w-40" />
          <div className="voxel-skeleton h-2.5 w-56" />
        </div>
      </div>
      <div className="mt-6 space-y-2.5">
        {[92, 85, 96, 70, 88, 40].map((w, i) => (
          <div key={i} className="voxel-skeleton h-3" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

type ReplyMode = 'reply' | 'replyAll' | 'forward' | 'forwardAttachment';

function ThreadView({ accountId, threadId, targetId }: { accountId: string; threadId: string; targetId?: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery(threadQuery(accountId, threadId));
  const composers = useUi((s) => s.composers);
  const account = useAccount(accountId);
  const { map } = useAllMailboxData();
  const mbData = map[accountId];
  const { data: identities } = useIdentities(accountId);
  const actions = useThreadActions();
  const { items } = useThreads();
  const nav = useNav();
  const mobile = useIsMobile();
  const key = threadKey(accountId, threadId);
  const item = items.find((i) => i.key === key);
  const { t } = useTranslation('reader');
  const rtl = useDirection() === 'rtl';
  const sign = rtl ? -1 : 1;

  const trash = roleId(mbData, 'trash');
  const junk = roleId(mbData, 'junk');
  const emails = useMemo(() => {
    const all = data?.emails ?? [];
    // masque les messages en corbeille sauf si tout le fil y est
    // les brouillons en cours d'édition ne s'affichent pas dans le fil
    const editing = new Set(composers.map((c) => c.draftEmailId).filter(Boolean));
    const visible = all.filter((e) => !(trash && e.mailboxIds[trash]) && !(junk && e.mailboxIds[junk]) && !editing.has(e.id));
    return visible.length ? visible : all.filter((e) => !editing.has(e.id));
  }, [data, trash, junk, composers]);

  // Conversation introuvable (supprimée, déplacée, lien périmé) → message clair et retour au dossier
  const goneRef = useRef(false);
  useEffect(() => {
    if (!data || isFetching || data.emails.length > 0 || goneRef.current) return;
    goneRef.current = true;
    toast(t('common:routing.threadNotFound'));
    goView(nav.view, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isFetching]);

  // Marque comme lu à l'ouverture
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data || markedRef.current === key) return;
    markedRef.current = key;
    const unseen = data.emails.filter((e) => !e.keywords.$seen).map((e) => e.id);
    if (unseen.length) void markEmailsSeen(accountId, unseen);
  }, [data, key, accountId]);

  const inline = composers.find((c) => c.inline?.threadKey === key);
  const last = [...emails].reverse().find((e) => !e.keywords.$draft) ?? emails[emails.length - 1];
  const subject = last?.subject ?? item?.subject ?? '';
  const flagged = emails.some((e) => e.keywords.$flagged);
  const mailboxNames = useMemo(() => {
    if (!mbData) return [];
    const ids = new Set(emails.flatMap((e) => Object.keys(e.mailboxIds)));
    return mbData.mailboxes.filter((m) => ids.has(m.id) && m.role !== 'sent' && m.role !== 'drafts').map((m) => mailboxLabel(m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emails, mbData, t]);
  const moveTargets = useMemo(() => {
    if (!mbData) return [];
    const current = viewMailboxId(mbData, nav.view, accountId);
    const custom = mbData.mailboxes.filter((m) => !m.role || !SYSTEM_ROLES.includes(m.role as never));
    return [
      ...(['inbox', 'archive'] as const).map((r) => mbData.mailboxes.find((m) => m.id === roleId(mbData, r))).filter(Boolean).map((m) => ({ id: m!.id, name: mailboxLabel(m!), depth: 0 })),
      ...flattenTree(mailboxTree(custom.map((m) => (m.parentId && !custom.some((c) => c.id === m.parentId) ? { ...m, parentId: null } : m)))).map((m) => ({ id: m.id, name: m.name, depth: m.depth })),
    ].filter((m) => m.id !== current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mbData, nav.view, accountId, t]);

  const reply = (mode: ReplyMode, e?: Email) => {
    const target = e ?? last;
    if (!target) return;
    // transfert en pièce jointe : toujours dans une fenêtre de rédaction
    if (mode === 'forwardAttachment') return startForwardAsAttachment(target, accountId, { identities });
    startReply(target, accountId, mode, { inline: mobile ? undefined : key, identities, accountEmail: account?.email });
  };

  // Raccourcis r / a / f depuis le lecteur
  useEffect(() => {
    const h = (ev: Event) => {
      const mode = (ev as CustomEvent<'reply' | 'replyAll' | 'forward'>).detail;
      reply(mode);
    };
    window.addEventListener('voxel:reply', h);
    return () => window.removeEventListener('voxel:reply', h);
  });

  // Glisser vers la droite (vers la gauche en RTL) pour revenir à la liste (mobile)
  const x = useMotionValue(0);

  const [sourceOf, setSourceOf] = useState<Email | null>(null);

  // Bloquer l'expéditeur (filtre Sieve côté serveur), si la boîte le permet
  const { data: blocklist } = useQuery({ ...blocklistQuery(accountId), enabled: !!account?.capabilities?.sieve });
  const senderEmail = last?.from?.[0]?.email?.toLowerCase() ?? '';
  const senderDomain = senderEmail.includes('@') ? senderEmail.slice(senderEmail.lastIndexOf('@') + 1) : '';
  const ownEmails = new Set([account?.email, ...(identities ?? []).map((i) => i.email)].filter(Boolean).map((e) => e!.toLowerCase()));
  const ownDomain = (account?.email ?? '').toLowerCase().split('@')[1] ?? '';
  const canBlock = !!blocklist?.supported && !!senderDomain && !ownEmails.has(senderEmail);
  const canBlockDomain = canBlock && !isFreemailDomain(senderDomain) && senderDomain !== ownDomain;
  const block = async (entry: { address?: string; domain?: string }) => {
    const who = entry.address ?? entry.domain ?? '';
    try {
      const r = await blockSender(accountId, entry);
      const text = t('block.done', { who }) + (r.moved > 0 ? ` ${t('block.moved', { count: r.moved })}` : '');
      toast(text, {
        description: r.pendingActivation ? t('block.pending') : undefined,
        action: {
          label: t('block.undo'),
          onClick: () => {
            unblock(accountId, entry).then(
              () => toast(t('block.unblocked', { who })),
              (e) => toast.error(t('block.failed'), { description: blocklistErrorMessage(e) }),
            );
          },
        },
      });
    } catch (e) {
      toast.error(t('block.failed'), { description: blocklistErrorMessage(e) });
    }
  };
  const junkView = item ? actions.isJunkView(item) : false;

  return (
    <motion.div
      className="flex min-h-0 flex-1 flex-col"
      style={mobile ? { x } : undefined}
      drag={mobile ? 'x' : false}
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={rtl ? { left: 0.6, right: 0 } : { left: 0, right: 0.6 }}
      onDragEnd={(_, info) => {
        if (info.offset.x * sign > 90) closeThread();
        else void animate(x, 0, { duration: 0.2, ease: EASE });
      }}
    >
      {/* barre d'outils */}
      <div className="flex h-[52px] shrink-0 items-center gap-0.5 border-b border-line px-2 md:px-3">
        <IconButton label={t('toolbar.back')} shortcut="U" onClick={() => closeThread()}>
          <ArrowLeft className="rtl:-scale-x-100" />
        </IconButton>
        <div className="mx-1 h-5 w-px bg-line" />
        <IconButton label={t('mail:actions.archive')} shortcut="E" onClick={() => actions.archive([key])}>
          <Archive />
        </IconButton>
        <IconButton label={t('mail:actions.delete')} shortcut="#" onClick={() => actions.trash([key])}>
          <Trash2 />
        </IconButton>
        <IconButton label={junkView ? t('mail:actions.notSpam') : t('mail:actions.spam')} shortcut="!" onClick={() => actions.spam([key])} className="hidden sm:inline-flex">
          <CircleSlash />
        </IconButton>
        <IconButton label={t('mail:actions.markUnread')} shortcut="⇧U" onClick={() => { actions.markRead(false, [key]); closeThread(); }}>
          <Mail />
        </IconButton>
        <IconButton label={flagged ? t('mail:actions.unflag') : t('mail:actions.flag')} shortcut="S" onClick={() => actions.toggleFlag([key])}>
          <Flag className={cn(flagged && 'fill-flag text-flag')} />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={t('mail:actions.moveTo')} className="hidden sm:inline-flex">
              <FolderInput />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-56">
            <DropdownMenuLabel className="text-[11.5px] font-medium text-text-3">{t('mail:actions.moveTo')}</DropdownMenuLabel>
            {moveTargets.map((m) => (
              <DropdownMenuItem key={m.id} onSelect={() => actions.move(m.id, m.name, [key])} style={{ paddingInlineStart: 8 + m.depth * 12 }}>
                {m.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={t('toolbar.more')}>
              <MoreHorizontal />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-56 max-w-[min(24rem,calc(100vw-2rem))]">
            <DropdownMenuItem onSelect={() => last && void printEmail(last, accountId, mbData?.jmapAccountId ?? '')}>
              <Printer /> {t('toolbar.print')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => last && setSourceOf(last)}>
              <Code2 /> {t('toolbar.source')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => reply('forwardAttachment')}>
              <Paperclip /> {t('forwardAttachment')}
            </DropdownMenuItem>
            {last && unsubscribeUrls(last).length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => unsubscribe(last, accountId)}>
                  <MailX /> {t('toolbar.unsubscribe')}
                </DropdownMenuItem>
              </>
            )}
            {account?.capabilities?.sieve && last && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    // « Créer un filtre… » prérempli avec l'expéditeur et l'objet
                    const conditions = [
                      ...(senderEmail ? [{ field: 'from' as const, op: 'contains' as const, value: senderEmail }] : []),
                      ...(last.subject ? [{ field: 'subject' as const, op: 'contains' as const, value: last.subject }] : []),
                    ];
                    useFilterDraft.getState().set({
                      accountId,
                      filter: { id: newFilterId(), name: senderEmail || last.subject || '', enabled: true, match: 'all', conditions, actions: [{ type: 'move', mailboxId: '' }] },
                    });
                    openSettings('filters', account.email);
                  }}
                >
                  <ListFilter /> {t('toolbar.createFilter')}
                </DropdownMenuItem>
              </>
            )}
            {canBlock && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void block({ address: senderEmail })}>
                  <Ban /> <span className="truncate">{t('block.address', { address: senderEmail })}</span>
                </DropdownMenuItem>
                {canBlockDomain && (
                  <DropdownMenuItem onSelect={() => void block({ domain: senderDomain })}>
                    <Ban /> <span className="truncate">{t('block.domain', { domain: senderDomain })}</span>
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <ReaderSkeleton />}
        {isError && !data && (
          <EmptyState
            icon={<AlertCircle />}
            title={t('openError')}
            description={(error as Error)?.message}
            action={
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <RefreshCw /> {t('common:actions.retry')}
              </Button>
            }
          />
        )}
        {data && (
          <div className="mx-auto w-full max-w-[880px] px-4 pt-5 pb-10 md:px-7">
            <div className="mb-5 flex items-start gap-3">
              <h1 dir="auto" className="min-w-0 flex-1 text-[19px] leading-snug rtl:text-right font-semibold tracking-[-0.015em] text-pretty text-text-1">{subject || t('mail:noSubject')}</h1>
            </div>
            <div className="-mt-3 mb-5 flex flex-wrap items-center gap-1.5">
              {account && (
                <span className="inline-flex h-[22px] items-center gap-1.5 rounded-md bg-black/[0.04] px-2 text-[11.5px] font-medium text-text-2 dark:bg-white/[0.06]">
                  <AccountDot color={account.color} /> {account.displayName || account.email}
                </span>
              )}
              {mailboxNames.map((n) => (
                <span key={n} className="inline-flex h-[22px] items-center rounded-md border border-line px-2 text-[11.5px] text-text-2">
                  {n}
                </span>
              ))}
            </div>
            <MessageStack key={targetId ?? 'all'} emails={emails} targetId={targetId} accountId={accountId} jmapAccountId={mbData?.jmapAccountId ?? ''} onReply={reply} onSource={setSourceOf} />
            <AnimatePresence initial={false} mode="popLayout">
              {inline ? (
                <motion.div key={inline.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={tSlow} className="mt-4">
                  <Composer state={inline} />
                </motion.div>
              ) : (
                <motion.div key="reply-bar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tBase} className="mt-5 flex flex-wrap gap-2">
                  <Button variant="outline" className="h-9 rounded-full px-4 text-[13px]" onClick={() => reply('reply')}>
                    <Reply className="rtl:-scale-x-100" /> {t('reply')}
                  </Button>
                  {last && (last.to?.length ?? 0) + (last.cc?.length ?? 0) > 1 && (
                    <Button variant="outline" className="h-9 rounded-full px-4 text-[13px]" onClick={() => reply('replyAll')}>
                      <ReplyAll className="rtl:-scale-x-100" /> {t('replyAll')}
                    </Button>
                  )}
                  <Button variant="outline" className="h-9 rounded-full px-4 text-[13px]" onClick={() => reply('forward')}>
                    <Forward className="rtl:-scale-x-100" /> {t('forward')}
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
      <SourceDialog email={sourceOf} accountId={accountId} jmapAccountId={mbData?.jmapAccountId ?? ''} onClose={() => setSourceOf(null)} />
    </motion.div>
  );
}

function MessageStack({
  emails,
  targetId,
  accountId,
  jmapAccountId,
  onReply,
  onSource,
}: {
  emails: Email[];
  /** message ciblé par l'URL (`?msg=`) : déplié et amené à l'écran */
  targetId?: string;
  accountId: string;
  jmapAccountId: string;
  onReply: (mode: ReplyMode, e: Email) => void;
  onSource: (e: Email) => void;
}) {
  const hasTarget = !!targetId && emails.some((e) => e.id === targetId);
  // Déplie : le dernier + les non lus (+ le message ciblé) ; replie les autres ; masque le milieu au-delà de 4
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    emails.forEach((e, i) => {
      if (i === emails.length - 1 || !e.keywords.$seen || e.id === targetId) s.add(e.id);
    });
    return s;
  });
  const [showAll, setShowAll] = useState(emails.length <= 4 || hasTarget);
  const stackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasTarget) return;
    const el = stackRef.current?.querySelector<HTMLElement>(`[data-email-id="${CSS.escape(targetId!)}"]`);
    el?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTarget, targetId]);
  useEffect(() => {
    const lastE = emails[emails.length - 1];
    if (lastE) setExpanded((s) => (s.has(lastE.id) ? s : new Set([...s, lastE.id])));
  }, [emails]);

  const toggle = useCallback((id: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  }), []);

  const { t } = useTranslation('reader');
  const hiddenCount = showAll ? 0 : Math.max(0, emails.length - 3);
  const visible = showAll ? emails : [emails[0]!, ...emails.slice(-2)];

  return (
    <div ref={stackRef} className="overflow-hidden rounded-xl border border-line bg-panel shadow-soft">
      {visible.map((e, i) => (
        <div key={e.id} data-email-id={e.id} className="scroll-mt-3">
          {i === 1 && hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="relative flex h-9 w-full items-center justify-center border-t border-line text-[12px] font-medium text-text-2 voxel-transition hover:bg-row-hover hover:text-text-1"
            >
              <span className="absolute inset-x-0 top-1/2 border-t border-dashed border-line" />
              <span className="relative rounded-full border border-line bg-panel px-3 py-0.5">{t('olderMessages', { count: hiddenCount })}</span>
            </button>
          )}
          <MessageItem
            email={e}
            first={i === 0}
            expanded={expanded.has(e.id)}
            onToggle={() => toggle(e.id)}
            accountId={accountId}
            jmapAccountId={jmapAccountId}
            onReply={(m) => onReply(m, e)}
            onSource={() => onSource(e)}
          />
        </div>
      ))}
    </div>
  );
}

/** Adresse sans nom → nom de la fiche de contact, sinon l'adresse telle quelle. */
function withContactName(a: EmailAddress | null | undefined, names: Map<string, string>): EmailAddress | null | undefined {
  if (!a || a.name?.trim()) return a;
  const name = names.get(a.email?.toLowerCase() ?? '');
  return name ? { ...a, name } : a;
}

function addrList(a: EmailAddress[] | null, names: Map<string, string>) {
  return (a ?? []).map((x) => displayName(withContactName(x, names))).join(', ');
}

/** Adresses du détail d'un message, chacune avec « Ajouter aux contacts » (si la boîte a les contacts). */
function AddressCell({ list, names, accountId, mailboxEmail, canAdd }: { list: EmailAddress[]; names: Map<string, string>; accountId: string; mailboxEmail: string; canAdd: boolean }) {
  const { t } = useTranslation('contacts');
  if (!list.length) return <dd>—</dd>;
  return (
    <dd className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 break-all" dir="auto">
      {list.map((a, i) => (
        <span key={`${a.email}-${i}`} className="inline-flex items-center gap-0.5">
          {formatAddress(withContactName(a, names) ?? a)}
          {canAdd && a.email && !names.has(a.email.toLowerCase()) && (
            <button
              type="button"
              aria-label={t('reader.addAddress', { email: a.email })}
              title={t('reader.addToContacts')}
              onClick={() => void openAddContact({ accountId, mailboxEmail, name: a.name ?? '', email: a.email })}
              className="inline-flex size-5 items-center justify-center rounded text-text-3 voxel-transition hover:bg-black/[0.06] hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none dark:hover:bg-white/[0.08]"
            >
              <UserPlus className="size-3.5" />
            </button>
          )}
          {i < list.length - 1 && ','}
        </span>
      ))}
    </dd>
  );
}

function MessageItem({
  email,
  first,
  expanded,
  onToggle,
  accountId,
  jmapAccountId,
  onReply,
  onSource,
}: {
  email: Email;
  first: boolean;
  expanded: boolean;
  onToggle: () => void;
  accountId: string;
  jmapAccountId: string;
  onReply: (mode: ReplyMode) => void;
  onSource: () => void;
}) {
  const remotePref = useSettings((s) => s.remoteImages);
  const trusted = useSettings((s) => s.trustedSenders);
  const setSettings = useSettings((s) => s.set);
  const fromEmail = email.from?.[0]?.email?.toLowerCase() ?? '';
  const [allowOnce, setAllowOnce] = useState(false);
  const allowRemote = remotePref === 'allow' || allowOnce || trusted.includes(fromEmail);
  const [blocked, setBlocked] = useState(0);
  const [details, setDetails] = useState(false);
  const html = useMemo(() => bodyHtml(email), [email]);
  const text = useMemo(() => (html ? '' : bodyText(email)), [email, html]);
  // images `cid:` : URL d'objets préparées avant le rendu (plafond de 15 Mo, au-delà sur demande)
  const [allCid, setAllCid] = useState(false);
  const cid = useCidMap(accountId, jmapAccountId, email.attachments ?? undefined, expanded && !!html, allCid);
  const cidMap = cid.map;
  const visibleAttachments = useMemo(
    () => (email.attachments ?? []).filter((a) => !(a.cid && html && html.includes(a.cid.replace(/^<|>$/g, ''))) && a.disposition !== 'inline' || (a.disposition === 'inline' && !a.cid)),
    [email, html],
  );
  const from = email.from?.[0];
  const onBlocked = useCallback((n: number) => setBlocked(n), []);
  const isDraft = !!email.keywords.$draft;
  const { data: identities } = useIdentities(accountId);
  const editDraft = () => openDraft(email, accountId, identities);
  const { t } = useTranslation('reader');
  const names = useContactNames();
  const account = useAccount(accountId);
  const canAdd = !!account?.capabilities.contacts;
  // invitation : première partie text/calendar (pièce jointe ou alternative), si la boîte a un agenda
  const calendarPart = useMemo(
    () => (account?.capabilities.calendars ? [...(email.attachments ?? []), ...(email.textBody ?? [])].find((p) => !!p.blobId && /^(text\/calendar|application\/ics)/i.test(p.type ?? '')) : undefined),
    [email, account?.capabilities.calendars],
  );
  const shownFrom = withContactName(from, names);
  const priority = useMemo(() => priorityOf(email as unknown as Record<string, unknown>), [email]);
  const ownEmails = useMemo(() => new Set([account?.email, ...(identities ?? []).map((i) => i.email)].filter(Boolean).map((x) => x!.toLowerCase())), [account?.email, identities]);

  return (
    <article className={cn(!first && 'border-t border-line')} aria-label={t('messageFrom', { name: displayName(shownFrom) || t('unknownSender') })}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={isDraft ? editDraft : onToggle}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), isDraft ? editDraft() : onToggle())}
        className={cn('flex cursor-default items-start gap-3 px-4 pt-3.5 outline-none select-none focus-visible:bg-row-hover md:px-5', expanded ? 'pb-1' : 'pb-3.5 hover:bg-row-hover')}
      >
        <SenderAvatar name={displayName(shownFrom)} email={from?.email ?? '?'} size={34} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {isDraft && <span className="shrink-0 text-[13px] font-medium text-danger">{t('mail:row.draft')}</span>}
            <span dir="auto" className="truncate text-[13.5px] font-semibold text-text-1">{displayName(shownFrom) || t('unknownSender')}</span>
            <PriorityMark priority={priority} className="self-center" />
            {expanded && from && <span className="hidden truncate text-[12px] text-text-3 sm:inline" dir="ltr">&lt;{from.email}&gt;</span>}
            <span className="ms-auto shrink-0 text-[12px] text-text-3 tabular" title={longDate(email.sentAt ?? email.receivedAt)}>
              {email.hasAttachment && !expanded && <Paperclip className="me-1 inline size-3 align-[-1px]" />}
              {listDate(email.receivedAt)}
            </span>
          </div>
          {expanded ? (
            <div className="mt-0.5 text-[12px] text-text-3">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDetails((d) => !d);
                }}
                className="inline-flex max-w-full items-center gap-1 truncate rounded hover:text-text-2"
              >
                <span className="truncate">
                  {t('toLine', { list: addrList(email.to, names) || t('nobody') })}
                  {email.cc?.length ? `, ${t('ccLine', { list: addrList(email.cc, names) })}` : ''}
                </span>
                <ChevronDown className={cn('size-3 shrink-0 transition-transform duration-150 ease-voxel', details && 'rotate-180')} />
              </button>
            </div>
          ) : (
            <p dir="auto" className="mt-0.5 truncate text-[13px] text-text-3 rtl:text-right">{email.preview}</p>
          )}
        </div>
        {expanded && (
          <div className="-mt-1 -me-2 hidden items-center sm:flex" onClick={(e) => e.stopPropagation()}>
            <IconButton label={t('reply')} onClick={() => onReply('reply')} size="sm">
              <Reply className="rtl:-scale-x-100" />
            </IconButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t('common:actions.more')} size="sm">
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => onReply('reply')}>
                  <Reply className="rtl:-scale-x-100" /> {t('reply')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onReply('replyAll')}>
                  <ReplyAll className="rtl:-scale-x-100" /> {t('replyAll')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onReply('forward')}>
                  <Forward className="rtl:-scale-x-100" /> {t('forward')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onReply('forwardAttachment')}>
                  <Paperclip /> {t('forwardAttachment')}
                </DropdownMenuItem>
                {canAdd && from?.email && (
                  <DropdownMenuItem onSelect={() => void openAddContact({ accountId, mailboxEmail: account!.email, name: from.name ?? '', email: from.email })}>
                    <UserPlus /> {t('contacts:reader.addSender')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void printEmail(email, accountId, jmapAccountId)}>
                  <Printer /> {t('toolbar.print')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onSource}>
                  <Code2 /> {t('toolbar.source')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={tBase}
            className="overflow-hidden"
          >
            <div className="px-4 pb-5 md:px-5 md:ps-[66px]">
              <AnimatePresence initial={false}>
                {details && (
                  <motion.dl
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={tBase}
                    className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 overflow-hidden rounded-lg bg-muted/60 p-3 text-[12px] text-text-2"
                  >
                    <dt className="text-text-3">{t('details.from')}</dt>
                    <AddressCell list={email.from ?? []} names={names} accountId={accountId} mailboxEmail={account?.email ?? ''} canAdd={canAdd} />
                    <dt className="text-text-3">{t('details.to')}</dt>
                    <AddressCell list={email.to ?? []} names={names} accountId={accountId} mailboxEmail={account?.email ?? ''} canAdd={canAdd} />
                    {!!email.cc?.length && (
                      <>
                        <dt className="text-text-3">{t('details.cc')}</dt>
                        <AddressCell list={email.cc} names={names} accountId={accountId} mailboxEmail={account?.email ?? ''} canAdd={canAdd} />
                      </>
                    )}
                    {!!email.replyTo?.length && (
                      <>
                        <dt className="text-text-3">{t('details.replyTo')}</dt>
                        <dd className="break-all" dir="auto">{email.replyTo.map(formatAddress).join(', ')}</dd>
                      </>
                    )}
                    <dt className="text-text-3">{t('details.date')}</dt>
                    <dd>{longDate(email.sentAt ?? email.receivedAt)}</dd>
                  </motion.dl>
                )}
              </AnimatePresence>
              <ReceiptBanner email={email} accountId={accountId} identities={identities} ownEmails={ownEmails} />
              {blocked > 0 && !allowRemote && (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-muted/50 px-3 py-2 text-[12.5px] text-text-2">
                  <ImageOff className="size-3.5 text-text-3" />
                  <span>{t('images.blocked')}</span>
                  <span className="flex gap-3">
                    <button type="button" className="font-medium text-voxel-accent-strong hover:underline" onClick={() => setAllowOnce(true)}>
                      {t('images.show')}
                    </button>
                    {fromEmail && (
                      <button
                        type="button"
                        className="font-medium text-text-2 hover:text-text-1 hover:underline"
                        onClick={() => {
                          setSettings({ trustedSenders: [...trusted, fromEmail] });
                          toast(t('images.alwaysToast', { email: fromEmail }));
                        }}
                      >
                        {t('images.always')}
                      </button>
                    )}
                  </span>
                </div>
              )}
              <div className="mt-3">
                {html && cid.skipped > 0 && !allCid && (
                  <button type="button" className="mb-2 text-[12.5px] font-medium text-voxel-accent-strong hover:underline" onClick={() => setAllCid(true)}>
                    {t('images.showInline', { count: cid.skipped })}
                  </button>
                )}
                {html && !cid.ready ? (
                  <div className="voxel-skeleton h-40 rounded-lg" />
                ) : html ? (
                  <EmailFrame html={html} allowRemote={allowRemote} cidMap={cidMap} accountId={accountId} onBlocked={onBlocked} />
                ) : (
                  <div className="voxel-plain text-text-1" dir="auto" dangerouslySetInnerHTML={{ __html: plainToHtml(text) }} />
                )}
              </div>
              {calendarPart?.blobId && account && (
                <Suspense fallback={null}>
                  <InvitationCard account={account} jmapAccountId={jmapAccountId} blobId={calendarPart.blobId} />
                </Suspense>
              )}
              <Attachments parts={visibleAttachments} accountId={accountId} jmapAccountId={jmapAccountId} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function SourceDialog({ email, accountId, jmapAccountId, onClose }: { email: Email | null; accountId: string; jmapAccountId: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const { t } = useTranslation('reader');
  useEffect(() => {
    if (!email) return;
    setText(null);
    fetchBlob(accountId, jmapAccountId, email.blobId, 'message.eml', 'message/rfc822')
      .then((b) => b.text())
      .then(setText)
      .catch((e) => setText(i18n.t('reader:sourceError', { message: (e as Error).message })));
  }, [email, accountId, jmapAccountId]);
  return (
    <Dialog open={!!email} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(86vh,860px)] w-[min(94vw,1000px)] max-w-none flex-col gap-3 sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{t('sourceTitle')}</DialogTitle>
        </DialogHeader>
        <pre className={cn('min-h-0 flex-1 overflow-auto rounded-lg bg-muted p-4 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-text-2', text === null && 'voxel-skeleton')} dir="ltr">
          {text}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

async function printEmail(email: Email, accountId: string, jmapAccountId: string) {
  const html = bodyHtml(email);
  // images intégrées : URL d'objets (révoquées après l'impression)
  const cid = html ? await buildCidMap(accountId, jmapAccountId, email.attachments ?? []).catch(() => ({ map: {}, urls: [] as string[] })) : { map: {}, urls: [] as string[] };
  const cidMap: Record<string, string> = cid.map;
  const body = html ? sanitizeEmailHtml(html, { allowRemote: true, cidMap }).html : `<pre style="white-space:pre-wrap;font:inherit">${plainToHtml(bodyText(email))}</pre>`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const from = i18n.t('reader:print.from', { list: (email.from ?? []).map(formatAddress).join(', ') });
  const to = i18n.t('reader:print.to', { list: (email.to ?? []).map(formatAddress).join(', ') });
  const head = `<div dir="${document.documentElement.dir || 'ltr'}" style="border-bottom:1px solid #e7e4e0;padding-bottom:12px;margin-bottom:16px"><h2 dir="auto" style="margin:0 0 6px;font-size:18px">${esc(email.subject ?? '')}</h2><div style="font-size:12px;color:#57534e">${esc(from)}<br>${esc(to)}<br>${esc(longDate(email.sentAt ?? email.receivedAt))}</div></div>`;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.srcdoc = emailDocument(head + body, true);
  document.body.appendChild(frame);
  frame.onload = () => {
    setTimeout(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => {
        frame.remove();
        cid.urls.forEach((u) => URL.revokeObjectURL(u));
      }, 1000);
    }, 250);
  };
}

function unsubscribe(email: Email, accountId: string) {
  const urls = unsubscribeUrls(email);
  const mailto = urls.find((u) => u.toLowerCase().startsWith('mailto:'));
  const http = urls.find((u) => /^https?:/i.test(u));
  if (http) {
    window.open(http, '_blank', 'noopener,noreferrer');
    toast(i18n.t('reader:unsubscribeOpened'));
  } else if (mailto) {
    startMailto(mailto.includes('subject=') ? mailto : `${mailto}${mailto.includes('?') ? '&' : '?'}subject=unsubscribe`, accountId);
  }
}

