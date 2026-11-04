import { lazy, Suspense, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Outlet, useLocation, useSearch } from '@tanstack/react-router';
import { AuthScreen } from './components/auth/AuthScreen';
import { useSession, useSessionEvents, useKnownAccounts } from './components/auth/session';
import { AddMailboxDialog } from './components/rail/AddMailboxDialog';
import { ReconnectBanner } from './components/rail/ReconnectBanner';
import { RenameMailboxDialog } from './components/rail/AccountMenu';
import { useApplyAppearance } from './hooks/useEnvironment';
import { useAccounts } from './hooks/useData';
import { Logo } from './components/common/Logo';
import { pruneQueriesTo } from './lib/queryClient';
import { pruneLocalData } from './lib/db';
import { tBase } from './lib/motion';
import { plainToHtml } from './lib/sanitize';
import { startCompose } from './components/compose/startCompose';
import { RouteGuard } from './nav/RouteGuard';
import { useNav } from './nav/useNav';
import { getLastView, goLogin, goTarget, goHref, inboxTarget, listTarget } from './nav/nav';
import { parseMailto, safeRedirect, str } from './nav/model';
import { ALL } from './store/ui';

const MailApp = lazy(() => import('./components/layout/MailApp'));

function Splash() {
  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, pointerEvents: 'none' }}
      transition={{ ...tBase, delay: 0.15 }}
    >
      <Logo className="size-9 opacity-80" />
    </motion.div>
  );
}

/**
 * Racine : session, écran de connexion ou appli. Pas de session (ou `/login`) → connexion ; une URL profonde
 * ouverte sans session est mémorisée dans `?redirect=` et rouverte après la connexion.
 */
export function Root() {
  useApplyAppearance();
  useSessionEvents();
  const session = useSession({ boot: true });
  const mailboxes = session.data?.mailboxes;
  const ids = (mailboxes ?? []).map((m) => m.id).join(',');
  const location = useLocation();
  const search = location.search as Record<string, unknown>;
  const onLogin = location.pathname === '/login';
  const has = !!mailboxes?.length;
  const loginEmail = onLogin ? str(search.email)?.toLowerCase() : undefined;
  const emailOpen = !!loginEmail && !!mailboxes?.some((m) => m.email.toLowerCase() === loginEmail);
  const hadMailboxes = useRef(false);

  // cache restauré depuis IndexedDB : on ne garde que les boîtes encore ouvertes, et on mémorise leurs adresses
  useEffect(() => {
    if (!mailboxes || session.isFetching || session.isError) return;
    pruneQueriesTo(mailboxes.map((m) => m.id));
    if (mailboxes.length) void pruneLocalData(mailboxes.map((m) => m.id));
    const known = useKnownAccounts.getState();
    for (const m of mailboxes) known.remember(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, session.isFetching]);

  // aiguillage connexion ↔ appli
  const toApp = has && onLogin && (!loginEmail || emailOpen);
  const toLogin = !!session.data && !has && !onLogin;
  useEffect(() => {
    if (!session.data) return;
    if (toLogin) {
      // lien profond sans session : on y reviendra après la connexion (pas après une déconnexion volontaire)
      const back = !hadMailboxes.current && location.pathname !== '/' ? safeRedirect(location.href) : undefined;
      goLogin(undefined, back, { replace: true });
    } else if (toApp) {
      goHref(safeRedirect(search.redirect) ?? '/', { replace: true });
    }
    if (has) hadMailboxes.current = true;
  }, [session.data, has, toApp, toLogin, location.href, location.pathname, search.redirect]);

  const state: 'loading' | 'login' | 'app' | 'error' = session.data
    ? toApp
      ? 'loading'
      : has && !onLogin
        ? 'app'
        : 'login'
    : session.isError
      ? 'error'
      : 'loading';

  // Pas de mode="wait" : la transition ne doit jamais bloquer l'affichage
  return (
    <div className="relative h-full">
      <AnimatePresence initial={false}>
        {state === 'loading' && <Splash key="splash" />}
        {(state === 'login' || state === 'error') && (
          <AuthScreen
            key="auth"
            unreachable={state === 'error'}
            onRetry={() => session.refetch()}
            initialEmail={loginEmail}
            onCancel={has ? () => goHref('/', { replace: true }) : undefined}
          />
        )}
        {state === 'app' && (
          <motion.div key="app" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={tBase}>
            <Outlet />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Mise en page des routes de l'appli : la messagerie reste montée d'une URL à l'autre. */
export function AppLayout() {
  const nav = useNav();
  return (
    <>
      <RouteGuard />
      {/* lien vers une boîte absente : la garde redirige vers /login sans afficher une vue erronée */}
      {!nav.missingEmail && (
        <Suspense fallback={<Splash />}>
          <MailApp />
        </Suspense>
      )}
      <Outlet />
      <ReconnectBanner />
      <AddMailboxDialog />
      <RenameMailboxDialog />
    </>
  );
}

/** `/` → réception de la dernière boîte ouverte (ou de la première de la session). */
export function IndexRedirect() {
  const { data: accounts } = useAccounts();
  useEffect(() => {
    if (!accounts?.length) return;
    goTarget(listTarget(getLastView(accounts), {}, accounts), { replace: true });
  }, [accounts]);
  return null;
}

function splitAddrs(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * `/compose?to=&cc=&bcc=&subject=&body=` ou `/compose?mailto=<uri>` (gestionnaire mailto:) : ouvre la rédaction
 * par-dessus la réception de la boîte courante, puis remplace l'URL par celle de la réception.
 */
export function ComposeRoute() {
  const search = useSearch({ from: '/_app/compose' });
  const { data: accounts } = useAccounts();
  const done = useRef(false);
  useEffect(() => {
    if (!accounts?.length || done.current) return;
    done.current = true;
    const m = search.mailto ? parseMailto(search.mailto) : null;
    const to = [...(m?.to ?? []), ...splitAddrs(search.to)];
    const cc = [...(m?.cc ?? []), ...splitAddrs(search.cc)];
    const bcc = [...(m?.bcc ?? []), ...splitAddrs(search.bcc)];
    const subject = search.subject ?? m?.subject ?? '';
    const body = search.body ?? m?.body ?? '';
    const view = getLastView(accounts);
    const accountId = view.accountId === ALL ? accounts[0]!.id : view.accountId;
    const addr = (email: string) => ({ name: null, email });
    startCompose({ accountId, to: to.map(addr), cc: cc.map(addr), bcc: bcc.map(addr), subject, html: body ? plainToHtml(body) : '' });
    goTarget(inboxTarget(view.accountId) ?? inboxTarget(accountId), { replace: true });
  }, [accounts, search]);
  return null;
}
