import { useCallback } from 'react';
import { useThreads, useAllMailboxData } from './useData';
import { useUi, threadKey } from '@/store/ui';
import { closeThread, getNav, openThread } from '@/nav/nav';
import {
  archiveThreads,
  destroyThreads,
  moveToMailbox,
  setFlagged,
  setSeen,
  spamThreads,
  trashThreads,
} from '@/lib/actions';
import { roleId, type ThreadItem } from '@/lib/mail';
import { confirmDialog } from '@/store/confirm';
import i18n from '@/i18n';

/** Actions sur les fils ciblés : sélection > fil ouvert > ligne focalisée (ou clés explicites). */
export function useThreadActions() {
  const { items } = useThreads();
  const { map } = useAllMailboxData();

  const resolve = useCallback(
    (keys?: string[]): ThreadItem[] => {
      const ui = useUi.getState();
      const open = getNav().thread;
      let ks: string[];
      if (keys) ks = keys;
      else if (ui.selected.size) ks = [...ui.selected];
      else if (open) ks = [threadKey(open.accountId, open.threadId)];
      else if (ui.focusedKey) ks = [ui.focusedKey];
      else ks = [];
      const set = new Set(ks);
      return items.filter((i) => set.has(i.key));
    },
    [items],
  );

  /** Ouvre le fil suivant si le fil ouvert disparaît de la liste. */
  const advance = useCallback(
    (targets: ThreadItem[]) => {
      const ui = useUi.getState();
      const open = getNav().thread;
      const keys = new Set(targets.map((t) => t.key));
      const openKey = open ? threadKey(open.accountId, open.threadId) : null;
      const focusKey = openKey ?? ui.focusedKey;
      if (!focusKey || !keys.has(focusKey)) return;
      const idx = items.findIndex((i) => i.key === focusKey);
      let next: ThreadItem | undefined;
      for (let j = idx + 1; j < items.length; j++) if (!keys.has(items[j]!.key)) { next = items[j]; break; }
      if (!next) for (let j = idx - 1; j >= 0; j--) if (!keys.has(items[j]!.key)) { next = items[j]; break; }
      // le fil ouvert disparaît : on passe au suivant (replace) ou on revient à la liste
      if (openKey && next && !window.matchMedia('(max-width: 767px)').matches) openThread({ accountId: next.accountId, threadId: next.threadId }, { replace: true });
      else if (openKey) closeThread();
      ui.setFocused(next?.key ?? null);
    },
    [items],
  );

  const inBin = useCallback(
    (t: ThreadItem) => {
      const d = map[t.accountId];
      return !!t.contextMailboxId && (t.contextMailboxId === roleId(d, 'trash') || t.contextMailboxId === roleId(d, 'junk'));
    },
    [map],
  );
  const inJunk = useCallback((t: ThreadItem) => !!t.contextMailboxId && t.contextMailboxId === roleId(map[t.accountId], 'junk'), [map]);

  const run = useCallback(
    (fn: (t: ThreadItem[]) => unknown, keys?: string[], opts: { leaves?: boolean } = { leaves: true }) => {
      const t = resolve(keys);
      if (!t.length) return;
      if (opts.leaves) advance(t);
      void fn(t);
    },
    [resolve, advance],
  );

  return {
    resolve,
    archive: (keys?: string[]) => run(archiveThreads, keys),
    trash: async (keys?: string[]) => {
      const t = resolve(keys);
      if (!t.length) return;
      if (t.every(inBin)) {
        const ok = await confirmDialog({
          title: i18n.t('mail:confirm.destroyTitle', { count: t.length }),
          description: i18n.t('mail:confirm.irreversible'),
          confirmLabel: i18n.t('common:actions.delete'),
          destructive: true,
        });
        if (!ok) return;
        advance(t);
        void destroyThreads(t);
      } else {
        advance(t);
        void trashThreads(t);
      }
    },
    spam: (keys?: string[]) => {
      const t = resolve(keys);
      if (!t.length) return;
      advance(t);
      void spamThreads(t, t.every(inJunk));
    },
    move: (mailboxId: string, name: string, keys?: string[]) => run((t) => moveToMailbox(t, mailboxId, name), keys),
    markRead: (seen: boolean, keys?: string[]) => run((t) => setSeen(t, seen), keys, { leaves: false }),
    toggleRead: (keys?: string[]) => {
      const t = resolve(keys);
      if (!t.length) return;
      void setSeen(t, t.some((x) => x.unread));
    },
    toggleFlag: (keys?: string[]) => {
      const t = resolve(keys);
      if (!t.length) return;
      void setFlagged(t, !t.every((x) => x.flagged));
    },
    isJunkView: (t: ThreadItem) => inJunk(t),
    isBinView: (t: ThreadItem) => inBin(t),
  };
}
