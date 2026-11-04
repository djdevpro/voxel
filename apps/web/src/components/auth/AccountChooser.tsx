/** Écran « Choisir un compte » à la Gmail : adresses mémorisées sur l'appareil (jamais de mot de passe). */
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, UserPlus, X } from 'lucide-react';
import type { KnownAccount } from './session';
import { AccountBadge } from '@/components/common/bits';
import { tBase } from '@/lib/motion';

export function AccountChooser({
  accounts,
  onPick,
  onOther,
  onForget,
}: {
  accounts: KnownAccount[];
  onPick: (email: string) => void;
  onOther: () => void;
  onForget: (email: string) => void;
}) {
  const { t } = useTranslation('auth');
  return (
    <div className="-mx-1.5">
      <ul className="space-y-0.5" aria-label={t('chooser.listLabel')}>
        <AnimatePresence initial={false}>
          {accounts.map((a, i) => (
            <motion.li
              key={a.email}
              layout
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, transition: { ...tBase, delay: 0.03 * i } }}
              exit={{ opacity: 0, height: 0, transition: tBase }}
              className="group relative"
            >
              <button
                type="button"
                onClick={() => onPick(a.email)}
                className="flex w-full items-center gap-3 rounded-xl py-2.5 ps-2.5 pe-11 text-start outline-none voxel-transition hover:bg-(--voxel-menu-hover) focus-visible:bg-(--voxel-menu-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--voxel-accent-ring) active:scale-[0.995]"
              >
                <AccountBadge color={a.color ?? 'var(--voxel-accent)'} label={a.displayName || a.email} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-text-1">{a.displayName || a.email}</span>
                  <span className="block truncate text-[12px] text-text-3 rtl:text-right" dir="ltr">
                    {a.displayName ? a.email : t('provider.generic')}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-text-3 opacity-0 voxel-transition group-hover:translate-x-0.5 group-hover:opacity-100 sm:group-hover:opacity-0 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" />
              </button>
              <button
                type="button"
                onClick={() => onForget(a.email)}
                aria-label={t('chooser.forgetLabel', { email: a.email })}
                title={t('chooser.forget')}
                className="absolute end-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-text-3 opacity-60 outline-none voxel-transition hover:bg-(--voxel-menu-hover) hover:text-text-1 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-(--voxel-accent-ring) sm:opacity-0 sm:group-hover:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
        <li className="mt-1 border-t border-line pt-1">
          <button
            type="button"
            onClick={onOther}
            className="flex w-full items-center gap-3 rounded-xl p-2.5 text-start outline-none voxel-transition hover:bg-(--voxel-menu-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--voxel-accent-ring) active:scale-[0.995]"
          >
            <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[11px] border border-dashed border-line-strong text-text-2">
              <UserPlus className="size-4" />
            </span>
            <span className="text-[13.5px] font-medium text-text-1">{t('chooser.other')}</span>
          </button>
        </li>
      </ul>
    </div>
  );
}
