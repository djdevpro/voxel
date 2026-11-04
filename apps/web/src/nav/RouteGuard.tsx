/**
 * Effets liés à l'URL : lien vers une boîte absente (→ /login), dossier introuvable (→ réception),
 * mémoire de la dernière boîte, remise à zéro de l'état éphémère de la liste, `document.title`.
 */
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useAccounts, useAllMailboxData } from '@/hooks/useData';
import { mailboxesQuery, mailboxLabel, roleId, roleLabel, threadQuery } from '@/lib/mail';
import { queryClient } from '@/lib/queryClient';
import { formatNumber } from '@/lib/format';
import { ALL, threadKey, useUi, viewKey } from '@/store/ui';
import { useNav } from './useNav';
import { currentHref, emailOf, goHref, goLogin, goView, rememberLastMailbox } from './nav';
import { safeRedirect } from './model';

export function RouteGuard() {
  const nav = useNav();
  const { data: accounts } = useAccounts();
  const { map } = useAllMailboxData();
  const { t } = useTranslation();
  const seen = useRef(new Set<string>());

  useEffect(() => {
    for (const a of accounts ?? []) seen.current.add(a.email.toLowerCase());
  }, [accounts]);

  // Lien profond vers une boîte absente de la session → connexion puis retour à l'URL demandée.
  // Une boîte qu'on vient de quitter (déconnexion) renvoie simplement à l'accueil.
  useEffect(() => {
    if (!accounts?.length || !nav.missingEmail) return;
    if (seen.current.has(nav.missingEmail.toLowerCase())) goHref('/', { replace: true });
    else goLogin(nav.missingEmail, safeRedirect(currentHref()), { replace: true });
  }, [nav.missingEmail, accounts]);

  // Dossier inconnu → message clair et retour à la réception de la boîte
  const folderId = nav.view.mailbox.kind === 'id' ? nav.view.mailbox.id : null;
  const accountId = nav.view.accountId;
  useEffect(() => {
    if (!nav.scope || nav.missingEmail || !accounts?.length) return;
    let cancelled = false;
    const bounce = () => {
      if (cancelled) return;
      toast(t('routing.folderNotFound'));
      goView({ accountId, mailbox: { kind: 'role', role: 'inbox' } }, { replace: true });
    };
    if (!nav.folderValid) {
      bounce();
      return;
    }
    if (!folderId || accountId === ALL) return;
    const cached = queryClient.getQueryData<{ mailboxes: { id: string }[] }>(mailboxesQuery(accountId).queryKey);
    if (cached?.mailboxes.some((m) => m.id === folderId)) return;
    // le cache peut être ancien (dossier créé ailleurs) : on vérifie auprès du serveur avant de conclure
    queryClient
      .fetchQuery({ ...mailboxesQuery(accountId), staleTime: 0 })
      .then((d) => {
        if (!d.mailboxes.some((m) => m.id === folderId)) bounce();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.scope, nav.folderValid, nav.missingEmail, folderId, accountId, accounts?.length]);

  // Boîte courante mémorisée pour `/` et `/compose`
  useEffect(() => {
    if (!nav.scope || nav.missingEmail) return;
    if (accountId === ALL) rememberLastMailbox(ALL);
    else {
      const email = emailOf(accountId, accounts ?? []);
      if (email) rememberLastMailbox(email);
    }
  }, [nav.scope, nav.missingEmail, accountId, accounts]);

  // Autre liste (dossier, recherche, filtre) → sélection et focus remis à zéro
  const listKey = `${viewKey(nav.view)}|${nav.q}|${nav.filter ?? ''}`;
  const firstList = useRef(true);
  useEffect(() => {
    if (firstList.current) {
      firstList.current = false;
      return;
    }
    useUi.getState().resetListState();
  }, [listKey]);

  // Conversation refermée → la ligne reste focalisée (j/k reprennent depuis elle)
  const openKey = nav.thread ? threadKey(nav.thread.accountId, nav.thread.threadId) : null;
  useEffect(() => {
    if (openKey) useUi.getState().setFocused(openKey);
  }, [openKey]);

  useDocumentTitle(nav, map);
  return null;
}

/** `(3) Réception — alice@example.com · Voxel`, ou l'objet de la conversation ouverte. */
function useDocumentTitle(nav: ReturnType<typeof useNav>, map: ReturnType<typeof useAllMailboxData>['map']) {
  const { t, i18n } = useTranslation();
  const { data: accounts } = useAccounts();
  const thread = nav.thread;
  const { data: threadData } = useQuery({ ...threadQuery(thread?.accountId ?? '', thread?.threadId ?? ''), enabled: false });

  const app = 'Voxel';
  let title = app;
  if (thread && threadData?.emails.length) {
    const emails = threadData.emails;
    const last = [...emails].reverse().find((e) => !e.keywords.$draft) ?? emails[emails.length - 1];
    title = t('title.thread', { subject: last?.subject || t('mail:noSubject'), app });
  } else if (nav.scope) {
    const ids = nav.view.accountId === ALL ? (accounts ?? []).map((a) => a.id) : [nav.view.accountId];
    const sel = nav.view.mailbox;
    let folder: string;
    if (nav.search.chips.length || nav.search.text) folder = t('mail:list.results');
    else if (sel.kind === 'role') folder = roleLabel(sel.role);
    else {
      const m = map[nav.view.accountId]?.mailboxes.find((x) => x.id === sel.id);
      folder = m ? mailboxLabel(m) : t('mail:list.folder');
    }
    const unread = ids.reduce((s, id) => {
      const d = map[id];
      const mid = sel.kind === 'role' ? roleId(d, sel.role) : sel.id;
      const m = d?.mailboxes.find((x) => x.id === mid);
      return s + (m && !(sel.kind === 'role' && (sel.role === 'drafts' || sel.role === 'sent' || sel.role === 'trash')) ? m.unreadThreads : 0);
    }, 0);
    const mailbox = nav.view.accountId === ALL ? t('mail:list.allMailboxes') : (emailOf(nav.view.accountId, accounts ?? []) ?? '');
    title = unread > 0 ? t('title.folderUnread', { n: formatNumber(unread), folder, mailbox, app }) : t('title.folder', { folder, mailbox, app });
  }

  useEffect(() => {
    document.title = title;
  }, [title, i18n.resolvedLanguage]);
}
