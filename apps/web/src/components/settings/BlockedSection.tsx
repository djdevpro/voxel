import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Loader2 } from 'lucide-react';
import { normalizeAddress, normalizeDomain } from '@voxel/jmap';
import { useAccounts } from '@/hooks/useData';
import { ALL } from '@/store/ui';
import { useSettingsMailbox } from '@/nav/useSettingsMailbox';
import { blockSender, blocklistErrorMessage, blocklistQuery, saveBlocklist, unblock } from '@/lib/blocklist';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { AccountDot } from '@/components/common/bits';
import { Field, SectionIntro, inputCls } from './ui';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/lib/api';

type Entry = { address?: string; domain?: string };

export function BlockedSection() {
  const { t } = useTranslation('settings');
  const { data: all } = useAccounts();
  // seules les boîtes qui annoncent JMAP for Sieve (filtre côté serveur)
  const accounts = (all ?? []).filter((a) => a.capabilities?.sieve);
  const viewAccount = useSettingsMailbox();
  const [accountId, setAccountId] = useState(() => (viewAccount !== ALL && accounts.some((a) => a.id === viewAccount) ? viewAccount : accounts[0]?.id ?? ''));
  const { data, isLoading, error } = useQuery({ ...blocklistQuery(accountId), enabled: !!accountId });
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(t('blocked.failed'), { description: blocklistErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const add = () => {
    const address = normalizeAddress(value);
    const domain = address ? null : normalizeDomain(value);
    if (!address && !domain) {
      setInvalid(true);
      return;
    }
    const entry: Entry = address ? { address } : { domain: domain! };
    void run('add', async () => {
      await blockSender(accountId, entry);
      setValue('');
    }, t('blocked.blockedToast', { who: address ?? domain }));
  };

  const remove = (entry: Entry) =>
    run(`rm:${entry.address ?? entry.domain}`, () => unblock(accountId, entry), t('blocked.unblockedToast', { who: entry.address ?? entry.domain }));

  const rows: Array<{ key: string; label: string; entry: Entry }> = [
    ...(data?.list.addresses ?? []).map((a) => ({ key: `a:${a}`, label: a, entry: { address: a } })),
    ...(data?.list.domains ?? []).map((d) => ({ key: `d:${d}`, label: d, entry: { domain: d } })),
  ];

  return (
    <div className="max-w-[640px]">
      <SectionIntro>{t('blocked.intro')}</SectionIntro>
      <div className="mb-5 max-w-xs">
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger className="w-full" aria-label={t('blocked.mailbox')}>
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
      {isLoading ? (
        <div className="space-y-3">
          <div className="voxel-skeleton h-10" />
          <div className="voxel-skeleton h-24" />
        </div>
      ) : error ? (
        <p className="text-[13px] text-danger">{t('blocked.unavailable', { message: errorMessage(error) })}</p>
      ) : !data?.supported ? (
        <p className="text-[13px] text-text-2">{t('blocked.unsupported')}</p>
      ) : (
        <div className="space-y-4">
          {data.activeOther === 'vacation' ? (
            <p className="rounded-lg border border-line bg-hover px-3 py-2 text-[12.5px] text-text-2">{t('blocked.vacationActive')}</p>
          ) : data.activeOther !== null ? (
            <p className="rounded-lg border border-line bg-hover px-3 py-2 text-[12.5px] text-text-2">{t('blocked.otherActive', { name: data.activeOther })}</p>
          ) : null}
          {data.corrupted && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/40 px-3 py-2">
              <p className="text-[12.5px] text-danger">{t('blocked.corrupted')}</p>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('reset', () => saveBlocklist(accountId, { addresses: [], domains: [] }))}>
                {busy === 'reset' && <Loader2 className="animate-spin" />}
                {t('blocked.reset')}
              </Button>
            </div>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <div className="flex-1">
              <Field label={t('blocked.label')}>
                <input
                  className={inputCls}
                  value={value}
                  aria-invalid={invalid || undefined}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setInvalid(false);
                  }}
                  placeholder={t('blocked.placeholder')}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </div>
            <Button type="submit" disabled={!!busy || !value.trim() || data.corrupted}>
              {busy === 'add' ? <Loader2 className="animate-spin" /> : <Ban />}
              {t('blocked.block')}
            </Button>
          </form>
          {invalid && <p className="-mt-2 text-[12.5px] text-danger">{t('blocked.invalid')}</p>}
          {rows.length === 0 ? (
            <p className="text-[13px] text-text-3">{t('blocked.empty')}</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {rows.map((r) => (
                <li key={r.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0 truncate text-[13.5px] text-text-1">{r.label}</span>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void remove(r.entry)}>
                    {busy === `rm:${r.entry.address ?? r.entry.domain}` && <Loader2 className="animate-spin" />}
                    {t('blocked.unblock')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
