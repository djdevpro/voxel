import { useEffect, useRef, useState } from 'react';
import type { StateChange } from '@voxel/jmap';
import { jmap } from '@/lib/jmap';
import { getState, setState } from '@/lib/db';
import { syncContacts } from '@/lib/contacts';
import { getMailboxData, roleId } from '@/lib/mail';
import { invalidateAccount } from '@/lib/actions';
import { pullSyncedSettings } from '@/lib/syncedSettings';
import { renewPushSubscriptions } from '@/lib/push';
import { isOffline } from '@/lib/outbox';
import { displayName } from '@/lib/format';
import { useSettings } from '@/store/settings';
import type { Account } from '@/lib/api';
import i18n from '@/i18n';
import { goTarget, threadTarget } from '@/nav/nav';

const POLL_MS = 60_000;

/** Applique `Email/changes` depuis l'état mémorisé ; notifie les nouveaux messages en Réception. */
async function pullChanges(account: Account, notify: boolean) {
  const c = jmap(account.id);
  const data = await getMailboxData(account.id);
  const aid = data.jmapAccountId;
  const since = await getState(account.id, 'Email');
  if (!since) {
    const r = await c.call('Email/get', { accountId: aid, ids: [], properties: ['id'] });
    await setState(account.id, 'Email', r.state);
    return;
  }
  let changes;
  try {
    changes = await c.allChanges('Email', aid, since);
  } catch (e) {
    // cannotCalculateChanges : on repart d'un état neuf
    const r = await c.call('Email/get', { accountId: aid, ids: [], properties: ['id'] });
    await setState(account.id, 'Email', r.state);
    invalidateAccount(account.id, 0);
    void e;
    return;
  }
  await setState(account.id, 'Email', changes.newState);
  if (!changes.created.length && !changes.updated.length && !changes.destroyed.length) return;
  invalidateAccount(account.id, 150);

  if (notify && changes.created.length && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const inbox = roleId(data, 'inbox');
    const r = await c.call('Email/get', {
      accountId: aid,
      ids: changes.created.slice(0, 10),
      properties: ['id', 'threadId', 'from', 'subject', 'preview', 'mailboxIds', 'keywords'],
    });
    for (const e of r.list) {
      if (!inbox || !e.mailboxIds[inbox] || e.keywords.$seen) continue;
      try {
        const n = new Notification(displayName(e.from?.[0]) || i18n.t('accounts:notification.newMessage'), {
          body: `${e.subject || i18n.t('accounts:notification.noSubject')}\n${e.preview ?? ''}`.slice(0, 180),
          tag: `${account.id}:${e.id}`,
          icon: '/icon-192.png',
        });
        // clic sur la notification : ouvre la conversation (lien profond par le routeur)
        n.onclick = () => {
          window.focus();
          goTarget(threadTarget({ accountId: account.id, mailbox: { kind: 'role', role: 'inbox' } }, { accountId: account.id, threadId: e.threadId, emailId: e.id }));
          n.close();
        };
      } catch {
        /* ignore */
      }
    }
  }
}

const CONTACTS_POLL_MS = 5 * 60_000;

/** Agenda : module chargé à la demande (développement des récurrences par ical.js). */
function pullCalendarOf(account: Account) {
  if (!account.capabilities.calendars) return;
  void import('@/lib/calendar').then((m) => m.syncCalendar(account.id)).catch(() => undefined);
}

/**
 * Push : un flux SSE lu par fetch par compte (directement sur le serveur JMAP), puis `*\/changes` à chaque
 * StateChange. Repli sur un sondage toutes les 60 s si le flux tombe.
 */
export function useSync(accounts: Account[] | undefined) {
  const notifications = useSettings((s) => s.notifications);
  const notifRef = useRef(notifications);
  notifRef.current = notifications;
  const ids = (accounts ?? []).map((a) => a.id).join(',');
  // page restaurée depuis le cache Retour/Avant (bfcache) : on rouvre les flux fermés à pagehide
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && setEpoch((n) => n + 1);
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  useEffect(() => {
    if (!accounts?.length) return;
    const closers: Array<() => void> = [];
    const timers: Array<ReturnType<typeof setInterval>> = [];
    let disposed = false;

    for (const account of accounts) {
      const lastPush = { t: 0 };
      const busy = { v: false };
      // contacts : au démarrage, à chaque changement poussé, sinon toutes les 5 min
      const contactsAt = { t: 0 };
      const pullContacts = () => {
        if (!account.capabilities.contacts) return;
        contactsAt.t = Date.now();
        void syncContacts(account.id);
      };
      const run = async () => {
        if (busy.v || isOffline()) return;
        busy.v = true;
        try {
          await pullChanges(account, notifRef.current);
        } catch {
          /* réessayé au prochain événement */
        } finally {
          busy.v = false;
        }
      };
      let debounce: ReturnType<typeof setTimeout> | undefined;
      let syncedDebounce: ReturnType<typeof setTimeout> | undefined;
      const onChange = (sc: StateChange) => {
        lastPush.t = Date.now();
        const changed = Object.values(sc.changed)[0] ?? {};
        if ('ContactCard' in changed || 'AddressBook' in changed) pullContacts();
        if ('CalendarEvent' in changed || 'Calendar' in changed) pullCalendarOf(account);
        if ('Mailbox' in changed && !('Email' in changed)) invalidateAccount(account.id, 200);
        // le dossier caché des réglages a pu changer (autre appareil) : relecture regroupée
        if ('Mailbox' in changed) {
          clearTimeout(syncedDebounce);
          syncedDebounce = setTimeout(() => void pullSyncedSettings(account.id), 1500);
        }
        clearTimeout(debounce);
        debounce = setTimeout(run, 250);
      };
      void run();
      pullContacts();
      pullCalendarOf(account);
      void pullSyncedSettings(account.id);
      // notifications push : prolongation ou recréation de l'abonnement de la boîte
      if (account.capabilities?.webpush) void renewPushSubscriptions([account.id]);
      jmap(account.id)
        .subscribe({ types: '*', ping: 30, onStateChange: onChange, onOpen: () => (lastPush.t = Date.now()) })
        .then((close) => {
          if (disposed) close();
          else closers.push(close);
        })
        .catch(() => {
          /* pas d'EventSource : le sondage prend le relais */
        });
      // Sondage de secours : seulement si le push est silencieux depuis 60 s
      timers.push(
        setInterval(() => {
          if (Date.now() - lastPush.t > POLL_MS) void run();
          if (Date.now() - contactsAt.t > CONTACTS_POLL_MS) {
            pullContacts();
            pullCalendarOf(account);
          }
        }, POLL_MS),
      );
      closers.push(() => clearTimeout(debounce));
      closers.push(() => clearTimeout(syncedDebounce));
    }
    // quitter la page (navigation, cache Retour/Avant) ferme les flux : ils ne doivent pas garder
    // les connexions HTTP/1.1 ouvertes (6 par hôte) et bloquer la page suivante
    let closed = false;
    const closeAll = () => {
      if (closed) return;
      closed = true;
      disposed = true;
      closers.forEach((c) => c());
      timers.forEach((t) => clearInterval(t));
    };
    window.addEventListener('pagehide', closeAll);
    return () => {
      window.removeEventListener('pagehide', closeAll);
      closeAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, epoch]);
}
