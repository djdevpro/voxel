/**
 * Pastille de l'icône de l'appli : nombre de conversations non lues en Réception, toutes boîtes confondues
 * (le même que celui du rail). Chaque nouveau message l'augmente donc de 1.
 * - Web, appli installée : Badging API (`navigator.setAppBadge`). Le nombre est aussi rangé dans IndexedDB
 *   (`voxel-push`, clé `badge`) : appli fermée, le service worker l'augmente de 1 à chaque notification push.
 * - Bureau : commande `set_badge` (pastille du bouton de la barre des tâches et de l'icône de la zone de
 *   notification, qui reste là quand la fenêtre est fermée).
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccounts, useAllMailboxData } from '@/hooks/useData';
import { roleId } from './mail';
import { desktopSetBadge, isDesktop } from './platform';
import { writeBadgeCount } from './push';

type BadgeNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

/** Pose la pastille ; `tooltip` : texte de l'icône de la zone de notification (bureau). */
export async function setUnreadBadge(count: number, tooltip: string): Promise<void> {
  const n = Math.max(0, Math.floor(count));
  if (isDesktop) {
    await desktopSetBadge(n, tooltip);
    return;
  }
  const nav = navigator as BadgeNavigator;
  if (n > 0) await nav.setAppBadge?.(n);
  else await nav.clearAppBadge?.();
  await writeBadgeCount(n);
}

/** Tient la pastille à jour tant que l'appli est ouverte (monté avec la synchronisation). */
export function useUnreadBadge(): void {
  const { t } = useTranslation('accounts');
  const { data: accounts } = useAccounts();
  const { map } = useAllMailboxData();
  const total = (accounts ?? []).reduce((sum, a) => {
    const d = map[a.id];
    return sum + (d?.mailboxes.find((m) => m.id === roleId(d, 'inbox'))?.unreadThreads ?? 0);
  }, 0);
  const tooltip = total > 0 ? `Voxel — ${t('badge.unread', { count: total })}` : 'Voxel';
  useEffect(() => {
    void setUnreadBadge(total, tooltip).catch(() => undefined);
  }, [total, tooltip]);
}
