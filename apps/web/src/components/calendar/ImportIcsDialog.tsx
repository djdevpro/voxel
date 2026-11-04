/**
 * Import `.ics` : fichier → `CalendarEvent/parse` (ou analyse côté client) → aperçu, doublons repérés
 * par `uid` (ignorer / remplacer / garder les deux) → `CalendarEvent/set` dans l'agenda choisi.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FileUp } from 'lucide-react';
import { eventSpan } from '@voxel/jmap';
import type { Account } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { calKey, importEvents, MAX_ICS_BYTES, parseIcsForImport, type IcsDuplicateAction, type IcsImportItem } from '@/lib/calendar';
import type { CalendarRow } from '@/lib/db';
import { cn } from '@/lib/utils';
import { currentLocale } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { inputCls, Segmented } from '@/components/settings/ui';

export function ImportIcsDialog({ open, onOpenChange, accounts, calendars }: { open: boolean; onOpenChange: (o: boolean) => void; accounts: Account[]; calendars: CalendarRow[] }) {
  const { t } = useTranslation('calendar');
  const id = useId();
  const lang = currentLocale();
  const writable = calendars.filter((c) => c.calendar.myRights?.mayWriteAll !== false);
  const [target, setTarget] = useState('');
  const [items, setItems] = useState<Array<IcsImportItem & { action: IcsDuplicateAction }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [dupAction, setDupAction] = useState<IcsDuplicateAction>('skip');

  useEffect(() => {
    if (!open) {
      setItems(null);
      setBusy(false);
      return;
    }
    if (!target || !writable.some((c) => calKey(c.accountId, c.id) === target)) {
      const c = writable.find((x) => x.calendar.isDefault) ?? writable[0];
      setTarget(c ? calKey(c.accountId, c.id) : '');
    }
  }, [open, writable.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const accountId = target.slice(0, target.indexOf(':'));
  const calendarId = target.slice(target.indexOf(':') + 1);
  const account = accounts.find((a) => a.id === accountId);

  const onFile = async (f: File | undefined) => {
    if (!f || !account) return;
    if (f.size > MAX_ICS_BYTES) {
      toast.error(t('import.tooLarge'));
      return;
    }
    setBusy(true);
    try {
      const { items: list } = await parseIcsForImport(account.id, await f.text());
      if (!list.length) toast.error(t('import.empty'));
      setItems(list.map((it) => ({ ...it, action: dupAction })));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!items || !account) return;
    setBusy(true);
    try {
      const r = await importEvents(account, calendarId, items.map((it) => ({ ...it, action: it.duplicate ? dupAction : 'both' })));
      toast.success(r.queued ? t('toast.queued') : t('import.done', { created: r.created, replaced: r.replaced, skipped: r.skipped }));
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const dups = items?.filter((i) => i.duplicate).length ?? 0;
  const fmt = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' });
  const fmtDay = new Intl.DateTimeFormat(lang, { dateStyle: 'medium' });

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t('import.title')}</DialogTitle>
          <DialogDescription>{t('import.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label htmlFor={`${id}-cal`} className="block text-[12.5px] font-medium text-text-2">
            {t('import.into')}
          </label>
          <select id={`${id}-cal`} className={inputCls} value={target} onChange={(e) => setTarget(e.target.value)} disabled={!!items}>
            {writable.map((c) => (
              <option key={calKey(c.accountId, c.id)} value={calKey(c.accountId, c.id)}>
                {accounts.length > 1 ? `${c.calendar.name} — ${accounts.find((a) => a.id === c.accountId)?.email ?? ''}` : c.calendar.name}
              </option>
            ))}
          </select>
          {!items ? (
            <label
              htmlFor={`${id}-file`}
              className={cn('flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-text-2 voxel-transition hover:border-text-3 focus-within:ring-2 focus-within:ring-voxel-accent', busy && 'pointer-events-none opacity-60')}
            >
              <FileUp className="size-6 text-text-3" />
              {busy ? t('import.reading') : t('import.choose')}
              <input id={`${id}-file`} type="file" accept=".ics,text/calendar" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} disabled={busy || !target} />
            </label>
          ) : (
            <>
              <p className="text-[13px] text-text-2">{t('import.found', { count: items.length })}</p>
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line p-1.5">
                {items.map((it, i) => {
                  let when = '';
                  try {
                    const s = eventSpan(it.event);
                    when = it.event.showWithoutTime ? fmtDay.format(s.start) : fmt.format(s.start);
                  } catch {
                    when = '';
                  }
                  return (
                    <li key={i} className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px]">
                      <span className="min-w-0 flex-1 truncate text-text-1" dir="auto">
                        {it.event.title || t('untitled')}
                      </span>
                      <span className="shrink-0 text-[12px] text-text-3 tabular-nums">{when}</span>
                      {it.duplicate && <span className="shrink-0 rounded bg-black/[0.06] px-1.5 text-[11px] text-text-2 dark:bg-white/[0.08]">{t('import.duplicate')}</span>}
                    </li>
                  );
                })}
              </ul>
              {!!dups && (
                <div className="space-y-1.5">
                  <p className="text-[12.5px] text-text-2">{t('import.duplicates', { count: dups })}</p>
                  <Segmented
                    value={dupAction}
                    onChange={setDupAction}
                    options={[
                      { value: 'skip', label: t('import.skip') },
                      { value: 'replace', label: t('import.replace') },
                      { value: 'both', label: t('import.both') },
                    ]}
                  />
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={() => void run()} disabled={!items?.length || busy}>
            {t('import.run')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
