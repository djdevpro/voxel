import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { toast } from 'sonner';
import { replayOutbox } from '@/lib/outbox';
import { invalidateAccount } from '@/lib/actions';
import { queryClient } from '@/lib/queryClient';
import { useSettings } from '@/store/settings';
import i18n from '@/i18n';
import { refreshAppearance } from '@/lib/accent';
import { crossFade } from '@/lib/themes';

export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(q).matches,
    () => false,
  );
}

export const useIsMobile = () => useMediaQuery('(max-width: 767px)');
export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  const unsub = onlineManager.subscribe(cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
    unsub();
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine && onlineManager.isOnline(), () => true);
}

/** Rejoue la file au retour en ligne et affiche le toast récapitulatif. */
export function useReconnect() {
  const online = useOnline();
  const [wasOffline, setWasOffline] = useState(false);
  useEffect(() => {
    if (!online) {
      setWasOffline(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const r = await replayOutbox();
      if (cancelled) return;
      r.accounts.forEach((a) => invalidateAccount(a, 0));
      if (wasOffline) {
        void queryClient.invalidateQueries();
        const parts = [i18n.t('common:offline.backOnline')];
        if (r.ok) parts.push(i18n.t('common:offline.synced', { count: r.ok }));
        toast.success(parts.join(' · '), r.failed ? { description: i18n.t('common:offline.failed', { count: r.failed }) } : undefined);
        setWasOffline(false);
      } else if (r.ok) {
        toast.success(i18n.t('common:offline.synced', { count: r.ok }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);
  return online;
}

/**
 * Applique thème clair/sombre/système et densité sur <html>. Le passage clair ↔ sombre se fait en fondu
 * croisé (comme un changement de collection) ; l'accent lisible et <meta name="theme-color"> sont recalculés
 * à partir des tokens réels (src/lib/accent.ts).
 */
export function useApplyAppearance() {
  const theme = useSettings((s) => s.theme);
  const density = useSettings((s) => s.density);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const first = useRef(true);
  useEffect(() => {
    const dark = theme === 'dark' || (theme === 'system' && systemDark);
    const root = document.documentElement;
    root.dataset.density = density;
    const commit = () => {
      root.classList.toggle('dark', dark);
      refreshAppearance();
    };
    const changed = root.classList.contains('dark') !== dark;
    if (first.current || !changed) commit();
    else crossFade(commit);
    first.current = false;
  }, [theme, density, systemDark]);
}

export function useIsDark(): boolean {
  const theme = useSettings((s) => s.theme);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  return theme === 'dark' || (theme === 'system' && systemDark);
}
