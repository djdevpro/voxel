/**
 * Routes de l'appli, déclarées en code avec TanStack Router.
 *
 *   /login?email=&redirect=                    connexion / choix du compte
 *   /                                          → réception de la dernière boîte ouverte (ou de la 1re)
 *   /m/:mailbox/:folder                        liste d'un dossier (`:mailbox` = adresse e-mail)
 *   /m/:mailbox/:folder/t/:threadId?msg=       conversation ouverte
 *   /all/:folder                               vue unifiée
 *   /all/:folder/t/:mailbox/:threadId?msg=     conversation en vue unifiée
 *   /compose?to=&cc=&bcc=&subject=&body=&mailto=  nouvelle rédaction (gestionnaire mailto:)
 *   /contacts?q=&in=&book=&group=              contacts (recherche, boîte, carnet, groupe)
 *   /contacts/:mailbox/:cardId                 fiche de contact ouverte
 *   /calendar/:view/:date?event=               agenda (month|week|day|agenda, AAAA-MM-JJ), événement ouvert
 *   /summaries/:date                           résumés quotidiens de l'IA (jour ouvert, AAAA-MM-JJ, facultatif)
 *   ?q=&filter=  sur les listes ; ?settings=<section>&mailbox=  partout
 */
import { createRootRoute, createRoute, createRouter, Navigate } from '@tanstack/react-router';
import { AppLayout, ComposeRoute, IndexRedirect, Root } from './App';
import { bindRouter, accountByEmail, lastCalendarView, todayIso } from './nav/nav';
import { parseSettingsTab, normalizeFilter, parseFolder, quickFromFilter, safeRedirect, searchFromQuery, str, type SettingsTab } from './nav/model';
import { queryClient } from './lib/queryClient';
import { threadQuery, accountsQuery } from './lib/mail';
import { threadsQueryOptions } from './hooks/useData';
import { useUi } from './store/ui';
import type { Account } from './lib/api';

// ------------------------------------------------------------------ paramètres de recherche (typés, validés)

export interface RootSearch {
  settings?: SettingsTab;
  /** boîte présélectionnée dans les paramètres (adresse) */
  mailbox?: string;
}
export interface LoginSearch {
  email?: string;
  redirect?: string;
}
export interface ListSearch {
  q?: string;
  filter?: string;
}
export interface ThreadSearch {
  msg?: string;
}
export interface ContactsSearch {
  q?: string;
  in?: string;
  book?: string;
  group?: string;
}
export interface ComposeSearch {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  mailto?: string;
}

const rootSearch = (s: Record<string, unknown>): RootSearch => ({
  settings: parseSettingsTab(s.settings),
  mailbox: str(s.mailbox),
});
const loginSearch = (s: Record<string, unknown>): LoginSearch => ({ email: str(s.email)?.trim().toLowerCase(), redirect: safeRedirect(s.redirect) });
const listSearch = (s: Record<string, unknown>): ListSearch => ({ q: str(s.q)?.trim() || undefined, filter: normalizeFilter(s.filter) });
const threadSearch = (s: Record<string, unknown>): ThreadSearch => ({ msg: str(s.msg) });
const contactsSearch = (s: Record<string, unknown>): ContactsSearch => ({
  q: str(s.q)?.trim() || undefined,
  in: str(s.in)?.trim().toLowerCase(),
  book: str(s.book),
  group: str(s.group),
});
const composeSearch = (s: Record<string, unknown>): ComposeSearch => ({
  to: str(s.to),
  cc: str(s.cc),
  bcc: str(s.bcc),
  subject: str(s.subject),
  body: str(s.body),
  mailto: str(s.mailto),
});

/** Valeurs de recherche toujours lues comme du texte (pas de conversion JSON : `?subject=007` reste « 007 »). */
function parseSearch(searchStr: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  new URLSearchParams(searchStr.startsWith('?') ? searchStr.slice(1) : searchStr).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function stringifySearch(search: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ------------------------------------------------------------------ préchargement (react-query)

function accounts(): Account[] {
  return queryClient.getQueryData<Account[]>(accountsQuery.queryKey) ?? [];
}

/** Précharge la première page d'une liste (survol d'un dossier, ouverture). Ne bloque jamais la navigation. */
function prefetchList(scope: 'm' | 'all', params: { mailbox?: string; folder?: string }, search: ListSearch) {
  const sel = parseFolder(params.folder);
  if (!sel) return;
  const list = accounts();
  const ids = scope === 'all' ? list.map((a) => a.id) : [accountByEmail(params.mailbox, list)?.id].filter((x): x is string => !!x);
  if (!ids.length) return;
  const s = searchFromQuery(search.q);
  void queryClient.prefetchInfiniteQuery(
    threadsQueryOptions(ids, { mailbox: sel, chips: s.chips, text: s.text, quick: quickFromFilter(search.filter), sortAsc: useUi.getState().sortAsc }),
  );
}

function prefetchThread(email: string | undefined, threadId: string) {
  const a = accountByEmail(email);
  if (a) void queryClient.prefetchQuery(threadQuery(a.id, threadId));
}

// ------------------------------------------------------------------ arbre

const rootRoute = createRootRoute({
  validateSearch: rootSearch,
  component: Root,
  notFoundComponent: () => <Navigate to="/" replace />,
});

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: 'login', validateSearch: loginSearch, component: () => null });

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: '_app', component: AppLayout });

const indexRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: IndexRedirect });

const mailboxRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'm/$mailbox/$folder',
  validateSearch: listSearch,
  loaderDeps: ({ search }) => ({ q: search.q, filter: search.filter }),
  loader: ({ params, deps }) => prefetchList('m', params, deps),
});

const threadRoute = createRoute({
  getParentRoute: () => mailboxRoute,
  path: 't/$threadId',
  validateSearch: threadSearch,
  loader: ({ params }) => prefetchThread(params.mailbox, params.threadId),
});

const allRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'all/$folder',
  validateSearch: listSearch,
  loaderDeps: ({ search }) => ({ q: search.q, filter: search.filter }),
  loader: ({ params, deps }) => prefetchList('all', params, deps),
});

const allThreadRoute = createRoute({
  getParentRoute: () => allRoute,
  path: 't/$mailbox/$threadId',
  validateSearch: threadSearch,
  loader: ({ params }) => prefetchThread(params.mailbox, params.threadId),
});

const composeRoute = createRoute({ getParentRoute: () => appRoute, path: 'compose', validateSearch: composeSearch, component: ComposeRoute });

// Contacts : la liste, et une fiche ; l'écran est rendu par MailApp (le rail reste en place)
const contactsRoute = createRoute({ getParentRoute: () => appRoute, path: 'contacts', validateSearch: contactsSearch });
const contactRoute = createRoute({ getParentRoute: () => contactsRoute, path: '$mailbox/$cardId' });

// Agenda : `/calendar` → vue mémorisée du jour ; l'écran est rendu par MailApp
const calendarIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'calendar',
  component: () => <Navigate to="/calendar/$view/$date" params={{ view: lastCalendarView(), date: todayIso() }} search={{ event: undefined }} replace />,
});
const calendarRoute = createRoute({ getParentRoute: () => appRoute, path: 'calendar/$view/$date', validateSearch: (s: Record<string, unknown>) => ({ event: str(s.event) }) });

// Résumés quotidiens de l'IA : la liste, et un jour ouvert (AAAA-MM-JJ) ; l'écran est rendu par MailApp
const summariesRoute = createRoute({ getParentRoute: () => appRoute, path: 'summaries' });
const summaryRoute = createRoute({ getParentRoute: () => summariesRoute, path: '$date' });

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([indexRoute, mailboxRoute.addChildren([threadRoute]), allRoute.addChildren([allThreadRoute]), composeRoute, contactsRoute.addChildren([contactRoute]), calendarIndexRoute, calendarRoute, summariesRoute.addChildren([summaryRoute])]),
]);

export const router = createRouter({
  routeTree,
  parseSearch,
  stringifySearch,
  // les données viennent de react-query : le routeur appelle toujours les loaders (préchargement non bloquant)
  defaultPreload: 'intent',
  defaultPreloadDelay: 90,
  defaultPreloadStaleTime: 0,
  defaultStructuralSharing: true,
  scrollRestoration: true,
  // un autre dossier repart du haut ; ouvrir une conversation garde la position (resetScroll: false)
  scrollToTopSelectors: ['[data-scroll-restoration-id="thread-list"]'],
});

bindRouter(router);

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
