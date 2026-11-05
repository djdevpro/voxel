/** Paramètres → Boîtes : boîtes de la session, nom, couleur, test de connexion, déconnexion. */
import { useEffect, useState } from 'react';
import { inkOn } from '@/lib/accent';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ExternalLink, Loader2, LogOut, Plug, Plus, Power, ShieldCheck } from 'lucide-react';
import { useAccounts } from '@/hooks/useData';
import { ACCOUNT_COLORS, type MailboxInfo } from '@/lib/api';
import { jmap, dropClient } from '@/lib/jmap';
import { AccountBadge } from '@/components/common/bits';
import { Button } from '@/components/ui/button';
import { mailboxHost, ServerPill } from '@/components/auth/LoginFlow';
import { useReconnect } from '@/components/auth/session';
import { useAddMailbox } from '@/components/rail/AddMailboxDialog';
import { confirmLogoutAll, confirmLogoutMailbox, updateMailbox } from '@/components/rail/mailboxActions';
import { Field, SectionIntro, inputCls } from './ui';
import { cn } from '@/lib/utils';
import { tBase } from '@/lib/motion';
import { accountPortalFor } from '@/lib/config';
import { QuotaBar } from '@/components/quota/QuotaBar';

export { ACCOUNT_COLORS };

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const { t } = useTranslation('accounts');
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('section.color')}>
      {ACCOUNT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className="flex size-6 items-center justify-center rounded-full outline-none voxel-transition hover:scale-110 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
          style={{ background: c }}
        >
          {value.toLowerCase() === c && <Check className="size-3.5" style={{ color: inkOn(c) }} strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}

function AccountCard({ a, defaultOpen }: { a: MailboxInfo; defaultOpen: boolean }) {
  const { t } = useTranslation('accounts');
  const [name, setName] = useState(a.displayName);
  const [testing, setTesting] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle');
  const [open, setOpen] = useState(defaultOpen);
  const needsReconnect = useReconnect((s) => s.ids.includes(a.id));
  const showAdd = useAddMailbox((s) => s.show);
  useEffect(() => setName(a.displayName), [a.displayName]);

  const test = async () => {
    setTesting('busy');
    try {
      dropClient(a.id);
      await jmap(a.id).getSession(true);
      setTesting('ok');
    } catch {
      setTesting('fail');
    }
    setTimeout(() => setTesting('idle'), 3000);
  };

  const caps = (['vacation', 'sieve', 'contacts', 'submissionDelay', 'quota'] as const).filter((c) => a.capabilities[c]);
  // « Gérer mon compte » : portail du serveur de messagerie configuré dans config.json
  const portal = accountPortalFor(a.email);

  return (
    <motion.div layout transition={tBase} className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-3 p-3">
        <AccountBadge color={a.color} label={a.displayName || a.email} size={34} />
        <button type="button" onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 text-start" aria-expanded={open}>
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-text-1">{a.displayName || a.email}</span>
            <ServerPill protocol={a.protocol} host={mailboxHost(a)} className="hidden sm:inline-flex" />
          </div>
          <div className="truncate text-[12px] text-text-3 rtl:text-right" dir="ltr">
            {a.email}
          </div>
        </button>
        {needsReconnect && (
          <Button size="sm" variant="outline" onClick={() => showAdd({ email: a.email, reconnect: true })}>
            {t('reconnect.action')}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={t('section.details')} onClick={() => setOpen((o) => !o)}>
          <ChevronDown className={cn('transition-transform duration-150 ease-voxel', open && 'rotate-180')} />
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tBase} className="overflow-hidden">
            <div className="grid gap-4 border-t border-line p-4 sm:grid-cols-2">
              <Field label={t('section.displayName')} hint={t('section.displayNameHint')}>
                <input
                  className={inputCls}
                  value={name}
                  placeholder={a.email}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => name.trim() !== a.displayName && void updateMailbox(a, { displayName: name.trim() })}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
              </Field>
              <Field label={t('section.color')}>
                <div className="flex h-9 items-center">
                  <ColorPicker value={a.color} onChange={(color) => void updateMailbox(a, { color })} />
                </div>
              </Field>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-text-2 sm:col-span-2">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5 text-text-3" />
                  {t(a.auth === 'bearer' ? 'section.storedTokenOnDevice' : 'section.storedOnDevice')}
                </span>
                {caps.length > 0 && (
                  <span>
                    {t('section.capabilities')} {caps.map((c) => t(`capability.${c}`)).join(' · ')}
                  </span>
                )}
              </div>
              {a.capabilities.quota && <QuotaBar account={a} className="sm:col-span-2" />}
              <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                {portal && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={portal} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="rtl:-scale-x-100" /> {t('section.manageAccount')}
                    </a>
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={test} disabled={testing === 'busy'}>
                  {testing === 'busy' ? <Loader2 className="animate-spin" /> : testing === 'ok' ? <Check className="text-success" /> : <Plug />}
                  {testing === 'ok' ? t('section.testOk') : testing === 'fail' ? t('section.testFail') : t('section.test')}
                </Button>
                <div className="flex-1" />
                <Button variant="ghost" size="sm" className="text-danger hover:bg-danger/10 hover:text-danger" onClick={() => void confirmLogoutMailbox(a)}>
                  <LogOut className="rtl:-scale-x-100" /> {t('menu.logout')}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function AccountsSection() {
  const { t } = useTranslation('accounts');
  const { data: accounts } = useAccounts();
  const showAdd = useAddMailbox((s) => s.show);

  return (
    <div className="max-w-[720px]">
      <SectionIntro>{t('section.intro')}</SectionIntro>
      <div className="space-y-2">
        {(accounts ?? []).map((a) => (
          <AccountCard key={a.id} a={a} defaultOpen={accounts!.length === 1} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => showAdd()}>
          <Plus /> {t('rail.add')}
        </Button>
        <div className="flex-1" />
        {(accounts?.length ?? 0) > 0 && (
          <Button variant="ghost" className="text-text-2" onClick={() => void confirmLogoutAll()}>
            <Power /> {t('menu.logoutAll')}
          </Button>
        )}
      </div>
    </div>
  );
}
