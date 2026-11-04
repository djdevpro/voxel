/** Bandeau « Reconnectez-vous à cette boîte » quand le serveur mail refuse les identifiants (401). */
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { KeyRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useReconnect, useSession } from '@/components/auth/session';
import { tBase } from '@/lib/motion';
import { useAddMailbox } from './AddMailboxDialog';

export function ReconnectBanner() {
  const { t } = useTranslation('accounts');
  const ids = useReconnect((s) => s.ids);
  const clear = useReconnect((s) => s.clear);
  const { data: session } = useSession();
  const show = useAddMailbox((s) => s.show);
  const mb = session?.mailboxes.find((m) => ids.includes(m.id));

  return (
    <AnimatePresence>
      {mb && (
        <motion.div
          key={mb.id}
          role="alert"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={tBase}
          className="pointer-events-auto fixed top-3 left-1/2 z-50 flex w-[min(560px,calc(100vw-24px))] -translate-x-1/2 flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap rounded-xl border border-(--voxel-float-border) bg-panel py-2.5 ps-3.5 pe-2 shadow-(--voxel-float-shadow)"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--voxel-warn,#f59e0b)_16%,transparent)] text-[var(--voxel-warn,#d97706)]">
            <KeyRound className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-text-1" title={t('reconnect.title', { email: mb.email })}>
              {t('reconnect.title', { email: mb.email })}
            </div>
            <div className="line-clamp-2 text-[12px] text-text-2 sm:line-clamp-1">{t('reconnect.text')}</div>
          </div>
          {/* écran étroit : le bouton passe sur sa propre ligne, pleine largeur (après la croix) */}
          <Button size="sm" className="order-last w-full sm:order-none sm:w-auto" onClick={() => show({ email: mb.email, reconnect: true })}>
            {t('reconnect.action')}
          </Button>
          <button
            type="button"
            onClick={() => clear(mb.id)}
            aria-label={t('reconnect.dismiss')}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-3 voxel-transition hover:bg-black/[0.05] hover:text-text-1 dark:hover:bg-white/[0.06]"
          >
            <X className="size-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
