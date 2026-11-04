/** Ouverture d'une conversation citée par l'IA, quelle que soit sa boîte. */
import { getNav, goTarget, openThread, threadTarget } from '@/nav/nav';
import { ALL, type OpenThread } from '@/store/ui';

/**
 * Vue unifiée ou même boîte : ouverture dans la vue courante (`openThread`).
 * Autre boîte : la conversation s'ouvre dans la réception de sa propre boîte.
 */
export function openHit(hit: OpenThread): void {
  const { view } = getNav();
  if (view.accountId === ALL || view.accountId === hit.accountId) {
    openThread(hit);
    return;
  }
  goTarget(threadTarget({ accountId: hit.accountId, mailbox: { kind: 'role', role: 'inbox' } }, hit));
}
