/**
 * Formulaire de connexion en deux temps : adresse → mot de passe.
 * - JMAP : vérifié directement auprès du serveur (`GET` de l'URL de session avec Basic) ;
 * - IMAP : vérifié par la passerelle (`GET /imap/session`, en-têtes `X-Voxel-Imap` / `X-Voxel-Smtp`).
 * L'URL de session vient de `config.json`, sinon de la découverte de la passerelle (`POST /imap/discover`).
 * Utilisé en page (écran de connexion) et en dialogue (ajout / reconnexion d'une boîte).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, ChevronDown, Eye, EyeOff, Loader2, ServerCog } from 'lucide-react';
import { ApiError, errorMessage, type MailboxInfo } from '@/lib/api';
import type { MailEndpoint } from '@/lib/db';
import { findAccountByEmail, loginAccount } from '@/lib/accounts';
import { isAllowedSessionUrl, sessionHost, sessionUrlFor } from '@/lib/config';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { tBase, tFast } from '@/lib/motion';
import { useIsRtl } from './session';
import { isDesktop, platformFetch } from '@/lib/platform';

/** Pastille « JMAP · mail.example.com » ou « IMAP · imap.example.com ». */
export function ServerPill({ protocol, host, className }: { protocol: 'jmap' | 'imap'; host: string; className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full border border-line bg-black/[0.025] px-2 py-0.5 text-[11px] font-medium text-text-2 dark:bg-white/[0.04]', className)}
      dir="ltr"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-success" />
      {protocol.toUpperCase()}
      {host && <span className="text-text-3">· {host}</span>}
    </span>
  );
}

/** Hôte affiché d'une boîte (serveur JMAP, ou serveur IMAP). */
export function mailboxHost(m: Pick<MailboxInfo, 'protocol' | 'sessionUrl' | 'imap'>): string {
  return m.protocol === 'imap' ? (m.imap?.host ?? '') : sessionHost(m.sessionUrl);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ------------------------------------------------------------------ champs

const fieldCls =
  'h-11 w-full rounded-lg border border-line-strong bg-panel px-3.5 text-[14px] text-text-1 outline-none voxel-transition placeholder:text-text-3 focus:border-voxel-accent focus:ring-4 focus:ring-voxel-accent-soft aria-invalid:border-danger';
const smallFieldCls =
  'h-9 w-full rounded-lg border border-line-strong bg-panel px-3 text-[13px] text-text-1 outline-none voxel-transition placeholder:text-text-3 focus:border-voxel-accent focus:ring-[3px] focus:ring-voxel-accent-soft aria-invalid:border-danger';

function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[12.5px] font-medium text-text-2">
      {children}
    </label>
  );
}

function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-full rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.06]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('relative h-7 flex-1 rounded-md px-2 text-[12px] font-medium voxel-transition', value === o.value ? 'text-text-1' : 'text-text-2 hover:text-text-1')}
        >
          {value === o.value && <motion.span layoutId={`seg-${label}`} className="absolute inset-0 rounded-md bg-panel shadow-soft" transition={tFast} />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ réglages avancés

type Security = MailEndpoint['security'];
interface EndpointForm {
  host: string;
  port: string;
  security: Security;
}
interface AdvancedForm {
  protocol: 'jmap' | 'imap';
  sessionUrl: string;
  imap: EndpointForm;
  smtp: EndpointForm;
  /** ManageSieve, facultatif (hôte vide : aucun). */
  sieve: EndpointForm;
  /** Service CardDAV (contacts), facultatif : URL https (vide : aucun). */
  carddav: string;
  /** Service CalDAV (agenda), facultatif : URL https (vide : aucun). */
  caldav: string;
  username: string;
}

/** URL CardDAV acceptable : https, sans identifiants. */
const isCardDavUrl = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443');
  } catch {
    return false;
  }
};

const EMPTY_IMAP: EndpointForm = { host: '', port: '993', security: 'ssl' };
const EMPTY_SMTP: EndpointForm = { host: '', port: '465', security: 'ssl' };
const EMPTY_SIEVE: EndpointForm = { host: '', port: '4190', security: 'starttls' };

const toForm = (e: MailEndpoint | undefined, empty: EndpointForm): EndpointForm => (e ? { host: e.host, port: String(e.port), security: e.security } : empty);
const toEndpoint = (f: EndpointForm): MailEndpoint | undefined => {
  const port = Number(f.port);
  return f.host && Number.isInteger(port) && port > 0 ? { host: f.host.toLowerCase(), port, security: f.security } : undefined;
};

function EndpointFields({
  id,
  kind,
  title,
  value,
  onChange,
  domain,
  optional,
}: {
  id: string;
  kind: 'imap' | 'smtp' | 'sieve';
  title: string;
  value: EndpointForm;
  onChange: (v: EndpointForm) => void;
  domain: string;
  optional?: boolean;
}) {
  const { t } = useTranslation('auth');
  const setSecurity = (security: Security) => {
    // ports usuels : 993/143 (IMAP), 465/587 (SMTP)
    const defaults = kind === 'imap' ? { ssl: '993', starttls: '143' } : kind === 'smtp' ? { ssl: '465', starttls: '587' } : { ssl: '4190', starttls: '4190' };
    const isDefault = Object.values(defaults).includes(value.port) || !value.port;
    onChange({ ...value, security, port: isDefault ? defaults[security] : value.port });
  };
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-[12px] font-semibold tracking-wide text-text-2 uppercase">{title}</legend>
      <div className="grid grid-cols-[1fr_84px] gap-2">
        <div>
          <label htmlFor={`${id}-host`} className="sr-only">
            {t('advanced.host')}
          </label>
          <input
            id={`${id}-host`}
            className={smallFieldCls}
            value={value.host}
            required={!optional}
            onChange={(e) => onChange({ ...value, host: e.target.value.trim() })}
            placeholder={optional ? t('advanced.optional') : `${kind}.${domain || t('advanced.domainPlaceholder')}`}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
          />
        </div>
        <div>
          <label htmlFor={`${id}-port`} className="sr-only">
            {t('advanced.port')}
          </label>
          <input
            id={`${id}-port`}
            className={cn(smallFieldCls, 'tabular-nums')}
            value={value.port}
            inputMode="numeric"
            required={!optional}
            onChange={(e) => onChange({ ...value, port: e.target.value.replace(/\D/g, '').slice(0, 5) })}
            placeholder={t('advanced.port')}
            dir="ltr"
          />
        </div>
      </div>
      <Seg
        label={`${title} — ${t('advanced.security')}`}
        value={value.security}
        onChange={setSecurity}
        options={[
          { value: 'ssl', label: t('advanced.tls') },
          { value: 'starttls', label: t('advanced.starttls') },
        ]}
      />
    </fieldset>
  );
}

function AdvancedPanel({ value, onChange, email, invalidUrl }: { value: AdvancedForm; onChange: (v: AdvancedForm) => void; email: string; invalidUrl: boolean }) {
  const { t } = useTranslation('auth');
  const id = useId();
  const domain = email.split('@')[1] ?? '';
  return (
    <div className="space-y-4 rounded-lg border border-line bg-black/[0.015] p-3.5 dark:bg-white/[0.02]">
      <div>
        <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{t('advanced.protocol')}</span>
        <Seg
          label={t('advanced.protocol')}
          value={value.protocol}
          onChange={(protocol) => onChange({ ...value, protocol })}
          options={[
            { value: 'jmap', label: 'JMAP' },
            { value: 'imap', label: 'IMAP' },
          ]}
        />
      </div>
      <AnimatePresence initial={false} mode="popLayout">
        {value.protocol === 'jmap' ? (
          <motion.div key="jmap" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={tFast}>
            <Label htmlFor={`${id}-jmap`}>{t('advanced.jmapUrl')}</Label>
            <input
              id={`${id}-jmap`}
              className={smallFieldCls}
              type="url"
              value={value.sessionUrl}
              onChange={(e) => onChange({ ...value, sessionUrl: e.target.value.trim() })}
              placeholder={`https://mail.${domain || t('advanced.domainPlaceholder')}/jmap/session`}
              aria-invalid={invalidUrl || undefined}
              spellCheck={false}
              dir="ltr"
            />
            {invalidUrl && <p className="mt-1 text-[11.5px] text-danger">{t('advanced.jmapUrlInvalid')}</p>}
          </motion.div>
        ) : (
          <motion.div key="imap" className="space-y-4" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={tFast}>
            <EndpointFields id={`${id}-imap`} kind="imap" title={t('advanced.incoming')} value={value.imap} onChange={(imap) => onChange({ ...value, imap })} domain={domain} />
            <EndpointFields id={`${id}-smtp`} kind="smtp" title={t('advanced.outgoing')} value={value.smtp} onChange={(smtp) => onChange({ ...value, smtp })} domain={domain} />
            <EndpointFields id={`${id}-sieve`} kind="sieve" title={t('advanced.sieve')} value={value.sieve} onChange={(sieve) => onChange({ ...value, sieve })} domain={domain} optional />
            <div>
              <Label htmlFor={`${id}-carddav`}>{t('advanced.carddav')}</Label>
              <input
                id={`${id}-carddav`}
                className={smallFieldCls}
                type="url"
                value={value.carddav}
                onChange={(e) => onChange({ ...value, carddav: e.target.value.trim() })}
                placeholder={`https://${domain || t('advanced.domainPlaceholder')}/.well-known/carddav`}
                aria-invalid={(!!value.carddav && !isCardDavUrl(value.carddav)) || undefined}
                aria-describedby={`${id}-carddav-hint`}
                spellCheck={false}
                dir="ltr"
              />
              <p id={`${id}-carddav-hint`} className={cn('mt-1 text-[11.5px]', value.carddav && !isCardDavUrl(value.carddav) ? 'text-danger' : 'text-text-3')}>
                {value.carddav && !isCardDavUrl(value.carddav) ? t('advanced.carddavInvalid') : t('advanced.carddavHint')}
              </p>
            </div>
            <div>
              <Label htmlFor={`${id}-caldav`}>{t('advanced.caldav')}</Label>
              <input
                id={`${id}-caldav`}
                className={smallFieldCls}
                type="url"
                value={value.caldav}
                onChange={(e) => onChange({ ...value, caldav: e.target.value.trim() })}
                placeholder={`https://${domain || t('advanced.domainPlaceholder')}/.well-known/caldav`}
                aria-invalid={(!!value.caldav && !isCardDavUrl(value.caldav)) || undefined}
                aria-describedby={`${id}-caldav-hint`}
                spellCheck={false}
                dir="ltr"
              />
              <p id={`${id}-caldav-hint`} className={cn('mt-1 text-[11.5px]', value.caldav && !isCardDavUrl(value.caldav) ? 'text-danger' : 'text-text-3')}>
                {value.caldav && !isCardDavUrl(value.caldav) ? t('advanced.carddavInvalid') : t('advanced.caldavHint')}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div>
        <Label htmlFor={`${id}-user`}>{t('advanced.username')}</Label>
        <input
          id={`${id}-user`}
          className={smallFieldCls}
          value={value.username}
          onChange={(e) => onChange({ ...value, username: e.target.value })}
          placeholder={email || t('advanced.usernamePlaceholder')}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
        />
        <p className="mt-1 text-[11.5px] text-text-3">{t('advanced.usernameHint')}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ découverte

type DiscoverResult =
  | { protocol: 'jmap'; sessionUrl: string }
  | { protocol: 'imap'; imap: MailEndpoint; smtp: MailEndpoint; sieve?: MailEndpoint; carddav?: string; caldav?: string; username?: 'email' | 'localpart' }
  | { protocol: null };

/** `POST /imap/discover` (passerelle) ; `null` si elle est injoignable ou refuse. */
async function discoverViaGateway(email: string): Promise<DiscoverResult | null> {
  try {
    const res = await platformFetch('/imap/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email }),
      credentials: 'omit',
    });
    if (!res.ok) return null;
    const d = (await res.json()) as DiscoverResult;
    if (d?.protocol === 'jmap' && typeof d.sessionUrl === 'string' && isAllowedSessionUrl(d.sessionUrl)) return d;
    if (d?.protocol === 'imap' && d.imap?.host && d.smtp?.host) return d;
    return { protocol: null };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ formulaire

export interface LoginFlowProps {
  /** Adresse pré-remplie (compte mémorisé, reconnexion). */
  initialEmail?: string;
  /** Reconnexion : l'adresse ne peut pas être changée. */
  lockEmail?: boolean;
  onSuccess: (m: MailboxInfo) => void;
  /** Retour à l'écran « Choisir un compte ». */
  onBack?: () => void;
  variant?: 'page' | 'dialog';
}

export function LoginFlow({ initialEmail, lockEmail, onSuccess, onBack }: LoginFlowProps) {
  const { t } = useTranslation('auth');
  const rtl = useIsRtl();
  const id = useId();
  const [step, setStep] = useState<'email' | 'password'>('email');
  const [dir, setDir] = useState(1);
  const [email, setEmail] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [advOpen, setAdvOpen] = useState(false);
  const [adv, setAdv] = useState<AdvancedForm>({ protocol: 'jmap', sessionUrl: '', imap: EMPTY_IMAP, smtp: EMPTY_SMTP, sieve: EMPTY_SIEVE, carddav: '', caldav: '', username: '' });
  /** Secret saisi : mot de passe (Basic) ou jeton d'API (Bearer, boîte JMAP seulement). */
  const [authKind, setAuthKind] = useState<'password' | 'token'>('password');
  useEffect(() => {
    if (adv.protocol === 'imap') setAuthKind('password');
  }, [adv.protocol]);
  /** Configuration trouvée automatiquement (sinon : réglages manuels). */
  const [detected, setDetected] = useState<'config' | 'discovered' | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const autoRan = useRef(false);
  const invalidUrl = adv.protocol === 'jmap' && !!adv.sessionUrl && !isAllowedSessionUrl(adv.sessionUrl);
  const imapEp = toEndpoint(adv.imap);
  const smtpEp = toEndpoint(adv.smtp);
  const sieveEp = toEndpoint(adv.sieve);
  const carddavOk = (!adv.carddav || isCardDavUrl(adv.carddav)) && (!adv.caldav || isCardDavUrl(adv.caldav));
  const ready = adv.protocol === 'jmap' ? !!adv.sessionUrl && !invalidUrl : !!imapEp && !!smtpEp && carddavOk;
  const pillHost = adv.protocol === 'jmap' ? (adv.sessionUrl ? sessionHost(adv.sessionUrl) : '') : (imapEp?.host ?? '');

  const goPassword = () => {
    setDir(1);
    setStep('password');
  };
  const goEmail = () => {
    setDir(-1);
    setStep('email');
    setError(null);
    setPassword('');
    setTimeout(() => emailRef.current?.focus(), 30);
  };

  /** Adresse → configuration : compte déjà connu (reconnexion), `config.json`, puis découverte de la passerelle. */
  const chooseAddress = async (addr: string) => {
    setError(null);
    const clean = addr.trim().toLowerCase();
    if (!EMAIL_RE.test(clean)) {
      setError(t('errors.invalidEmail'));
      return;
    }
    setEmail(clean);
    const known = await findAccountByEmail(clean).catch(() => undefined);
    const username = known && known.username !== clean ? known.username : '';
    if (known) {
      setAdv({ protocol: known.protocol ?? 'jmap', sessionUrl: known.protocol === 'imap' ? '' : known.sessionUrl, imap: toForm(known.imap, EMPTY_IMAP), smtp: toForm(known.smtp, EMPTY_SMTP), sieve: toForm(known.sieve, EMPTY_SIEVE), carddav: known.carddav ?? '', caldav: known.caldav ?? '', username });
      if (known.auth === 'bearer') setAuthKind('token');
      setDetected('config');
      setAdvOpen(!!username);
      goPassword();
      return;
    }
    const configured = sessionUrlFor(clean);
    if (configured) {
      setAdv({ protocol: 'jmap', sessionUrl: configured, imap: EMPTY_IMAP, smtp: EMPTY_SMTP, sieve: EMPTY_SIEVE, carddav: '', caldav: '', username: '' });
      setDetected('config');
      setAdvOpen(false);
      goPassword();
      return;
    }
    setDiscovering(true);
    const d = await discoverViaGateway(clean);
    setDiscovering(false);
    if (d?.protocol === 'jmap') {
      setAdv({ protocol: 'jmap', sessionUrl: d.sessionUrl, imap: EMPTY_IMAP, smtp: EMPTY_SMTP, sieve: EMPTY_SIEVE, carddav: '', caldav: '', username: '' });
      setDetected('discovered');
      setAdvOpen(false);
    } else if (d?.protocol === 'imap') {
      setAdv({ protocol: 'imap', sessionUrl: '', imap: toForm(d.imap, EMPTY_IMAP), smtp: toForm(d.smtp, EMPTY_SMTP), sieve: toForm(d.sieve, EMPTY_SIEVE), carddav: typeof d.carddav === 'string' && isCardDavUrl(d.carddav) ? d.carddav : '', caldav: typeof d.caldav === 'string' && isCardDavUrl(d.caldav) ? d.caldav : '', username: d.username === 'localpart' ? clean.split('@')[0]! : '' });
      setDetected('discovered');
      setAdvOpen(d.username === 'localpart');
    } else {
      // rien trouvé (ou passerelle injoignable) : réglages manuels
      setAdv({ protocol: 'imap', sessionUrl: '', imap: EMPTY_IMAP, smtp: EMPTY_SMTP, sieve: EMPTY_SIEVE, carddav: '', caldav: '', username: '' });
      setDetected(null);
      setAdvOpen(true);
    }
    goPassword();
  };

  // compte mémorisé / reconnexion : on passe directement au mot de passe
  useEffect(() => {
    if (initialEmail && !autoRan.current) {
      autoRan.current = true;
      void chooseAddress(initialEmail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEmail]);

  useEffect(() => {
    if (step === 'password') setTimeout(() => pwRef.current?.focus(), 60);
  }, [step]);

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    void chooseAddress(email);
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    if (!ready) {
      setAdvOpen(true);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const m = await loginAccount({
        email,
        username: adv.username.trim() || undefined,
        protocol: adv.protocol,
        sessionUrl: adv.sessionUrl,
        imap: imapEp,
        smtp: smtpEp,
        sieve: sieveEp,
        carddav: adv.protocol === 'imap' && adv.carddav ? adv.carddav : undefined,
        caldav: adv.protocol === 'imap' && adv.caldav ? adv.caldav : undefined,
        password,
        auth: authKind === 'token' ? 'bearer' : 'basic',
        remember,
      });
      setPassword('');
      onSuccess(m);
    } catch (err) {
      // serveur JMAP découvert mais injoignable depuis le navigateur : très souvent le CORS
      const cors = !isDesktop && adv.protocol === 'jmap' && detected === 'discovered' && err instanceof ApiError && err.code === 'upstream_unreachable' && err.status === 0;
      setError(cors ? t('loginError.jmapCors') : errorMessage(err));
      setBusy(false);
      setTimeout(() => pwRef.current?.select(), 30);
      return;
    }
    setBusy(false);
  };

  // glissement horizontal, inversé en RTL
  const sign = rtl ? -1 : 1;
  const slide = {
    initial: (d: number) => ({ opacity: 0, x: 18 * d * sign }),
    animate: { opacity: 1, x: 0 },
    exit: (d: number) => ({ opacity: 0, x: -18 * d * sign }),
  };

  const errorBlock = (
    <AnimatePresence initial={false}>
      {error && (
        <motion.p
          key={error}
          role="alert"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={tBase}
          className="overflow-hidden text-[12.5px] leading-relaxed text-danger"
        >
          {error}
        </motion.p>
      )}
    </AnimatePresence>
  );

  return (
    <div className="relative overflow-hidden">
      <AnimatePresence initial={false} mode="popLayout" custom={dir}>
        {step === 'email' ? (
          <motion.form
            key="email"
            custom={dir}
            variants={slide}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={tBase}
            onSubmit={submitEmail}
            className="space-y-4"
            noValidate
          >
            <div>
              <Label htmlFor={`${id}-email`}>{t('email.label')}</Label>
              <input
                ref={emailRef}
                id={`${id}-email`}
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus={!initialEmail}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                placeholder={t('email.placeholder')}
                aria-invalid={!!error || undefined}
                className={fieldCls}
                dir="ltr"
              />
            </div>
            {errorBlock}
            <div className={cn('flex items-center gap-2', onBack ? 'justify-between' : 'justify-end')}>
              {onBack && (
                <Button type="button" variant="ghost" onClick={onBack} className="text-text-2">
                  <ArrowLeft className="rtl:-scale-x-100" /> {t('chooser.back')}
                </Button>
              )}
              <Button type="submit" className={cn('h-11 text-[14px]', onBack ? 'px-5' : 'w-full')} disabled={discovering || !email.trim()}>
                {discovering && <Loader2 className="animate-spin" />}
                {discovering ? t('email.detecting') : t('email.next')}
                {!discovering && <ArrowRight className="opacity-70 rtl:-scale-x-100" />}
              </Button>
            </div>
          </motion.form>
        ) : (
          <motion.form
            key="password"
            custom={dir}
            variants={slide}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={tBase}
            onSubmit={submitPassword}
            className="space-y-4"
          >
            {/* adresse choisie + serveur */}
            <div className="flex items-center gap-2.5 rounded-lg border border-line bg-black/[0.02] py-1.5 ps-1.5 pe-2 dark:bg-white/[0.03]">
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-voxel-accent-soft text-[13px] font-semibold text-voxel-accent-strong uppercase"
              >
                {email.charAt(0)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-text-1 rtl:text-right" dir="ltr">
                  {email}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  {detected || ready ? (
                    <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...tBase, delay: 0.08 }} title={t('detected.title')}>
                      <ServerPill protocol={adv.protocol} host={pillHost} />
                    </motion.span>
                  ) : (
                    <span className="text-[11px] text-text-3">{t('detected.none')}</span>
                  )}
                </div>
              </div>
              {!lockEmail && (
                <button type="button" onClick={goEmail} className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-text-2 voxel-transition hover:bg-black/[0.04] hover:text-text-1 dark:hover:bg-white/[0.06]">
                  {t('password.change')}
                </button>
              )}
            </div>
            {/* aide aux gestionnaires de mots de passe */}
            <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />

            {adv.protocol === 'jmap' && (
              <Seg
                label={t('password.kindLabel')}
                value={authKind}
                onChange={setAuthKind}
                options={[
                  { value: 'password', label: t('password.kindPassword') },
                  { value: 'token', label: t('password.kindToken') },
                ]}
              />
            )}

            <div>
              <Label htmlFor={`${id}-pw`}>{authKind === 'token' ? t('password.tokenLabel') : t('password.label')}</Label>
              <div className="relative">
                <input
                  ref={pwRef}
                  id={`${id}-pw`}
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  autoComplete={authKind === 'token' ? 'off' : 'current-password'}
                  aria-invalid={!!error || undefined}
                  className={cn(fieldCls, 'pe-11 rtl:ps-11 rtl:pe-3.5')}
                  dir="ltr"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPw((s) => !s)}
                  className="absolute end-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-text-3 voxel-transition hover:bg-(--voxel-menu-hover) hover:text-text-1"
                  aria-label={showPw ? t('password.hide') : t('password.show')}
                >
                  {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {authKind === 'token' && <p className="mt-1 text-[11.5px] text-text-3">{t('password.tokenHint')}</p>}
            </div>

            <label htmlFor={`${id}-remember`} className="flex cursor-pointer items-center gap-2.5 text-[12.5px] text-text-2 select-none">
              <Checkbox id={`${id}-remember`} checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
              {t('password.remember')}
            </label>

            {errorBlock}

            <div>
              <button
                type="button"
                onClick={() => setAdvOpen((o) => !o)}
                aria-expanded={advOpen}
                className="flex items-center gap-1.5 text-[12.5px] text-text-2 voxel-transition hover:text-text-1"
              >
                <ServerCog className="size-3.5" />
                {t('advanced.toggle')}
                <ChevronDown className={cn('size-3.5 transition-transform duration-150 ease-voxel', advOpen && 'rotate-180')} />
              </button>
              <AnimatePresence initial={false}>
                {advOpen && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tBase} className="overflow-hidden">
                    <div className="pt-3">
                      {!detected && <p className="mb-2.5 text-[12px] leading-relaxed text-text-2">{t('advanced.notDetected')}</p>}
                      <AdvancedPanel value={adv} onChange={setAdv} email={email} invalidUrl={invalidUrl} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <Button type="submit" className="h-11 w-full text-[14px]" disabled={busy || !password}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t('password.signingIn') : t('password.submit')}
              {!busy && <ArrowRight className="opacity-70 rtl:-scale-x-100" />}
            </Button>
            <p className="text-center text-[11.5px] leading-relaxed text-balance text-text-3">{t('password.reassure')}</p>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
