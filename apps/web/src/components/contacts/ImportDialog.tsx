/**
 * Import `.vcf` : fichier (un ou plusieurs contacts) → upload → `ContactCard/parse` → aperçu
 * (doublons repérés par adresse e-mail : ignorer / remplacer / garder les deux) → `ContactCard/set`.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FileUp } from 'lucide-react';
import { cardDisplayName, cardEmails } from '@voxel/jmap';
import type { Account } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { importCards, MAX_VCF_BYTES, parseVcfForImport, useAddressBooks, type DuplicateAction, type ImportItem } from '@/lib/contacts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { inputCls, Segmented } from '@/components/settings/ui';

export function ImportDialog({
  open,
  onOpenChange,
  accounts,
  defaultAccountId,
  defaultBookId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accounts: Account[];
  defaultAccountId?: string;
  defaultBookId?: string;
}) {
  const { t } = useTranslation('contacts');
  const id = useId();
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? '');
  const books = useAddressBooks(accountId ? [accountId] : []);
  const writable = (books ?? []).filter((b) => b.book.myRights?.mayWrite !== false);
  const [bookId, setBookId] = useState('');
  const [items, setItems] = useState<Array<ImportItem & { action: DuplicateAction }> | null>(null);
  const [invalid, setInvalid] = useState(0);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState<DuplicateAction>('skip');

  useEffect(() => {
    if (!open) return;
    setAccountId(defaultAccountId ?? accounts[0]?.id ?? '');
    setItems(null);
    setInvalid(0);
    setProgress(null);
    setAll('skip');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!writable.length) return;
    if (!writable.some((b) => b.id === bookId)) setBookId((defaultBookId && writable.some((b) => b.id === defaultBookId) ? defaultBookId : (writable.find((b) => b.book.isDefault) ?? writable[0])!.id));
  }, [writable, bookId, defaultBookId]);

  const dupCount = useMemo(() => (items ?? []).filter((i) => i.duplicate).length, [items]);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_VCF_BYTES) {
      toast.error(t('importDialog.tooLarge'));
      return;
    }
    setBusy(true);
    setItems(null);
    try {
      const text = await file.text();
      const r = await parseVcfForImport(accountId, text, (done, total) => setProgress(t('importDialog.progress', { done, total })));
      setItems(r.items.map((it) => ({ ...it, action: it.duplicate ? all : 'both' })));
      setInvalid(r.invalid);
      if (!r.items.length) toast.error(t('importDialog.empty'));
    } catch (e) {
      toast.error(t('importDialog.failed'), { description: errorMessage(e) });
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  const setAction = (i: number, action: DuplicateAction) => setItems((list) => list && list.map((x, j) => (j === i ? { ...x, action } : x)));
  const applyAll = (action: DuplicateAction) => {
    setAll(action);
    setItems((list) => list && list.map((x) => (x.duplicate ? { ...x, action } : x)));
  };

  const run = async () => {
    if (!items?.length || !bookId) return;
    setBusy(true);
    try {
      const r = await importCards(accountId, bookId, items);
      toast.success(r.queued ? t('toast.queued') : t('importDialog.done', { created: r.created, replaced: r.replaced, skipped: r.skipped }));
      onOpenChange(false);
    } catch (e) {
      toast.error(t('importDialog.failed'), { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const actions: Array<{ value: DuplicateAction; label: string }> = [
    { value: 'skip', label: t('importDialog.skip') },
    { value: 'replace', label: t('importDialog.replace') },
    { value: 'both', label: t('importDialog.both') },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t('importDialog.title')}</DialogTitle>
          <DialogDescription>{t('importDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {accounts.length > 1 && (
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-text-2">{t('importDialog.mailbox')}</span>
                <select className={cn(inputCls, 'pe-7')} value={accountId} disabled={busy || !!items} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName || a.email}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-text-2">{t('importDialog.target')}</span>
              <select className={cn(inputCls, 'pe-7')} value={bookId} disabled={busy} onChange={(e) => setBookId(e.target.value)}>
                {writable.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.book.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!items && (
            <label
              htmlFor={`${id}-file`}
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-text-2 voxel-transition hover:border-text-3 focus-within:ring-2 focus-within:ring-voxel-accent"
            >
              <FileUp className="size-6 text-text-3" />
              <span>{progress ?? (busy ? t('importDialog.parsing') : t('importDialog.choose'))}</span>
              <input id={`${id}-file`} type="file" accept=".vcf,.vcard,text/vcard,text/x-vcard" className="sr-only" disabled={busy || !accountId} onChange={(e) => void readFile(e.target.files?.[0])} />
            </label>
          )}

          {items && (
            <div className="space-y-3">
              <p className="text-[13px] text-text-2" aria-live="polite">
                {t('importDialog.found', { count: items.length })}
                {dupCount > 0 && ` · ${t('importDialog.duplicates', { count: dupCount })}`}
                {invalid > 0 && ` · ${t('importDialog.invalid', { count: invalid })}`}
              </p>
              {dupCount > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-2">
                  <span>{t('importDialog.applyAll')}</span>
                  <Segmented value={all} onChange={applyAll} options={actions} />
                </div>
              )}
              <ul className="max-h-[300px] divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {items.map((it, i) => (
                  <li key={i} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div dir="auto" className="truncate text-[13px] font-medium text-text-1">
                        {cardDisplayName(it.card) || t('unnamed')}
                      </div>
                      <div className="truncate text-[11.5px] text-text-3">
                        {it.duplicate ? t('importDialog.duplicateOf', { name: cardDisplayName(it.duplicate.card) || it.duplicate.emails[0] }) : (cardEmails(it.card)[0] ?? '')}
                      </div>
                    </div>
                    {it.duplicate && (
                      <select className={cn(inputCls, 'h-8 w-auto pe-7 text-[12.5px]')} aria-label={t('importDialog.actionFor', { name: cardDisplayName(it.card) })} value={it.action} onChange={(e) => setAction(i, e.target.value as DuplicateAction)}>
                        {actions.map((a) => (
                          <option key={a.value} value={a.value}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          {items && (
            <Button disabled={busy || !items.length || !bookId} onClick={() => void run()}>
              {t('importDialog.run', { count: items.filter((x) => !(x.duplicate && x.action === 'skip')).length })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
