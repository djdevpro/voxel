/**
 * Écran Contacts : `/contacts?q=&in=&book=&group=` et `/contacts/:mailbox/:cardId`.
 * Bureau : filtres (boîtes, carnets, groupes) | liste (recherche instantanée, index alphabétique) | fiche.
 * Mobile : liste puis fiche, selon l'URL. Données : cache Dexie (`lib/contacts.ts`), synchronisé à l'ouverture.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { BookUser, Check, ChevronLeft, Download, FolderOpen, Plus, Search, Trash2, Upload, UserPlus, Users, X } from 'lucide-react';
import { cardDisplayName, foldText, groupMembers, indexLetter, type ContactCard } from '@voxel/jmap';
import { useAccounts } from '@/hooks/useData';
import { useNav } from '@/nav/useNav';
import { closeContact, contactsTarget, goContacts, goHref, goTarget, openContact, type ContactsFilters } from '@/nav/nav';
import { createCard, deleteCards, exportCards, syncContacts, useAddressBooks, useCards } from '@/lib/contacts';
import type { BookRow, CardRow } from '@/lib/db';
import type { Account } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { tBase, tFast, tSlow } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useDirection } from '@/hooks/useDirection';
import { AccountDot, EmptyState, IconButton, SenderAvatar } from '@/components/common/bits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { inputCls } from '@/components/settings/ui';
import { confirmDialog } from '@/store/confirm';
import { ContactDetail } from './ContactDetail';
import { ImportDialog } from './ImportDialog';

/** Boîtes qui annoncent les contacts. */
export function useContactAccounts(): Account[] {
  const { data } = useAccounts();
  return useMemo(() => (data ?? []).filter((a) => a.capabilities.contacts), [data]);
}

interface Scope {
  accounts: Account[];
  account: Account | undefined;
  filters: ContactsFilters;
}

function useScope(): Scope {
  const nav = useNav();
  const accounts = useContactAccounts();
  const filters = nav.contacts;
  const account = filters.in ? accounts.find((a) => a.email.toLowerCase() === filters.in) : undefined;
  return { accounts, account, filters };
}

// ------------------------------------------------------------------ filtres (colonne de gauche)

function FilterRow({ active, icon, label, count, onClick, color }: { active: boolean; icon: ReactNode; label: string; count?: number; onClick: () => void; color?: string }) {
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      className={cn(
        'group flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-start text-[13.5px] voxel-transition select-none focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none [&_svg]:size-4 [&_svg]:shrink-0',
        active ? 'bg-voxel-accent-soft font-medium text-text-1' : 'text-text-2 hover:bg-black/[0.04] hover:text-text-1 dark:hover:bg-white/[0.05]',
      )}
    >
      {color ? <AccountDot color={color} /> : <span className="text-text-3">{icon}</span>}
      <span dir="auto" className="min-w-0 flex-1 truncate">
        {label}
      </span>
      {count !== undefined && count > 0 && <span className="text-[12px] text-text-3 tabular-nums">{count}</span>}
    </button>
  );
}

function FiltersPane({ scope, rows, books, onNewGroup, onImport, onExport, onNavigate, className }: {
  scope: Scope;
  rows: CardRow[];
  books: BookRow[];
  onNewGroup: (accountId: string) => void;
  onImport: () => void;
  onExport: () => void;
  onNavigate?: () => void;
  className?: string;
}) {
  const { t } = useTranslation('contacts');
  const { accounts, filters } = scope;
  const people = rows.filter((r) => r.kind !== 'group');
  const go = (f: ContactsFilters) => {
    goContacts({ q: filters.q, ...f });
    onNavigate?.();
  };
  const newContact = () => {
    const a = scope.account ?? accounts[0];
    if (!a) return;
    openContact(a.email, 'new');
    onNavigate?.();
  };
  return (
    <aside aria-label={t('filters')} data-pane="sidebar" className={cn('flex min-h-0 flex-col bg-sidebar', className)}>
      <div className="px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={newContact}
          className="voxel-btn-tonal flex h-10 w-full items-center gap-2.5 rounded-[10px] px-3.5 text-[13.5px] font-medium active:scale-[0.985]"
        >
          <UserPlus className="size-4" />
          {t('newContact')}
        </button>
      </div>
      <nav aria-label={t('filters')} className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-4">
        <FilterRow active={!filters.in && !filters.book && !filters.group} icon={<BookUser />} label={t('all')} count={people.length} onClick={() => go({})} />
        {accounts.map((a) => {
          const own = books.filter((b) => b.accountId === a.id);
          const groups = rows.filter((r) => r.accountId === a.id && r.kind === 'group');
          const mine = filters.in === a.email.toLowerCase();
          return (
            <section key={a.id} className="pt-4" aria-label={a.displayName || a.email}>
              {accounts.length > 1 && (
                <FilterRow
                  active={mine && !filters.book && !filters.group}
                  icon={null}
                  color={a.color}
                  label={a.displayName || a.email}
                  count={people.filter((r) => r.accountId === a.id).length}
                  onClick={() => go({ in: a.email.toLowerCase() })}
                />
              )}
              {own.length > 1 || accounts.length === 1 ? (
                <>
                  <div className="mt-1 mb-1 flex h-6 items-center px-2 text-[11.5px] font-medium tracking-wide text-text-3 uppercase">{t('books')}</div>
                  {own.map((b) => (
                    <FilterRow
                      key={b.id}
                      active={mine && filters.book === b.id}
                      icon={<FolderOpen />}
                      label={b.book.name}
                      count={people.filter((r) => r.accountId === a.id && r.bookIds.includes(b.id)).length}
                      onClick={() => go({ in: a.email.toLowerCase(), book: b.id })}
                    />
                  ))}
                </>
              ) : null}
              <div className="group mt-2 mb-1 flex h-6 items-center gap-1.5 px-2">
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium tracking-wide text-text-3 uppercase">{t('groups')}</span>
                <button
                  type="button"
                  aria-label={t('newGroup')}
                  onClick={() => onNewGroup(a.id)}
                  className="flex size-5 items-center justify-center rounded text-text-3 voxel-transition hover:bg-black/[0.06] hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none dark:hover:bg-white/[0.08]"
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
              {groups.length === 0 && <p className="px-2 text-[12px] text-text-3">{t('noGroups')}</p>}
              {groups.map((g) => (
                <FilterRow
                  key={g.id}
                  active={mine && filters.group === g.id}
                  icon={<Users />}
                  label={cardDisplayName(g.card) || t('unnamedGroup')}
                  count={groupMembers(g.card, rows.filter((r) => r.accountId === a.id)).length}
                  onClick={() => {
                    // le groupe filtre la liste et s'ouvre à droite (nom, membres)
                    goTarget(contactsTarget({ in: a.email.toLowerCase(), group: g.id }, { email: a.email, cardId: g.id }));
                    onNavigate?.();
                  }}
                />
              ))}
            </section>
          );
        })}
      </nav>
      <div className="flex gap-1 border-t border-line p-2">
        <Button variant="ghost" size="sm" className="flex-1 justify-start" onClick={onImport}>
          <Upload /> {t('import')}
        </Button>
        <Button variant="ghost" size="sm" className="flex-1 justify-start" onClick={onExport}>
          <Download /> {t('export')}
        </Button>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ liste

function ListPane({ scope, rows, list, selected, setSelected, openId, className }: {
  scope: Scope;
  rows: CardRow[];
  list: CardRow[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  openId: string | null;
  className?: string;
}) {
  const { t } = useTranslation('contacts');
  const { filters, accounts } = scope;
  const [text, setText] = useState(filters.q ?? '');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const accountOf = (id: string) => accounts.find((a) => a.id === id);

  // recherche instantanée, reflétée dans l'URL (remplacement, sans empiler l'historique)
  useEffect(() => setText(filters.q ?? ''), [filters.q]);
  useEffect(() => {
    const h = setTimeout(() => {
      if ((filters.q ?? '') !== text.trim()) goContacts({ ...filters, q: text.trim() || undefined }, { replace: true });
    }, 180);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener('voxel:contacts-search', focus);
    return () => window.removeEventListener('voxel:contacts-search', focus);
  }, []);

  const sections = useMemo(() => {
    const out: Array<{ letter: string; rows: CardRow[] }> = [];
    for (const r of list) {
      const l = indexLetter(r.card);
      const last = out[out.length - 1];
      if (last?.letter === l) last.rows.push(r);
      else out.push({ letter: l, rows: [r] });
    }
    return out;
  }, [list]);

  const group = filters.group ? rows.find((r) => r.id === filters.group) : undefined;
  const keyOf = (r: CardRow) => `${r.accountId}:${r.id}`;
  const toggle = (r: CardRow) => {
    const s = new Set(selected);
    if (s.has(keyOf(r))) s.delete(keyOf(r));
    else s.add(keyOf(r));
    setSelected(s);
  };

  /** Flèches haut / bas entre les lignes ; Espace coche ; Entrée ouvre. */
  const onRowKey = (e: RKeyboardEvent<HTMLElement>, r: CardRow) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-contact-row]') ?? [])];
      const i = all.indexOf(e.currentTarget as HTMLElement);
      all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === ' ') {
      e.preventDefault();
      toggle(r);
    }
  };

  const jump = (letter: string) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-letter="${CSS.escape(letter)}"]`);
    el?.scrollIntoView({ block: 'start' });
    el?.parentElement?.querySelector<HTMLElement>('[data-contact-row]')?.focus({ preventScroll: true });
  };

  const removeSelected = async () => {
    const keys = [...selected];
    const ok = await confirmDialog({ title: t('deleteMany.title', { count: keys.length }), description: t('deleteMany.description'), confirmLabel: t('delete'), destructive: true });
    if (!ok) return;
    const byAccount = new Map<string, string[]>();
    for (const k of keys) {
      const [acc, ...rest] = k.split(':');
      byAccount.set(acc!, [...(byAccount.get(acc!) ?? []), rest.join(':')]);
    }
    try {
      let queued = false;
      for (const [acc, ids] of byAccount) queued = (await deleteCards(acc, ids)).queued || queued;
      setSelected(new Set());
      toast.success(queued ? t('toast.queued') : t('toast.deletedMany', { count: keys.length }));
    } catch (e) {
      toast.error(t('toast.failed'), { description: errorMessage(e) });
    }
  };

  const exportSelected = () => {
    const cards = rows.filter((r) => selected.has(keyOf(r))).map((r) => r.card);
    void exportCards(cards).then(() => toast.success(t('toast.exported', { count: cards.length })));
  };

  return (
    <section aria-label={t('list')} data-pane="list" className={cn('flex min-h-0 min-w-0 flex-col border-e border-line bg-panel', className)}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <input
            ref={searchRef}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                listRef.current?.querySelector<HTMLElement>('[data-contact-row]')?.focus();
              } else if (e.key === 'Escape' && text) {
                e.stopPropagation();
                setText('');
              }
            }}
            placeholder={t('search')}
            aria-label={t('searchLabel')}
            className={cn(inputCls, 'h-8 ps-8')}
          />
        </div>
      </div>
      <AnimatePresence initial={false}>
        {selected.size > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tFast} className="overflow-hidden border-b border-line">
            <div className="flex items-center gap-1 px-3 py-1.5 text-[12.5px] text-text-2">
              <span className="me-auto">{t('selected', { count: selected.size })}</span>
              <IconButton label={t('exportSelection')} size="sm" onClick={exportSelected}>
                <Download />
              </IconButton>
              <IconButton label={t('deleteSelected')} size="sm" onClick={() => void removeSelected()}>
                <Trash2 />
              </IconButton>
              <IconButton label={t('clearSelection')} size="sm" onClick={() => setSelected(new Set())}>
                <X />
              </IconButton>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="px-4 pt-2 pb-1 text-[12px] text-text-3" aria-live="polite">
        {group ? t('groupHeading', { name: cardDisplayName(group.card) || t('unnamedGroup'), count: list.length }) : t('count', { count: list.length })}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-6" role="list">
          {list.length === 0 && (
            <EmptyState
              icon={filters.q ? <Search /> : <BookUser />}
              title={filters.q ? t('noResults') : t('empty.title')}
              description={filters.q ? undefined : t('empty.description')}
            />
          )}
          {sections.map((s) => (
            <div key={s.letter} role="presentation">
              <div data-letter={s.letter} className="sticky top-0 z-[1] bg-panel/95 px-4 pt-2 pb-0.5 text-[11.5px] font-semibold text-text-3 backdrop-blur">
                {s.letter}
              </div>
              {s.rows.map((r) => {
                const a = accountOf(r.accountId);
                const name = cardDisplayName(r.card);
                const sub = r.emails[0] ?? Object.values(r.card.organizations ?? {})[0]?.name ?? Object.values(r.card.phones ?? {})[0]?.number ?? '';
                const isOpen = openId === keyOf(r);
                const isSel = selected.has(keyOf(r));
                return (
                  <div key={keyOf(r)} role="listitem" className="group relative px-2">
                    <a
                      href={a ? `/contacts/${encodeURIComponent(a.email)}/${encodeURIComponent(r.id)}` : undefined}
                      data-contact-row
                      aria-current={isOpen ? 'true' : undefined}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || !a) return;
                        e.preventDefault();
                        openContact(a.email, r.id);
                      }}
                      onKeyDown={(e) => onRowKey(e, r)}
                      className={cn(
                        'flex h-12 items-center gap-3 rounded-lg ps-2 pe-10 outline-none voxel-transition focus-visible:ring-2 focus-visible:ring-voxel-accent',
                        isOpen ? 'bg-voxel-accent-soft' : isSel ? 'bg-black/[0.04] dark:bg-white/[0.05]' : 'hover:bg-row-hover',
                      )}
                    >
                      <SenderAvatar name={name} email={r.emails[0] ?? name} size={32} />
                      <span className="min-w-0 flex-1">
                        <span dir="auto" className="block truncate text-[13.5px] font-medium text-text-1">
                          {name || t('unnamed')}
                          {r.id.startsWith('local-') && <span className="ms-1.5 text-[11px] font-normal text-text-3">{t('pending')}</span>}
                        </span>
                        <span dir="auto" className="block truncate text-[12px] text-text-3">
                          {sub}
                          {scope.accounts.length > 1 && !scope.filters.in && a && <span className="ms-1.5 opacity-80">· {a.displayName || a.email}</span>}
                        </span>
                      </span>
                    </a>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isSel}
                      aria-label={t('select', { name: name || t('unnamed') })}
                      onClick={() => toggle(r)}
                      className={cn(
                        'absolute end-4 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-[5px] border voxel-transition focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none',
                        isSel ? 'border-voxel-accent bg-voxel-accent text-on-accent opacity-100' : 'border-line-strong bg-panel opacity-0 group-hover:opacity-100',
                        selected.size > 0 && 'opacity-100',
                      )}
                    >
                      {isSel && <Check className="size-3.5" />}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {sections.length > 3 && (
          <nav aria-label={t('index')} className="flex w-6 shrink-0 flex-col items-center justify-center gap-px py-2 text-[10.5px] font-semibold text-text-3">
            {sections.map((s) => (
              <button
                key={s.letter}
                type="button"
                onClick={() => jump(s.letter)}
                aria-label={t('jumpTo', { letter: s.letter })}
                className="flex h-4 w-5 items-center justify-center rounded voxel-transition hover:bg-voxel-accent-soft hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none"
              >
                {s.letter}
              </button>
            ))}
          </nav>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ dialogue « nouveau groupe »

function NewGroupDialog({ accountId, onClose }: { accountId: string | null; onClose: () => void }) {
  const { t } = useTranslation('contacts');
  const accounts = useContactAccounts();
  const books = useAddressBooks(accountId ? [accountId] : []);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(''), [accountId]);
  const submit = async () => {
    const a = accounts.find((x) => x.id === accountId);
    const book = books?.find((b) => b.book.isDefault) ?? books?.[0];
    if (!a || !book || !name.trim()) return;
    setBusy(true);
    try {
      const r = await createCard(a.id, book.id, { kind: 'group', name: { full: name.trim() }, members: {} });
      toast.success(r.queued ? t('toast.queued') : t('toast.groupCreated'));
      onClose();
      goTarget(contactsTarget({ in: a.email.toLowerCase(), group: r.id }, { email: a.email, cardId: r.id }));
    } catch (e) {
      toast.error(t('toast.failed'), { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!accountId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t('newGroup')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4"
        >
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{t('groupName')}</span>
            <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} dir="auto" />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !books?.length}>
              {t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ écran

export default function ContactsView({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation('contacts');
  const nav = useNav();
  const scope = useScope();
  const { data: allAccounts } = useAccounts();
  const ids = useMemo(() => (scope.account ? [scope.account.id] : scope.accounts.map((a) => a.id)), [scope.account, scope.accounts]);
  const rows = useCards(scope.accounts.map((a) => a.id)) ?? [];
  const books = useAddressBooks(scope.accounts.map((a) => a.id)) ?? [];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupFor, setGroupFor] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const rtl = useDirection() === 'rtl';

  // capacité absente partout : la route n'existe pas
  useEffect(() => {
    if (allAccounts && !scope.accounts.length) goHref('/', { replace: true });
  }, [allAccounts, scope.accounts.length]);

  // synchronisation à l'ouverture de l'écran
  useEffect(() => {
    for (const a of scope.accounts) void syncContacts(a.id);
  }, [scope.accounts]);

  const scoped = useMemo(() => rows.filter((r) => ids.includes(r.accountId)), [rows, ids]);
  const list = useMemo(() => {
    const { book, group, q } = scope.filters;
    let out = scoped.filter((r) => r.kind !== 'group');
    if (book) out = out.filter((r) => r.bookIds.includes(book));
    if (group) {
      const g = scoped.find((r) => r.id === group);
      out = g ? groupMembers(g.card, out) : [];
    }
    if (q) {
      const f = foldText(q);
      out = out.filter((r) => r.search.includes(f));
    }
    return out;
  }, [scoped, scope.filters]);

  // fiche ouverte (ou formulaire de création `…/new`)
  const contact = nav.contact;
  const contactAccount = contact ? scope.accounts.find((a) => a.email.toLowerCase() === contact.email.toLowerCase()) : undefined;
  const openRow = contact && contactAccount ? rows.find((r) => r.accountId === contactAccount.id && r.id === contact.cardId) : undefined;
  const creating = contact?.cardId === 'new';
  const openId = openRow ? `${openRow.accountId}:${openRow.id}` : null;
  const showDetail = !!contact;

  useEffect(() => {
    document.title = t('title', { app: 'Voxel' });
  });

  const exportCurrent = () => {
    const cards = (scope.filters.group || scope.filters.book || scope.filters.q ? list : scoped).map((r) => r.card) as ContactCard[];
    if (!cards.length) {
      toast(t('toast.nothingToExport'));
      return;
    }
    void exportCards(cards).then(() => toast.success(t('toast.exported', { count: cards.length })));
  };

  const detail = contact ? (
    contactAccount && (creating || openRow) ? (
      <ContactDetail
        key={`${contactAccount.id}:${contact.cardId}`}
        account={contactAccount}
        row={openRow}
        rows={rows.filter((r) => r.accountId === contactAccount.id)}
        books={books.filter((b) => b.accountId === contactAccount.id)}
        defaultBookId={scope.filters.book}
        mobile={mobile}
        onClose={() => closeContact()}
      />
    ) : (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={<BookUser />} title={t('notFound')} action={<Button variant="secondary" onClick={() => closeContact()}>{t('backToList')}</Button>} />
      </div>
    )
  ) : (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState icon={<BookUser />} title={t('noSelection.title')} description={t('noSelection.description')} />
    </div>
  );

  const filtersPane = (onNavigate?: () => void) => (
    <FiltersPane
      scope={scope}
      rows={rows}
      books={books}
      onNewGroup={(id) => setGroupFor(id)}
      onImport={() => setImportOpen(true)}
      onExport={exportCurrent}
      onNavigate={onNavigate}
      className={mobile ? 'min-w-0 flex-1' : 'w-[220px] shrink-0 border-e border-line'}
    />
  );

  const dialogs = (
    <>
      <NewGroupDialog accountId={groupFor} onClose={() => setGroupFor(null)} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} accounts={scope.accounts} defaultAccountId={scope.account?.id} defaultBookId={scope.filters.book} />
    </>
  );

  if (mobile) {
    const s = rtl ? -1 : 1;
    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-panel">
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
          <IconButton label={t('filters')} onClick={() => setFiltersOpen(true)}>
            <FolderOpen />
          </IconButton>
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-1">{t('nav')}</h1>
          <IconButton label={t('newContact')} onClick={() => scope.accounts[0] && openContact((scope.account ?? scope.accounts[0]).email, 'new')}>
            <UserPlus />
          </IconButton>
          <IconButton label={t('backToMail')} onClick={() => goHref('/')}>
            <X />
          </IconButton>
        </div>
        <div className="relative min-h-0 flex-1">
          <motion.div className="absolute inset-0 flex" animate={{ x: showDetail ? `${-24 * s}%` : 0, opacity: showDetail ? 0.6 : 1 }} transition={tBase}>
            <ListPane scope={scope} rows={rows} list={list} selected={selected} setSelected={setSelected} openId={openId} className="flex-1 border-e-0" />
          </motion.div>
          <AnimatePresence>
            {showDetail && (
              <motion.div key="detail" className="absolute inset-0 z-10 flex flex-col bg-panel shadow-float" initial={{ x: `${100 * s}%` }} animate={{ x: 0 }} exit={{ x: `${100 * s}%` }} transition={tSlow}>
                <div className="flex h-11 shrink-0 items-center border-b border-line px-1">
                  <Button variant="ghost" size="sm" onClick={() => closeContact()}>
                    <ChevronLeft className="rtl:-scale-x-100" /> {t('backToList')}
                  </Button>
                </div>
                {detail}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <AnimatePresence>
          {filtersOpen && (
            <>
              <motion.div key="scrim" className="fixed inset-0 z-40 bg-(--voxel-overlay)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tBase} onClick={() => setFiltersOpen(false)} />
              <motion.div
                key="drawer"
                className="fixed inset-y-0 start-0 z-50 flex w-[86%] max-w-[320px] border-e border-(--voxel-float-border) bg-sidebar pt-[env(safe-area-inset-top)] shadow-(--voxel-float-shadow)"
                initial={{ x: `${-100 * s}%` }}
                animate={{ x: 0 }}
                exit={{ x: `${-100 * s}%` }}
                transition={tSlow}
              >
                {filtersPane(() => setFiltersOpen(false))}
              </motion.div>
            </>
          )}
        </AnimatePresence>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {filtersPane()}
      <ListPane scope={scope} rows={rows} list={list} selected={selected} setSelected={setSelected} openId={openId} className="w-[300px] shrink-0 xl:w-[340px]" />
      <div className="flex min-w-0 flex-1 flex-col">{detail}</div>
      {dialogs}
    </div>
  );
}
