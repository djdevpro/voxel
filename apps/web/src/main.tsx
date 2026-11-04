import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { registerSW } from 'virtual:pwa-register';
import { MotionConfig } from 'motion/react';
import '@fontsource-variable/inter';
import './styles/globals.css';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { queryClient, dexiePersister } from './lib/queryClient';
import { TooltipProvider } from './components/ui/tooltip';
import { AppToaster } from './components/common/AppToaster';
import { i18nReady } from './i18n';
import { applyThemeId, getThemeId } from './lib/themes';
import { loadConfig } from './lib/config';
import { unlockAccounts } from './lib/accounts';
import { Direction } from 'radix-ui';
import { useDirection } from './hooks/useDirection';
import type { ReactNode } from 'react';

/** Sens d'écriture fourni à tous les composants Radix (écran de connexion, dialogues hors messagerie, toasts). */
function DirectionRoot({ children }: { children: ReactNode }) {
  return <Direction.Provider dir={useDirection()}>{children}</Direction.Provider>;
}

if (import.meta.env.PROD) registerSW({ immediate: true });

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
