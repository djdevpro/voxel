/**
 * « Ajouter aux contacts » depuis le lecteur : expéditeur ou destinataire → nouvelle fiche
 * (nom, adresse) dans un carnet de la boîte du message. Ouvert par `openAddContact()`.
 */
import { useEffect, useId, useState } from 'react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAccount } from '@/hooks/useData';
import { createCard, findCardByEmail, useAddressBooks } from '@/lib/contacts';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { openContact } from '@/nav/nav';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { inputCls } from '@/components/settings/ui';

interface AddRequest {
  accountId: string;
  name: string;
  email: string;
}

const useAddContact = create<{ req: AddRequest | null; set: (r: AddRequest | null) => void }>()((set) => ({ req: null, set: (req) => set({ req }) }));

/** Ouvre le dialogue ; si l'adresse est déjà une fiche de la boîte, ouvre directement la fiche. */
export async function openAddContact(req: AddRequest & { mailboxEmail: string }) {
  const existing = await findCardByEmail(req.accountId, req.email);
  if (existing) {
    openContact(req.mailboxEmail, existing.id);
    return;
  }
  useAddContact.getState().set({ accountId: req.accountId, name: req.name, email: req.email });
}

export function AddContactDialog() {
  const { t } = useTranslation('contacts');
  const id = useId();
  const req = useAddContact((s) => s.req);
  const close = () => useAddContact.getState().set(null);
  const account = useAccount(req?.accountId);
  const books = useAddressBooks(req ? [req.accountId] : []);
  const writable = (books ?? []).filter((b) => b.book.myRights?.mayWrite !== false);
  const [name, setName] = useState('');
  const [bookId, setBookId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (req) setName(req.name);
  }, [req]);
  useEffect(() => {
    if (writable.length && !writable.some((b) => b.id === bookId)) setBookId((writable.find((b) => b.book.isDefault) ?? writable[0])!.id);
  }, [writable, bookId]);

  const save = async () => {
    if (!req || !account || !bookId) return;
    setBusy(true);
    try {
      const full = name.trim();
      const r = await createCard(req.accountId, bookId, { ...(full ? { name: { full } } : {}), emails: { e1: { address: req.email } } });
      close();
      toast.success(r.queued ? t('toast.queued') : t('reader.added', { name: full || req.email }), {
        action: r.queued ? undefined : { label: t('reader.open'), onClick: () => openContact(account.email, r.id) },
      });
    } catch (e) {
      toast.error(t('toast.failed'), { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('reader.addTitle')}</DialogTitle>
          <DialogDescription dir="ltr" className="text-start">
            {req?.email}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="block" htmlFor={`${id}-name`}>
            <span className="mb-1 block text-[12px] font-medium text-text-2">{t('fields.full')}</span>
            <input id={`${id}-name`} autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} dir="auto" />
          </label>
          {writable.length > 1 && (
            <label className="block" htmlFor={`${id}-book`}>
              <span className="mb-1 block text-[12px] font-medium text-text-2">{t('fields.book')}</span>
              <select id={`${id}-book`} className={cn(inputCls, 'pe-7')} value={bookId} onChange={(e) => setBookId(e.target.value)}>
                {writable.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.book.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!writable.length && <p className="text-[12.5px] text-text-3">{t('reader.noBook')}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !bookId}>
              {t('reader.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
