/**
 * Navigation : l'URL est la source de vérité. Ce module dérive l'état de navigation
 * de la route courante et expose les actions impératives (push / replace) utilisées partout
 * (rail, barre latérale, liste, lecteur, raccourcis, palette, notifications, toasts).
 *
 * Le routeur est injecté par `router.tsx` (`bindRouter`) pour éviter les imports circulaires.
 */
import type { AnyRouter } from '@tanstack/react-router';
import { queryClient } from '@/lib/queryClient';
import type { Account } from '@/lib/api';
import { ALL, type MailboxSel, type OpenThread, type QuickFilters, type SearchChip, type View } from '@/store/ui';
import {
  filterFromQuick,
  folderParam,
  parseSettingsTab,
  parseFolder,
  queryFromSearch,
  quickFromFilter,
  searchFromQuery,
  str,
  type SettingsTab,
} from './model';

let routerRef: AnyRouter | null = null;

export function bindRouter(r: AnyRouter) {
  routerRef = r;
}

function R(): AnyRouter {
  if (!routerRef) throw new Error('router not bound');
  return routerRef;
}

// ------------------------------------------------------------------ comptes

function accounts(): Account[] {
  return queryClient.getQueryData<Account[]>(['accounts']) ?? [];
}

export function emailOf(accountId: string, list: Account[] = accounts()): string | undefined {
  return list.find((a) => a.id === accountId)?.email;
}

export function accountByEmail(email: string | undefined, list: Account[] = accounts()): Account | undefined {
  if (!email) return undefined;
  const low = email.trim().toLowerCase();
  return list.find((a) => a.email.toLowerCase() === low || a.id === email);
}

// ------------------------------------------------------------------ dérivation

/** Ce que le routeur sait de la route affichée (dernière correspondance). */
export interface RouteSnapshot {
  routeId: string;
  params: Record<string, string | undefined>;
  search: Record<string, unknown>;
}

export type RouteKind = 'list' | 'thread' | 'login' | 'compose' | 'index' | 'contacts' | 'calendar' | 'summaries' | 'other';

/** Vues de l'agenda (`/calendar/:view/:date`). */
export type CalendarViewKind = 'month' | 'week' | 'day' | 'agenda';
export const CALENDAR_VIEWS: readonly CalendarViewKind[] = ['month', 'week', 'day', 'agenda'];

/** Écran Agenda : vue et date (`AAAA-MM-JJ`), plus l'événement ouvert (`?event=<boîte>:<id>[:<occurrence>]`). */
export interface CalendarNav {
  view: CalendarViewKind;
  date: string;
  event?: string;
}

/** Filtres de l'écran Contacts (`/contacts?q=&in=&book=&group=`). */
export interface ContactsFilters {
  /** recherche instantanée */
  q?: string;
  /** boîte (adresse) */
  in?: string;
  /** carnet (id JMAP, dans la boîte `in`) */
  book?: string;
  /** groupe (id de la fiche groupe, dans la boîte `in`) */
  group?: string;
}

export interface Nav {
  route: RouteKind;
  scope: 'm' | 'all' | null;
  /** vue de la liste (boîte résolue ou `all`) ; valeur de repli hors des routes de liste */
  view: View;
  /** adresse présente dans l'URL mais absente de la session (lien profond) */
  missingEmail: string | null;
  /** `:folder` brut et validité syntaxique */
  folder: string | null;
  folderValid: boolean;
  thread: OpenThread | null;
  q: string;
  search: { chips: SearchChip[]; text: string };
  filter: string | undefined;
  quick: QuickFilters;
  settings: SettingsTab | undefined;
  settingsMailbox: string | undefined;
  /** fiche ouverte (`/contacts/:mailbox/:cardId`) */
  contact: { email: string; cardId: string } | null;
  /** filtres de l'écran Contacts */
  contacts: ContactsFilters;
  /** écran Agenda (vue, date) */
  calendar: CalendarNav | null;
  /** résumé ouvert (`/summaries/:date`, AAAA-MM-JJ valide) */
  summary: string | null;
}

const INBOX: MailboxSel = { kind: 'role', role: 'inbox' };
let lastView: View | null = null;

/** Dernière vue de liste affichée (sert de « boîte courante » pour /, /compose et les raccourcis). */
export function getLastView(list: Account[] = accounts()): View {
  if (lastView && (lastView.accountId === ALL ? list.length > 1 : list.some((a) => a.id === lastView!.accountId))) return lastView;
  const saved = readLastMailbox();
  if (saved === ALL && list.length > 1) return { accountId: ALL, mailbox: INBOX };
  const a = accountByEmail(saved ?? undefined, list) ?? list[0];
  return { accountId: a?.id ?? ALL, mailbox: INBOX };
}

const LAST_KEY = 'voxel.lastMailbox';

function readLastMailbox(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function rememberLastMailbox(v: string) {
  try {
    localStorage.setItem(LAST_KEY, v);
  } catch {
    /* stockage indisponible */
  }
}

function routeKind(s: RouteSnapshot): RouteKind {
  if (s.routeId.includes('/summaries')) return 'summaries';
  if (s.routeId.includes('/contacts')) return 'contacts';
  if (s.routeId.includes('/calendar')) return 'calendar';
  if (s.params.threadId) return 'thread';
  if (s.params.folder) return 'list';
  if (s.routeId.endsWith('/login')) return 'login';
  if (s.routeId.endsWith('/compose')) return 'compose';
  if (s.routeId.endsWith('/_app/') || s.routeId === '/_app/') return 'index';
  return 'other';
}

export function deriveNav(s: RouteSnapshot, list: Account[] = accounts()): Nav {
  const route = routeKind(s);
  const scope = route === 'list' || route === 'thread' ? (s.routeId.includes('/all/') ? 'all' : 'm') : null;
  const q = str(s.search.q) ?? '';
  const filter = str(s.search.filter);
  const settings = parseSettingsTab(s.search.settings);
  const settingsMailbox = str(s.search.mailbox);
  const base = {
    route,
    scope,
    q,
    search: searchFromQuery(q),
    filter,
    quick: quickFromFilter(filter),
    settings,
    settingsMailbox,
    contact: route === 'contacts' && s.params.mailbox && s.params.cardId ? { email: s.params.mailbox, cardId: s.params.cardId } : null,
    contacts: route === 'contacts' ? contactsFilters(s.search) : {},
    calendar: route === 'calendar' ? calendarNav(s) : null,
    summary: route === 'summaries' ? validIsoDate(s.params.date) : null,
  } as const;

  if (!scope) {
    return { ...base, view: getLastView(list), missingEmail: null, folder: null, folderValid: true, thread: null };
  }

  const folder = s.params.folder ?? 'inbox';
  const parsed = parseFolder(folder);
  let missingEmail: string | null = null;
  let accountId: string = ALL;
  if (scope === 'm') {
    const email = s.params.mailbox ?? '';
    const a = accountByEmail(email, list);
    if (a) accountId = a.id;
    else missingEmail = email;
  }
  // en vue unifiée, seuls les rôles ont un sens
  const folderValid = !!parsed && (scope === 'm' || parsed.kind === 'role');
  const mailbox = folderValid && parsed ? parsed : INBOX;
  const view: View = { accountId: missingEmail ? (getLastView(list).accountId) : accountId, mailbox };

  let thread: OpenThread | null = null;
  if (route === 'thread' && s.params.threadId) {
    const threadAccount = scope === 'all' ? accountByEmail(s.params.mailbox, list) : list.find((a) => a.id === accountId);
    if (threadAccount) thread = { accountId: threadAccount.id, threadId: s.params.threadId, emailId: str(s.search.msg) };
    else if (!missingEmail) missingEmail = s.params.mailbox ?? null;
  }

  if (!missingEmail && folderValid) lastView = view;
  return { ...base, view, missingEmail, folder, folderValid, thread };
}

/** Date du jour locale (`AAAA-MM-JJ`). */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Date d'URL valide (`AAAA-MM-JJ`), sinon `null`. */
function validIsoDate(v: unknown): string | null {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d!));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d) return v;
  }
  return null;
}

/** Date d'URL valide (`AAAA-MM-JJ`), sinon aujourd'hui. */
export function parseIsoDate(v: unknown): string {
  return validIsoDate(v) ?? todayIso();
}

function calendarNav(s: RouteSnapshot): CalendarNav {
  const view = CALENDAR_VIEWS.includes(s.params.view as CalendarViewKind) ? (s.params.view as CalendarViewKind) : 'month';
  const event = str(s.search.event);
  return { view, date: parseIsoDate(s.params.date), ...(event ? { event } : {}) };
}

function contactsFilters(search: Record<string, unknown>): ContactsFilters {
  return cleanSearch({ q: str(search.q), in: str(search.in), book: str(search.book), group: str(search.group) });
}

export function snapshotOf(router: AnyRouter = R()): RouteSnapshot {
  const matches = router.state.matches;
  const m = matches[matches.length - 1];
  return { routeId: m?.routeId ?? '', params: (m?.params ?? {}) as RouteSnapshot['params'], search: (m?.search ?? {}) as Record<string, unknown> };
}

/** État de navigation courant (hors React). */
export function getNav(): Nav {
  return deriveNav(snapshotOf());
}

// ------------------------------------------------------------------ cibles

export interface ListExtras {
  q?: string;
  filter?: string;
}

/** Options de navigation (forme `{ to, params, search }` du routeur). */
export interface Target {
  to: string;
  params: Record<string, string>;
  search: Record<string, string>;
}

function cleanSearch(o: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v) out[k] = v;
  return out;
}

export function listTarget(view: View, extras: ListExtras = {}, list: Account[] = accounts()): Target | null {
  const folder = folderParam(view.mailbox);
  const search = cleanSearch({ q: extras.q, filter: extras.filter });
  if (view.accountId === ALL) return { to: '/all/$folder', params: { folder }, search };
  const email = emailOf(view.accountId, list);
  if (!email) return null;
  return { to: '/m/$mailbox/$folder', params: { mailbox: email, folder }, search };
}

export function threadTarget(view: View, t: OpenThread, extras: ListExtras = {}, list: Account[] = accounts()): Target | null {
  const folder = folderParam(view.mailbox);
  const search = cleanSearch({ q: extras.q, filter: extras.filter, msg: t.emailId });
  const threadEmail = emailOf(t.accountId, list);
  if (!threadEmail) return null;
  if (view.accountId === ALL) return { to: '/all/$folder/t/$mailbox/$threadId', params: { folder, mailbox: threadEmail, threadId: t.threadId }, search };
  const email = emailOf(view.accountId, list) ?? threadEmail;
  return { to: '/m/$mailbox/$folder/t/$threadId', params: { mailbox: email, folder, threadId: t.threadId }, search };
}

/** Lien vers la réception d'une boîte (ou de toutes). */
export function inboxTarget(accountId: string): Target | null {
  return listTarget({ accountId, mailbox: INBOX });
}

// ------------------------------------------------------------------ actions

interface NavOpts {
  replace?: boolean;
}

type HistState = Record<string, unknown>;

function go(target: Target | null, opts: NavOpts & { state?: HistState; resetScroll?: boolean } = {}) {
  if (!target) return;
  void R().navigate({
    ...target,
    replace: opts.replace,
    resetScroll: opts.resetScroll,
    state: (opts.state ?? {}) as never,
  } as never);
}

function currentState(): HistState {
  return (R().state.location.state ?? {}) as unknown as HistState;
}

/** Navigue vers une cible déjà construite. */
export function goTarget(target: Target | null, opts: NavOpts = {}) {
  go(target, opts);
}

/** Ouvre un dossier (push) : la recherche et les filtres sont effacés. */
export function goView(view: View, opts: NavOpts = {}) {
  go(listTarget(view), opts);
}

/** Change de dossier en gardant la boîte courante. */
export function goFolder(mailbox: MailboxSel) {
  goView({ accountId: getNav().view.accountId, mailbox });
}

/** Ouvre une conversation : push depuis la liste, replace pour j/k. */
export function openThread(t: OpenThread, opts: NavOpts = {}) {
  const nav = getNav();
  const fromList = nav.route === 'list';
  const state = opts.replace ? { voxelFromList: currentState().voxelFromList } : { voxelFromList: fromList };
  go(threadTarget(nav.view, t, { q: nav.q, filter: nav.filter }), { ...opts, state, resetScroll: false });
}

/** Retour à la liste : Retour du navigateur si la conversation a été ouverte depuis la liste. */
export function closeThread() {
  const nav = getNav();
  if (!nav.thread) return;
  if (currentState().voxelFromList && window.history.length > 1) {
    R().history.back();
    return;
  }
  go(listTarget(nav.view, { q: nav.q, filter: nav.filter }), { resetScroll: false });
}

/** Applique une recherche sur la liste courante (la conversation ouverte est refermée). */
export function applySearch(s: { chips: SearchChip[]; text: string }, opts: NavOpts = {}) {
  const nav = getNav();
  const q = queryFromSearch(s);
  if (q === nav.q && nav.route === 'list') return;
  go(listTarget(nav.view, { q: q || undefined, filter: nav.filter }), opts);
}

/** Remplace des paramètres de recherche de l'URL courante (filtre, paramètres…) sans changer de route. */
function patchSearch(patch: Record<string, string | undefined>, opts: NavOpts & { state?: HistState } = {}) {
  const r = R();
  const loc = r.state.location;
  const next: Record<string, unknown> = { ...(loc.search as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  const searchStr = r.options.stringifySearch(next);
  void r.navigate({ href: loc.pathname + searchStr, replace: opts.replace, resetScroll: false, state: (opts.state ?? currentState()) as never } as never);
}

export function toggleQuick(k: keyof QuickFilters) {
  const nav = getNav();
  const next = { ...nav.quick, [k]: !nav.quick[k] };
  patchSearch({ filter: filterFromQuick(next) }, { replace: true });
}

/** Ouvre les paramètres par-dessus la vue courante (`?settings=<section>&mailbox=`). */
export function openSettings(tab?: SettingsTab, mailbox?: string) {
  const nav = getNav();
  if (nav.settings) {
    patchSearch({ settings: tab ?? nav.settings, ...(mailbox ? { mailbox } : {}) }, { replace: true });
    return;
  }
  patchSearch({ settings: tab ?? 'accounts', mailbox }, { state: { voxelOverlay: true } });
}

export function closeSettings() {
  const nav = getNav();
  if (!nav.settings) return;
  if (currentState().voxelOverlay && window.history.length > 1) {
    R().history.back();
    return;
  }
  patchSearch({ settings: undefined, mailbox: undefined }, { replace: true });
}

// ------------------------------------------------------------------ contacts

/** `/contacts` avec ses filtres, ou la fiche `/contacts/:mailbox/:cardId`. */
export function contactsTarget(filters: ContactsFilters = {}, card?: { email: string; cardId: string }): Target {
  const search = cleanSearch({ q: filters.q, in: filters.in, book: filters.book, group: filters.group });
  if (card) return { to: '/contacts/$mailbox/$cardId', params: { mailbox: card.email, cardId: card.cardId }, search };
  return { to: '/contacts', params: {}, search };
}

/** Ouvre l'écran Contacts (filtres conservés si on y est déjà). */
export function goContacts(filters?: ContactsFilters, opts: NavOpts = {}) {
  const nav = getNav();
  go(contactsTarget(filters ?? (nav.route === 'contacts' ? nav.contacts : {})), opts);
}

/** Ouvre une fiche en gardant les filtres de la liste. */
export function openContact(email: string, cardId: string, opts: NavOpts = {}) {
  const nav = getNav();
  go(contactsTarget(nav.contacts, { email, cardId }), { ...opts, resetScroll: false });
}

/** Referme la fiche (retour à la liste filtrée). */
export function closeContact(opts: NavOpts = {}) {
  const nav = getNav();
  go(contactsTarget(nav.contacts), { ...opts, resetScroll: false });
}

// ------------------------------------------------------------------ agenda

/** `/calendar/:view/:date` (et l'événement ouvert). */
export function calendarTarget(view: CalendarViewKind, date: string, event?: string): Target {
  return { to: '/calendar/$view/$date', params: { view, date }, search: cleanSearch({ event }) };
}

/** Ouvre l'agenda (vue et date conservées si on y est déjà, sinon le mois courant). */
export function goCalendar(view?: CalendarViewKind, date?: string, opts: NavOpts & { event?: string } = {}) {
  const nav = getNav();
  const cur = nav.calendar;
  go(calendarTarget(view ?? cur?.view ?? lastCalendarView(), date ?? cur?.date ?? todayIso(), opts.event), opts);
}

const CAL_VIEW_KEY = 'voxel.calendarView';

/** Dernière vue d'agenda choisie (appareil). */
export function lastCalendarView(): CalendarViewKind {
  try {
    const v = localStorage.getItem(CAL_VIEW_KEY);
    return CALENDAR_VIEWS.includes(v as CalendarViewKind) ? (v as CalendarViewKind) : 'month';
  } catch {
    return 'month';
  }
}

export function rememberCalendarView(v: CalendarViewKind) {
  try {
    localStorage.setItem(CAL_VIEW_KEY, v);
  } catch {
    /* stockage indisponible */
  }
}

// ------------------------------------------------------------------ résumés

/** Ouvre l'écran Résumés (`/summaries`) ou un jour (`/summaries/:date`). */
export function goSummaries(date?: string, opts: NavOpts = {}) {
  go(date ? { to: '/summaries/$date', params: { date }, search: {} } : { to: '/summaries', params: {}, search: {} }, opts);
}

/** Navigation par chemin complet (redirections internes déjà validées). */
export function goHref(href: string, opts: NavOpts = {}) {
  void R().navigate({ href, replace: opts.replace } as never);
}

/** Lien de connexion vers une boîte absente de la session, avec retour à l'URL demandée. */
export function goLogin(email: string | undefined, redirect: string | undefined, opts: NavOpts = {}) {
  void R().navigate({ to: '/login', search: cleanSearch({ email, redirect }), replace: opts.replace } as never);
}

export function currentHref(): string {
  // l'URL réelle de la barre d'adresse (l'état du routeur peut ne pas être encore validé au premier chargement)
  return window.location.pathname + window.location.search;
}
