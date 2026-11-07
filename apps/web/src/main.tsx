import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { registerSW } from 'virtual:pwa-register';
import { MotionConfig } from 'motion/react';
import '@fontsource-variable/inter';
import './styles/globals.css';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { queryClient, dexiePersister, flushPersistedCache } from './lib/queryClient';
import { TooltipProvider } from './components/ui/tooltip';
import { AppToaster } from './components/common/AppToaster';
import i18n, { i18nReady } from './i18n';
import { applyThemeId, getThemeId } from './lib/themes';
import { loadConfig } from './lib/config';
import { unlockAccounts } from './lib/accounts';
import { desktopInfo, desktopTrayLabels, installDesktopNotifications, isDesktop } from './lib/platform';
import { flushPendingSends } from './lib/sendQueue';
import { useSettings } from './store/settings';
import { scheduleUpdateChecks } from './lib/updates';
import { Direction } from 'radix-ui';
import { useDirection } from './hooks/useDirection';
import type { ReactNode } from 'react';

/** Sens d'écriture fourni à tous les composants Radix (écran de connexion, dialogues hors messagerie, toasts). */
function DirectionRoot({ children }: { children: ReactNode }) {
  return <Direction.Provider dir={useDirection()}>{children}</Direction.Provider>;
}

if (import.meta.env.PROD && !isDesktop) registerSW({ immediate: true });

if (isDesktop) {
  installDesktopNotifications();
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    // quitter : envoi immédiat des messages en attente d'annulation et cache enregistré, sans confirmation
    const quit = async () => {
      flushPersistedCache();
      await flushPendingSends();
      await getCurrentWindow().destroy();
    };
    // fermer la fenêtre : Voxel reste dans la zone de notification (synchronisation, notifications, pastille),
    // sauf si l'arrière-plan est désactivé dans les réglages ; « Quitter Voxel » de l'icône quitte vraiment
    void getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      if (!useSettings.getState().background) return quit();
      flushPersistedCache();
      await getCurrentWindow().hide();
      if (!localStorage.getItem('voxel.backgroundNotice')) {
        localStorage.setItem('voxel.backgroundNotice', '1');
        new Notification('Voxel', { body: i18n.t('accounts:tray.backgroundNotice') });
      }
    });
    void import('@tauri-apps/api/event').then(({ listen }) => listen('voxel:quit', () => void quit()));
  });
  // menu de l'icône de la zone de notification, dans la langue de l'interface
  const trayLabels = () => void desktopTrayLabels(i18n.t('accounts:tray.open'), i18n.t('accounts:tray.quit')).catch(() => undefined);
  void i18nReady.then(trayLabels);
  i18n.on('languageChanged', trayLabels);
  // mises à jour signées depuis les releases GitHub (appli publiée seulement : le cœur ignore les binaires de développement)
  void i18nReady.then(scheduleUpdateChecks);
  // auto-test : seulement dans un binaire de débogage lancé pour lui (module à part, jamais chargé sinon)
  void desktopInfo().then((i) => {
    if (i.selftest) void import('./desktop/selftest').then((m) => m.startSelftest());
  });
}

applyThemeId(getThemeId());
// config.json et comptes de l'appareil (secrets déchiffrés en mémoire) avant le premier rendu
await Promise.all([i18nReady, loadConfig(), unlockAccounts()]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: dexiePersister,
        maxAge: 1000 * 60 * 60 * 24 * 7,
        buster: 'voxel-3',
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => q.state.status === 'success',
        },
      }}
      // Le cache restauré s'affiche tout de suite, puis on le revalide : l'instantané persisté peut
      // dater d'avant la dernière modification (écriture différée), alors que l'état de synchro JMAP,
      // lui, a déjà avancé — sans cela, liste et dossiers restaient périmés après un rechargement.
      onSuccess={() => void queryClient.invalidateQueries()}
    >
      {/* prefers-reduced-motion : désactive aussi les animations JS (motion) */}
      <MotionConfig reducedMotion="user">
        <DirectionRoot>
          <TooltipProvider delayDuration={500} skipDelayDuration={200}>
            <RouterProvider router={router} />
          </TooltipProvider>
          <AppToaster />
        </DirectionRoot>
      </MotionConfig>
    </PersistQueryClientProvider>
  </StrictMode>,
);
