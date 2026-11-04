/** Écran de connexion : choix d'un compte mémorisé ou connexion en deux temps. */
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Lock, RefreshCw, WifiOff } from 'lucide-react';
import { Logo } from '@/components/common/Logo';
import { Button } from '@/components/ui/button';
import type { MailboxInfo } from '@/lib/api';
import { tBase, tSlow } from '@/lib/motion';
import { LoginFlow } from './LoginFlow';
import { AccountChooser } from './AccountChooser';
import { LanguagePicker } from './LanguagePicker';
import { afterLogin, useKnownAccounts } from './session';

export function AuthScreen({
  unreachable,
  onRetry,
  initialEmail,
  onCancel,
}: {
  unreachable?: boolean;
  onRetry: () => void;
  /** adresse imposée par un lien profond (`/login?email=`) */
  initialEmail?: string;
  /** une session existe déjà : retour à la messagerie */
  onCancel?: () => void;
}) {
  const { t } = useTranslation('auth');
  const known = useKnownAccounts((s) => s.list);
  const forget = useKnownAccounts((s) => s.forget);
  const [mode, setMode] = useState<{ kind: 'choose' } | { kind: 'login'; email?: string; key: number }>(() =>
    initialEmail ? { kind: 'login', email: initialEmail, key: 0 } : known.length ? { kind: 'choose' } : { kind: 'login', key: 0 },
  );

  // nouvelle adresse imposée par l'URL (lien vers une autre boîte)
  useEffect(() => {
    if (initialEmail) setMode((m) => (m.kind === 'login' && m.email === initialEmail ? m : { kind: 'login', email: initialEmail, key: Date.now() }));
  }, [initialEmail]);

  useEffect(() => {
    document.title = t('common:title.signIn', { app: 'Voxel' });
  }, [t]);

  // plus aucun compte mémorisé : on passe au formulaire
  useEffect(() => {
    if (mode.kind === 'choose' && !known.length) setMode({ kind: 'login', key: Date.now() });
  }, [known.length, mode.kind]);

  const onSuccess = async (m: MailboxInfo) => {
    await afterLogin(m);
  };

  const title = mode.kind === 'choose' ? t('chooser.title') : mode.email ? t('title.welcomeBack') : t('title.signIn');
  const subtitle =
    mode.kind === 'choose' ? t('chooser.subtitle') : initialEmail && mode.email === initialEmail && onCancel ? t('title.deepLink', { email: initialEmail }) : t('title.subtitle');

  return (
    <motion.main
      className="absolute inset-0 flex flex-col items-center overflow-y-auto bg-app px-5"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, pointerEvents: 'none' }}
      transition={tBase}
    >
      {/* fond : lueur d'accent très douce venue du haut + trame de points estompée (aucun flou coûteux) */}
      <div aria-hidden className="voxel-auth-backdrop pointer-events-none absolute inset-0" />
      <div className="relative flex w-full flex-1 flex-col items-center justify-center py-14">
        <motion.div className="relative w-full max-w-[400px]" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...tSlow, delay: 0.04 }}>
          <div className="mb-7 flex flex-col items-center text-center">
            <Logo className="size-10" />
            <span className="mt-2.5 mb-5 text-[12.5px] font-medium tracking-[0.01em] text-text-3">Voxel</span>
            <motion.div key={title} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={tBase}>
              <h1 className="text-[22px] font-semibold tracking-[-0.018em] text-balance text-text-1">{title}</h1>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-balance text-text-2">{subtitle}</p>
            </motion.div>
          </div>

          {unreachable ? (
            <div className="voxel-auth-card rounded-2xl border p-6 text-center">
              <WifiOff className="mx-auto mb-3 size-5 text-text-3" />
              <p className="text-[13.5px] font-medium text-text-1">{t('unreachable.title')}</p>
              <p className="mt-1 text-[12.5px] text-text-2">{t('unreachable.text')}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
                <RefreshCw /> {t('unreachable.retry')}
              </Button>
            </div>
          ) : (
            <div className="voxel-auth-card rounded-2xl border p-5 sm:p-6">
              <>
                {mode.kind === 'choose' ? (
                  <motion.div key="choose" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={tBase}>
                    <AccountChooser
                      accounts={known}
                      onPick={(email) => setMode({ kind: 'login', email, key: Date.now() })}
                      onOther={() => setMode({ kind: 'login', key: Date.now() })}
                      onForget={forget}
                    />
                  </motion.div>
                ) : (
                  <motion.div key={`login-${mode.key}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={tBase}>
                    <LoginFlow
                      initialEmail={mode.email}
                      onSuccess={onSuccess}
                      onBack={known.length ? () => setMode({ kind: 'choose' }) : undefined}
                    />
                  </motion.div>
                )}
              </>
            </div>
          )}
        </motion.div>
      </div>
      <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 px-3 pt-3 sm:px-4 sm:pt-4">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-text-2 outline-none voxel-transition hover:bg-(--voxel-menu-hover) hover:text-text-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--voxel-accent-ring)"
          >
            <ArrowLeft className="size-4 rtl:-scale-x-100" />
            {t('backToMail')}
          </button>
        ) : (
          <span />
        )}
        <LanguagePicker />
      </div>
      <footer className="relative w-full max-w-[400px] pb-6 text-center">
        <p className="text-[11.5px] leading-relaxed text-balance text-text-3">
          <Lock className="me-1 inline size-3 -translate-y-px align-middle" />
          {t('footer.security')}
        </p>
      </footer>
    </motion.main>
  );
}
