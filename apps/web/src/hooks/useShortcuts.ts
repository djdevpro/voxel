import { useEffect, useRef } from 'react';
import { useThreads, useAccounts } from './useData';
import { useThreadActions } from './useThreadActions';
import { ALL, threadKey, useUi, type SystemRole } from '@/store/ui';
import { closeThread, getNav, goCalendar, goContacts, goView, openThread } from '@/nav/nav';
import { startCompose } from '@/components/compose/startCompose';
import { useAiChat } from '@/store/aiChat';
import { modelRefFor, useAiSettings } from '@/lib/ai/store';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Liste des raccourcis pour l'aide. `group` et `label` sont des clés i18n de l'espace de noms `shortcuts`
 * (`groups.<group>`, `items.<label>`) ; les touches nommées (`enter`, `esc`, `shift`, `ctrl`) sont traduites via `keys.<nom>`.
 */
export const SHORTCUTS: Array<{ keys: string[]; label: string; group: string }> = [
  { group: 'navigation', keys: ['j'], label: 'next' },
  { group: 'navigation', keys: ['k'], label: 'previous' },
  { group: 'navigation', keys: ['o'], label: 'open' },
  { group: 'navigation', keys: ['enter'], label: 'open' },
  { group: 'navigation', keys: ['u'], label: 'backToList' },
  { group: 'navigation', keys: ['g', 'i'], label: 'goInbox' },
  { group: 'navigation', keys: ['g', 's'], label: 'goFlagged' },
  { group: 'navigation', keys: ['g', 'd'], label: 'goDrafts' },
  { group: 'navigation', keys: ['g', 't'], label: 'goSent' },
  { group: 'navigation', keys: ['g', 'c'], label: 'goContacts' },
  { group: 'navigation', keys: ['g', 'a'], label: 'goCalendar' },
  { group: 'navigation', keys: ['ctrl', '1…9'], label: 'switchMailbox' },
  { group: 'navigation', keys: ['ctrl', '0'], label: 'allMailboxes' },
  { group: 'actions', keys: ['c'], label: 'compose' },
  { group: 'actions', keys: ['e'], label: 'archive' },
  { group: 'actions', keys: ['#'], label: 'delete' },
  { group: 'actions', keys: ['!'], label: 'spam' },
  { group: 'actions', keys: ['s'], label: 'flag' },
  { group: 'actions', keys: ['shift', 'i'], label: 'markRead' },
  { group: 'actions', keys: ['shift', 'u'], label: 'markUnread' },
  { group: 'actions', keys: ['x'], label: 'select' },
  { group: 'actions', keys: ['r'], label: 'reply' },
  { group: 'actions', keys: ['a'], label: 'replyAll' },
  { group: 'actions', keys: ['f'], label: 'forward' },
  { group: 'actions', keys: ['ctrl', 'enter'], label: 'send' },
  { group: 'application', keys: ['/'], label: 'search' },
  { group: 'application', keys: ['ctrl', 'K'], label: 'palette' },
  { group: 'application', keys: ['?'], label: 'help' },
  { group: 'application', keys: ['esc'], label: 'escape' },
  { group: 'calendar', keys: ['t'], label: 'calToday' },
  { group: 'calendar', keys: ['j'], label: 'calNext' },
  { group: 'calendar', keys: ['k'], label: 'calPrevious' },
  { group: 'calendar', keys: ['m'], label: 'calMonth' },
  { group: 'calendar', keys: ['w'], label: 'calWeek' },
  { group: 'calendar', keys: ['d'], label: 'calDay' },
  { group: 'calendar', keys: ['a'], label: 'calAgenda' },
  { group: 'calendar', keys: ['c'], label: 'calNew' },
];

/** Raccourcis clavier façon Gmail. */
export function useShortcuts() {
  const { items } = useThreads();
  const { data: accounts } = useAccounts();
  const actions = useThreadActions();
  const pendingG = useRef<number>(0);
  const ref = useRef({ items, accounts, actions });
  ref.current = { items, accounts, actions };

  useEffect(() => {
    const goRole = (role: SystemRole) => {
      goView({ accountId: getNav().view.accountId, mailbox: { kind: 'role', role } });
    };
    const onKey = (e: KeyboardEvent) => {
      const { items, accounts, actions } = ref.current;
      const ui = useUi.getState();
      const nav = getNav();
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.setPalette(!ui.paletteOpen);
        return;
      }
      if (mod && /^[0-9]$/.test(e.key) && !e.altKey) {
        e.preventDefault();
        const n = Number(e.key);
        const keep = nav.view.mailbox.kind === 'role' ? nav.view.mailbox : ({ kind: 'role', role: 'inbox' } as const);
        if (n === 0) {
          if ((accounts?.length ?? 0) > 1) goView({ accountId: ALL, mailbox: keep });
        } else {
          const a = accounts?.[n - 1];
          if (a) goView({ accountId: a.id, mailbox: keep });
        }
        return;
      }
      if (isTyping(e) || mod || e.altKey) return;
      if (ui.paletteOpen || nav.settings || document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]')) return;

      const key = e.key;
      const now = Date.now();
      if (pendingG.current && now - pendingG.current < 1200) {
        pendingG.current = 0;
        // g c : contacts, seulement si une boîte a la capacité
        if (key.toLowerCase() === 'c') {
          if (accounts?.some((a) => a.capabilities.contacts)) {
            e.preventDefault();
            goContacts();
          }
          return;
        }
        // g a : agenda si une boîte l'annonce, sinon dossier Archives (comportement v3)
        if (key.toLowerCase() === 'a' && accounts?.some((a) => a.capabilities.calendars)) {
          e.preventDefault();
          goCalendar();
          return;
        }
        const map: Record<string, SystemRole> = { i: 'inbox', s: 'flagged', d: 'drafts', t: 'sent', a: 'archive' };
        const role = map[key.toLowerCase()];
        if (role) {
          e.preventDefault();
          goRole(role);
        }
        return;
      }

      // écran Contacts : seuls les raccourcis généraux (g …, c, /, ?) ; le reste est géré par l'écran
      // écran Agenda : ses propres raccourcis (CalendarView) ; ici seulement g …, ? et /
      if (nav.route === 'calendar') {
        if (key === 'g') pendingG.current = now;
        else if (key === '?') {
          e.preventDefault();
          ui.setHelp(true);
        }
        return;
      }

      // écran Résumés : la liste est cachée, ses raccourcis n'agissent pas
      if (nav.route === 'summaries') {
        if (key === 'g') pendingG.current = now;
        else if (key === 'c') {
          e.preventDefault();
          startCompose();
        } else if (key === '?') {
          e.preventDefault();
          ui.setHelp(true);
        }
        return;
      }

      if (nav.route === 'contacts') {
        if (key === 'g') pendingG.current = now;
        else if (key === 'c') {
          e.preventDefault();
          startCompose();
        } else if (key === '?') {
          e.preventDefault();
          ui.setHelp(true);
        } else if (key === '/') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('voxel:contacts-search'));
        }
        return;
      }

      const open = nav.thread;
      // discussion de l'assistant ouverte (et IA prête, comme MessageList) : la liste est cachée.
      // Navigation et sélection de la liste bloquées ; les actions sur le fil ouvert dans le lecteur restent.
      const chatOpen = (nav.route === 'list' || nav.route === 'thread') && useAiChat.getState().open && useAiSettings.getState().enabled && !!modelRefFor('chat');
      if (chatOpen) {
        const general = key === 'g' || key === 'c' || key === '/' || key === '?';
        const listOnly = ['j', 'k', 'ArrowDown', 'ArrowUp', 'o', 'Enter', 'x'].includes(key);
        if (!general && (listOnly || !open)) return;
        if (key === 'Escape') {
          if (open) closeThread();
          return;
        }
      }
      const currentKey = open ? threadKey(open.accountId, open.threadId) : ui.focusedKey;
      const idx = currentKey ? items.findIndex((i) => i.key === currentKey) : -1;
      const move = (delta: number) => {
        const next = items[Math.min(items.length - 1, Math.max(0, idx < 0 ? 0 : idx + delta))];
        if (!next) return;
        // j/k dans le lecteur : replace (l'historique ne se remplit pas)
        if (open) openThread({ accountId: next.accountId, threadId: next.threadId }, { replace: true });
        else ui.setFocused(next.key);
      };

      switch (key) {
        case 'g':
          pendingG.current = now;
          return;
        case 'c':
          e.preventDefault();
          startCompose();
          return;
        case 'j':
        case 'ArrowDown':
          if (key === 'ArrowDown' && open) return;
          e.preventDefault();
          move(1);
          return;
        case 'k':
        case 'ArrowUp':
          if (key === 'ArrowUp' && open) return;
          e.preventDefault();
          move(-1);
          return;
        case 'o':
        case 'Enter': {
          const t = items.find((i) => i.key === ui.focusedKey);
          if (t && !open) {
            e.preventDefault();
            openThread({ accountId: t.accountId, threadId: t.threadId });
          }
          return;
        }
        case 'u':
          if (open) {
            e.preventDefault();
            closeThread();
          }
          return;
        case 'Escape':
          if (ui.selected.size) ui.clearSelection();
          else if (open) closeThread();
          return;
        case 'e':
          e.preventDefault();
          actions.archive();
          return;
        case '#':
        case 'Delete':
          e.preventDefault();
          void actions.trash();
          return;
        case '!':
          e.preventDefault();
          actions.spam();
          return;
        case 's':
          e.preventDefault();
          actions.toggleFlag();
          return;
        case 'I':
          e.preventDefault();
          actions.markRead(true);
          return;
        case 'U':
          e.preventDefault();
          actions.markRead(false);
          return;
        case 'x': {
          const k = ui.focusedKey ?? currentKey;
          if (!k) return;
          e.preventDefault();
          const sel = new Set(ui.selected);
          if (sel.has(k)) sel.delete(k);
          else sel.add(k);
          ui.setSelected(sel, k);
          return;
        }
        case 'r':
        case 'a':
        case 'f':
          if (open) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('voxel:reply', { detail: key === 'r' ? 'reply' : key === 'a' ? 'replyAll' : 'forward' }));
          }
          return;
        case '/':
          e.preventDefault();
          ui.focusSearch();
          return;
        case '?':
          e.preventDefault();
          ui.setHelp(true);
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
