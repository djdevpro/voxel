import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { textToHtml } from '@voxel/jmap';
import { useAccounts } from '@/hooks/useData';
import { ALL } from '@/store/ui';
import { useSettingsMailbox } from '@/nav/useSettingsMailbox';
import { fetchVacation, saveVacation } from '@/lib/mail';
import { blocklistQuery, reactivateBlocklistIfNeeded } from '@/lib/blocklist';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { AccountDot } from '@/components/common/bits';
import { Field, SectionIntro, inputCls } from './ui';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/lib/api';
import { vacationSupport, type ManagedVacation } from '@voxel/jmap';
import { saveManaged, sieveErrorMessage, sieveQuery, sieveVacationAvailable, takeOverVacation, type SieveState } from '@/lib/sieve';
import { SieveBanners } from './FiltersSection';

const toLocal = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const toIso = (v: string) => (v ? new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

/**
 * Répondeur : bloc du script Sieve géré si le serveur a l'extension `vacation` (il ne remplace
 * alors plus la liste de blocage ni les filtres) ; sinon `VacationResponse` JMAP comme en v3.
 */
export function VacationSection() {
  const { t } = useTranslation('settings');
  const { data: all } = useAccounts();
  // boîtes qui annoncent le répondeur JMAP ou JMAP for Sieve (répondeur par le script géré)
  const accounts = (all ?? []).filter((a) => a.capabilities?.vacation || a.capabilities?.sieve);
  const viewAccount = useSettingsMailbox();
  const [accountId, setAccountId] = useState(() => (viewAccount !== ALL && accounts.some((a) => a.id === viewAccount) ? viewAccount : accounts[0]?.id ?? ''));
  const account = accounts.find((a) => a.id === accountId);
  const sieve = !!account?.capabilities?.sieve;
  const { data: sieveState, isLoading: sieveLoading } = useQuery({ ...sieveQuery(accountId), enabled: !!accountId && sieve });
  const managed = sieveVacationAvailable(sieveState);
  const picker = (
    <div className="mb-5 max-w-xs">
      <Select value={accountId} onValueChange={setAccountId}>
        <SelectTrigger className="w-full" aria-label={t('vacation.mailbox')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              <AccountDot color={a.color} /> {a.displayName || a.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  if (sieve && sieveLoading) {
    return (
      <div className="max-w-[640px]">
        <SectionIntro>{t('vacation.intro')}</SectionIntro>
        {picker}
        <div className="voxel-skeleton h-24" />
      </div>
    );
  }
  if (managed && sieveState) return <ManagedVacationForm key={accountId} accountId={accountId} state={sieveState} picker={picker} />;
  if (!account?.capabilities?.vacation) {
    return (
      <div className="max-w-[640px]">
        <SectionIntro>{t('vacation.intro')}</SectionIntro>
        {picker}
        <p className="text-[13px] text-text-2">{t('vacation.notAvailable')}</p>
      </div>
    );
  }
  return <JmapVacationForm key={accountId} accountId={accountId} sieve={sieve} picker={picker} />;
}

/** Répondeur JMAP (`VacationResponse`), comportement v3. */
function JmapVacationForm({ accountId, sieve, picker }: { accountId: string; sieve: boolean; picker: ReactNode }) {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['vacation', accountId], queryFn: () => fetchVacation(accountId), enabled: !!accountId });
  const { data: blocklist } = useQuery({ ...blocklistQuery(accountId), enabled: !!accountId && sieve });
  const hasBlocked = !!blocklist && blocklist.list.addresses.length + blocklist.list.domains.length > 0;
  const [enabled, setEnabled] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEnabled(!!data?.isEnabled);
    setFrom(toLocal(data?.fromDate ?? null));
    setTo(toLocal(data?.toDate ?? null));
    setSubject(data?.subject ?? '');
    setBody(data?.textBody ?? '');
  }, [data]);

  const save = async () => {
    setBusy(true);
    try {
      await saveVacation(accountId, {
        isEnabled: enabled,
        fromDate: toIso(from),
        toDate: toIso(to),
        subject: subject || null,
        textBody: body || null,
        htmlBody: body ? textToHtml(body) : null,
      });
      await qc.invalidateQueries({ queryKey: ['vacation', accountId] });
      if (!enabled) await reactivateBlocklistIfNeeded(accountId);
      toast.success(enabled ? t('vacation.enabledToast') : t('vacation.savedToast'));
    } catch (e) {
      toast.error(t('vacation.saveFailed'), { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[640px]">
      <SectionIntro>{t('vacation.intro')}</SectionIntro>
      {picker}
      {isLoading ? (
        <div className="space-y-3">
          <div className="voxel-skeleton h-10" />
          <div className="voxel-skeleton h-24" />
        </div>
      ) : error ? (
        <p className="text-[13px] text-danger">{t('vacation.unavailable', { message: errorMessage(error) })}</p>
      ) : (
        <div className="space-y-4">
          <label className="flex items-center justify-between rounded-xl border border-line p-4">
            <div>
              <div className="text-[13.5px] font-medium text-text-1">{t('vacation.enable')}</div>
              <div className="text-[12.5px] text-text-2">{enabled ? t('vacation.enabledHint') : t('vacation.disabled')}</div>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} className="data-[state=checked]:bg-voxel-accent" />
          </label>
          {enabled && hasBlocked && <p className="-mt-2 text-[12.5px] leading-relaxed text-text-2">{t('vacation.blocklistPaused')}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('vacation.from')}>
              <input type="datetime-local" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t('vacation.to')}>
              <input type="datetime-local" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <Field label={t('vacation.subject')}>
            <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('vacation.subjectPlaceholder')} />
          </Field>
          <Field label={t('vacation.message')}>
            <textarea
              className={`${inputCls} h-36 resize-y py-2 leading-relaxed`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('vacation.messagePlaceholder')}
            />
          </Field>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {t('vacation.save')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Répondeur dans le script géré (`# voxel-vacation v1`) ; dates `AAAA-MM-JJ` si `date` et `relational`. */
function ManagedVacationForm({ accountId, state, picker }: { accountId: string; state: SieveState; picker: ReactNode }) {
  const { t } = useTranslation('settings');
  const v: ManagedVacation = state.managed.vacation ?? { enabled: false, subject: '', text: '', days: 7 };
  const dates = vacationSupport(state.extensions).dates;
  const [enabled, setEnabled] = useState(v.enabled);
  const [start, setStart] = useState(v.start ?? '');
  const [end, setEnd] = useState(v.end ?? '');
  const [subject, setSubject] = useState(v.subject);
  const [body, setBody] = useState(v.text);
  const [days, setDays] = useState(String(v.days));
  const [busy, setBusy] = useState(false);
  const editable = state.mode === 'managed' || state.mode === 'none';

  useEffect(() => {
    setEnabled(v.enabled);
    setStart(v.start ?? '');
    setEnd(v.end ?? '');
    setSubject(v.subject);
    setBody(v.text);
    setDays(String(v.days));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.managed.vacation]);

  const save = async () => {
    if (enabled && !body.trim()) {
      toast.error(t('vacation.textRequired'));
      return;
    }
    if (start && end && end < start) {
      toast.error(t('vacation.badDates'));
      return;
    }
    setBusy(true);
    try {
      const vacation: ManagedVacation = {
        enabled,
        subject,
        text: body,
        days: Math.max(1, Number(days) || 7),
        ...(dates && start ? { start } : {}),
        ...(dates && end ? { end } : {}),
      };
      const r = await saveManaged(accountId, (m) => ({ ...m, vacation }));
      if (r.pendingActivation) toast.warning(t('filters.savedPending'));
      else toast.success(enabled ? t('vacation.enabledToast') : t('vacation.savedToast'));
    } catch (e) {
      toast.error(t('vacation.saveFailed'), { description: sieveErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const takeOver = async () => {
    setBusy(true);
    try {
      await takeOverVacation(accountId);
      toast.success(t('sieve.takenOver'));
    } catch (e) {
      toast.error(t('vacation.saveFailed'), { description: sieveErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[640px]">
      <SectionIntro>{t('vacation.introSieve')}</SectionIntro>
      {picker}
      <div className="space-y-4">
        <SieveBanners state={state} busy={busy} onTakeOver={takeOver} />
        {!editable && <p className="rounded-lg border border-line p-3 text-[12.5px] text-text-2">{t('vacation.manualScript')}</p>}
        <label className="flex items-center justify-between rounded-xl border border-line p-4">
          <div>
            <div className="text-[13.5px] font-medium text-text-1">{t('vacation.enable')}</div>
            <div className="text-[12.5px] text-text-2">{enabled ? t('vacation.enabledHintSieve') : t('vacation.disabled')}</div>
          </div>
          <Switch checked={enabled} disabled={!editable} onCheckedChange={setEnabled} className="data-[state=checked]:bg-voxel-accent" />
        </label>
        {dates && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('vacation.fromDay')}>
              <input type="date" className={inputCls} value={start} disabled={!editable} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label={t('vacation.toDay')}>
              <input type="date" className={inputCls} value={end} disabled={!editable} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
          <Field label={t('vacation.subject')}>
            <input className={inputCls} dir="auto" value={subject} disabled={!editable} onChange={(e) => setSubject(e.target.value)} placeholder={t('vacation.subjectPlaceholder')} />
          </Field>
          <Field label={t('vacation.days')} hint={t('vacation.daysHint')}>
            <input type="number" min={1} max={365} className={inputCls} value={days} disabled={!editable} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
        <Field label={t('vacation.message')}>
          <textarea
            dir="auto"
            className={`${inputCls} h-36 resize-y py-2 leading-relaxed`}
            value={body}
            disabled={!editable}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('vacation.messagePlaceholder')}
          />
        </Field>
        <Button onClick={save} disabled={busy || !editable}>
          {busy && <Loader2 className="animate-spin" />}
          {t('vacation.save')}
        </Button>
      </div>
    </div>
  );
}
