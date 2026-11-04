/**
 * Fiche de contact : lecture, modification, création (`…/new`), suppression, déplacement d'un
 * carnet à l'autre, appartenance aux groupes ; pour un groupe : nom, membres (ajout, retrait), écrire au groupe.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Building2, Cake, Download, ImagePlus, Link2, Mail, MapPin, MoreHorizontal, NotebookPen, PenLine, Phone, Plus, Trash2, UserMinus, Users, X } from 'lucide-react';
import { CAP, cardDisplayName, cardEmails, expandGroup, foldText, groupMembers, sameUid, type ContactCard } from '@voxel/jmap';
import type { Account } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import type { BookRow, CardRow } from '@/lib/db';
import { createCard, deleteCards, exportCards, setGroupMembers, updateCard } from '@/lib/contacts';
import { jmap } from '@/lib/jmap';
import { useBlobUrl } from '@/lib/blobs';
import { currentLocale } from '@/i18n';
import { tFast } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { closeContact, contactsTarget, goTarget, openContact } from '@/nav/nav';
import { confirmDialog } from '@/store/confirm';
import { startCompose } from '@/components/compose/startCompose';
import { IconButton, SenderAvatar } from '@/components/common/bits';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { inputCls } from '@/components/settings/ui';
import { applyForm, emptyForm, formFromCard, formHasIdentity, parseBirthday, type ContactForm, type EmailKind, type PhoneKind } from './contactForm';

const MAX_PHOTO = 512 * 1024;

/** Compte JMAP des contacts (pour télécharger une photo stockée en blob). */
function useContactsJmapId(accountId: string): string {
  const { data } = useQuery({ queryKey: ['contacts-aid', accountId], queryFn: () => jmap(accountId).accountId(CAP.contacts), staleTime: Infinity });
  return data ?? '';
}

export function ContactPhoto({ accountId, card, size }: { accountId: string; card: ContactCard; size: number }) {
  const photo = Object.values(card.media ?? {}).find((m) => m.kind === 'photo');
  const aid = useContactsJmapId(accountId);
  const blobUrl = useBlobUrl(accountId, aid, photo?.uri ? null : photo?.blobId, 'photo', photo?.mediaType);
  const src = photo?.uri && /^(data:image\/|https:)/.test(photo.uri) ? photo.uri : blobUrl;
  const name = cardDisplayName(card);
  if (src) return <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} referrerPolicy="no-referrer" />;
  if (card.kind === 'group')
    return (
      <span className="flex shrink-0 items-center justify-center rounded-full bg-voxel-accent-soft text-text-2" style={{ width: size, height: size }} aria-hidden>
        <Users className="size-1/2" />
      </span>
    );
  return <SenderAvatar name={name} email={cardEmails(card)[0] ?? name} size={size} />;
}

function Section({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2.5">
      <span className="mt-0.5 text-text-3 [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-[11.5px] font-medium tracking-wide text-text-3 uppercase">{label}</div>
        {children}
      </div>
    </div>
  );
}

function formatBirthday(d: { year?: number; month?: number; day?: number } | undefined): string {
  if (!d?.month || !d.day) return d?.year ? String(d.year) : '';
  const date = new Date(Date.UTC(d.year ?? 2000, d.month - 1, d.day));
  return new Intl.DateTimeFormat(currentLocale(), { day: 'numeric', month: 'long', ...(d.year ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(date);
}

// ------------------------------------------------------------------ lecture

function ContactView({ account, row, rows, books, onEdit }: { account: Account; row: CardRow; rows: CardRow[]; books: BookRow[]; onEdit: () => void }) {
  const { t } = useTranslation('contacts');
  const card = row.card;
  const name = cardDisplayName(card) || t('unnamed');
  const org = Object.values(card.organizations ?? {})[0]?.name;
  const title = Object.values(card.titles ?? {})[0]?.name;
  const birth = Object.values(card.anniversaries ?? {}).find((a) => a.kind === 'birth');
  const groups = rows.filter((r) => r.kind === 'group');
  const book = books.find((b) => row.bookIds.includes(b.id));
  const pending = row.id.startsWith('local-');
  const kindLabel = (ctx: Record<string, boolean> | undefined) => (ctx?.private ? t('kinds.home') : ctx?.work ? t('kinds.work') : '');
  const write = (address: string) => startCompose({ accountId: account.id, to: [{ name: cardDisplayName(card) || null, email: address }] });

  const remove = async () => {
    const ok = await confirmDialog({ title: t('deleteOne.title', { name }), description: t('deleteOne.description'), confirmLabel: t('delete'), destructive: true });
    if (!ok) return;
    try {
      const r = await deleteCards(account.id, [row.id]);
      toast.success(r.queued ? t('toast.queued') : t('toast.deleted'));
      closeContact({ replace: true });
    } catch (e) {
      toast.error(t('toast.failed'), { description: errorMessage(e) });
    }
  };

  const toggleGroup = async (g: CardRow, on: boolean) => {
    if (!card.uid) return;
    try {
      const r = await setGroupMembers(account.id, g.card, [card.uid], on);
      if (r.queued) toast(t('toast.queued'));
    } catch (e) {
      toast.error(t('toast.failed'), { description: errorMessage(e) });
    }
  };

  return (
    <div className="mx-auto w-full max-w-[640px] px-6 py-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <ContactPhoto accountId={account.id} card={card} size={64} />
        <div className="min-w-[160px] flex-1">
          <h2 dir="auto" className="truncate text-[20px] font-semibold text-text-1">
            {name}
          </h2>
          {(title || org) && (
            <p dir="auto" className="truncate text-[13px] text-text-2">
              {[title, org].filter(Boolean).join(' · ')}
            </p>
          )}
          {pending && <p className="text-[12px] text-text-3">{t('pendingSync')}</p>}
        </div>
        <div className="flex items-center gap-1">
          {!!row.emails.length && (
            <IconButton label={t('write')} onClick={() => write(cardEmails(card)[0]!)}>
              <PenLine />
            </IconButton>
          )}
          <Button variant="secondary" size="sm" onClick={onEdit} disabled={pending}>
            {t('edit')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={t('moreActions')}>
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => void exportCards([card], `${name.replace(/[\\/:*?"<>|]/g, '_') || 'contact'}.vcf`)}>
                <Download /> {t('exportOne')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                <Trash2 /> {t('delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-5 divide-y divide-line">
        {!!Object.keys(card.emails ?? {}).length && (
          <Section icon={<Mail />} label={t('fields.emails')}>
            {Object.values(card.emails ?? {}).map((e) => (
              <div key={e.address} className="flex items-baseline gap-2">
                <button type="button" onClick={() => write(e.address)} className="truncate text-[13.5px] text-voxel-accent-strong hover:underline focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none" dir="ltr">
                  {e.address}
                </button>
                {kindLabel(e.contexts) && <span className="text-[12px] text-text-3">{kindLabel(e.contexts)}</span>}
              </div>
            ))}
          </Section>
        )}
        {!!Object.keys(card.phones ?? {}).length && (
          <Section icon={<Phone />} label={t('fields.phones')}>
            {Object.values(card.phones ?? {}).map((p) => (
              <div key={p.number} className="flex items-baseline gap-2">
                <a href={`tel:${p.number.replace(/[^\d+]/g, '')}`} className="text-[13.5px] text-text-1 hover:underline" dir="ltr">
                  {p.number}
                </a>
                <span className="text-[12px] text-text-3">{p.features?.mobile ? t('kinds.mobile') : p.features?.fax ? t('kinds.fax') : kindLabel(p.contexts)}</span>
              </div>
            ))}
          </Section>
        )}
        {!!Object.keys(card.addresses ?? {}).length && (
          <Section icon={<MapPin />} label={t('fields.addresses')}>
            {Object.values(card.addresses ?? {}).map((a, i) => (
              <p key={i} dir="auto" className="text-[13.5px] whitespace-pre-line text-text-1">
                {a.full ||
                  [
                    (a.components ?? []).filter((c) => ['number', 'name', 'apartment', 'building', 'floor', 'room', 'postOfficeBox'].includes(c.kind)).map((c) => c.value).join(' '),
                    (a.components ?? []).filter((c) => ['postcode', 'locality'].includes(c.kind)).map((c) => c.value).join(' '),
                    (a.components ?? []).filter((c) => ['region', 'country'].includes(c.kind)).map((c) => c.value).join(', '),
                  ]
                    .filter(Boolean)
                    .join('\n')}
                {kindLabel(a.contexts) && <span className="ms-2 text-[12px] text-text-3">{kindLabel(a.contexts)}</span>}
              </p>
            ))}
          </Section>
        )}
        {org && (
          <Section icon={<Building2 />} label={t('fields.org')}>
            <p dir="auto" className="text-[13.5px] text-text-1">
              {[org, title].filter(Boolean).join(' — ')}
            </p>
          </Section>
        )}
        {birth && (
          <Section icon={<Cake />} label={t('fields.birthday')}>
            <p className="text-[13.5px] text-text-1">{formatBirthday(birth.date as { year?: number; month?: number; day?: number })}</p>
          </Section>
        )}
        {!!Object.keys(card.links ?? {}).length && (
          <Section icon={<Link2 />} label={t('fields.website')}>
            {Object.values(card.links ?? {}).map((l) => (
              <a key={l.uri} href={/^https?:\/\//i.test(l.uri) ? l.uri : undefined} target="_blank" rel="noopener noreferrer" className="block truncate text-[13.5px] text-voxel-accent-strong hover:underline" dir="ltr">
                {l.uri}
              </a>
            ))}
          </Section>
        )}
        {!!Object.keys(card.notes ?? {}).length && (
          <Section icon={<NotebookPen />} label={t('fields.note')}>
            {Object.values(card.notes ?? {}).map((n, i) => (
              <p key={i} dir="auto" className="text-[13.5px] whitespace-pre-wrap text-text-1">
                {n.note}
              </p>
            ))}
          </Section>
        )}
        <Section icon={<Users />} label={t('groups')}>
          {groups.length === 0 ? (
            <p className="text-[12.5px] text-text-3">{t('noGroups')}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {groups.map((g) => {
                const on = !!card.uid && Object.entries(g.card.members ?? {}).some(([u, v]) => v && sameUid(u, card.uid));
                return (
                  <button
                    key={g.id}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    disabled={!card.uid || pending || g.id.startsWith('local-')}
                    onClick={() => void toggleGroup(g, !on)}
                    className={cn(
                      'h-7 rounded-full border px-3 text-[12.5px] voxel-transition focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none disabled:opacity-50',
                      on ? 'border-voxel-accent bg-voxel-accent-soft text-text-1' : 'border-line-strong text-text-2 hover:text-text-1',
                    )}
                  >
                    {cardDisplayName(g.card) || t('unnamedGroup')}
                  </button>
                );
              })}
            </div>
          )}
        </Section>
        {book && (
          <p className="pt-3 text-[12px] text-text-3">
            {t('inBook', { book: book.book.name, mailbox: account.displayName || account.email })}
          </p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ formulaire

function Labeled({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-[12px] font-medium text-text-2">
        {label}
      </label>
      {children}
    </div>
  );
}

const selectCls = cn(inputCls, 'w-auto shrink-0 pe-7');

function ContactEditor({ account, row, books, defaultBookId, onDone }: { account: Account; row?: CardRow; books: BookRow[]; defaultBookId?: string; onDone: (id?: string) => void }) {
  const { t } = useTranslation('contacts');
  const id = useId();
  const writable = books.filter((b) => b.book.myRights?.mayWrite !== false);
  const initialBook = (defaultBookId && writable.some((b) => b.id === defaultBookId) ? defaultBookId : undefined) ?? (writable.find((b) => b.book.isDefault) ?? writable[0])?.id ?? '';
  const [f, setF] = useState<ContactForm>(() => (row ? formFromCard(row.card) : emptyForm(initialBook)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);
  const set = (patch: Partial<ContactForm>) => setF((x) => ({ ...x, ...patch }));
  const birthdayInvalid = parseBirthday(f.birthday) === null;

  const save = async () => {
    if (!formHasIdentity(f)) {
      setError(t('errors.needName'));
      return;
    }
    if (birthdayInvalid) {
      setError(t('errors.birthday'));
      return;
    }
    if (!f.bookId) {
      setError(t('errors.noBook'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (row) {
        const next = { ...applyForm(row.card, f), id: row.id } as ContactCard;
        const r = await updateCard(account.id, row.card, next);
        toast.success(r.queued ? t('toast.queued') : t('toast.saved'));
        onDone();
      } else {
        const next = applyForm({}, f);
        const r = await createCard(account.id, f.bookId, next);
        toast.success(r.queued ? t('toast.queued') : t('toast.created'));
        onDone(r.id);
      }
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const pickPhoto = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > MAX_PHOTO) {
      toast.error(t('fields.photoTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set({ photo: String(reader.result) });
    reader.readAsDataURL(file);
  };

  const preview = row ? ({ ...applyForm(row.card, { ...f, photo: f.photo }), id: row.id } as ContactCard) : ({ ...applyForm({}, f), id: 'new' } as ContactCard);
  const emailKinds: EmailKind[] = ['home', 'work', 'other'];
  const phoneKinds: PhoneKind[] = ['mobile', 'home', 'work', 'fax', 'other'];

  return (
    <form
      className="mx-auto w-full max-w-[640px] px-6 py-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          void save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <div className="mb-5 flex items-center gap-4">
        <ContactPhoto accountId={account.id} card={f.photo && f.photo !== 'keep' ? { ...preview, media: { p: { kind: 'photo', uri: f.photo } } } : f.photo ? preview : { ...preview, media: undefined }} size={64} />
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <ImagePlus /> {t('fields.choosePhoto')}
          </Button>
          {f.photo && (
            <Button type="button" variant="ghost" size="sm" onClick={() => set({ photo: '' })}>
              <X /> {t('fields.removePhoto')}
            </Button>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => pickPhoto(e.target.files?.[0])} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label={t('fields.given')} htmlFor={`${id}-given`}>
          <input ref={firstRef} id={`${id}-given`} className={inputCls} value={f.given} onChange={(e) => set({ given: e.target.value })} dir="auto" autoComplete="off" />
        </Labeled>
        <Labeled label={t('fields.surname')} htmlFor={`${id}-surname`}>
          <input id={`${id}-surname`} className={inputCls} value={f.surname} onChange={(e) => set({ surname: e.target.value })} dir="auto" autoComplete="off" />
        </Labeled>
        <Labeled label={t('fields.full')} htmlFor={`${id}-full`}>
          <input id={`${id}-full`} className={inputCls} value={f.full} placeholder={[f.given, f.surname].filter(Boolean).join(' ')} onChange={(e) => set({ full: e.target.value })} dir="auto" autoComplete="off" />
        </Labeled>
        <Labeled label={t('fields.nickname')} htmlFor={`${id}-nick`}>
          <input id={`${id}-nick`} className={inputCls} value={f.nickname} onChange={(e) => set({ nickname: e.target.value })} dir="auto" autoComplete="off" />
        </Labeled>
      </div>

      <fieldset className="mt-5">
        <legend className="mb-1.5 text-[12px] font-medium text-text-2">{t('fields.emails')}</legend>
        <div className="space-y-2">
          {f.emails.map((e, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="email"
                className={inputCls}
                value={e.address}
                aria-label={t('fields.email', { n: i + 1 })}
                onChange={(ev) => set({ emails: f.emails.map((x, j) => (j === i ? { ...x, address: ev.target.value } : x)) })}
                dir="ltr"
                autoComplete="off"
              />
              <select className={selectCls} aria-label={t('fields.kind')} value={e.kind} onChange={(ev) => set({ emails: f.emails.map((x, j) => (j === i ? { ...x, kind: ev.target.value as EmailKind } : x)) })}>
                {emailKinds.map((k) => (
                  <option key={k} value={k}>
                    {t(`kinds.${k}`)}
                  </option>
                ))}
              </select>
              <IconButton label={t('fields.remove')} onClick={() => set({ emails: f.emails.filter((_, j) => j !== i) })}>
                <X />
              </IconButton>
            </div>
          ))}
        </div>
        <Button type="button" variant="ghost" size="sm" className="mt-1.5" onClick={() => set({ emails: [...f.emails, { address: '', kind: 'other' }] })}>
          <Plus /> {t('fields.addEmail')}
        </Button>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="mb-1.5 text-[12px] font-medium text-text-2">{t('fields.phones')}</legend>
        <div className="space-y-2">
          {f.phones.map((p, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="tel"
                className={inputCls}
                value={p.number}
                aria-label={t('fields.phone', { n: i + 1 })}
                onChange={(ev) => set({ phones: f.phones.map((x, j) => (j === i ? { ...x, number: ev.target.value } : x)) })}
                dir="ltr"
                autoComplete="off"
              />
              <select className={selectCls} aria-label={t('fields.kind')} value={p.kind} onChange={(ev) => set({ phones: f.phones.map((x, j) => (j === i ? { ...x, kind: ev.target.value as PhoneKind } : x)) })}>
                {phoneKinds.map((k) => (
                  <option key={k} value={k}>
                    {t(`kinds.${k}`)}
                  </option>
                ))}
              </select>
              <IconButton label={t('fields.remove')} onClick={() => set({ phones: f.phones.filter((_, j) => j !== i) })}>
                <X />
              </IconButton>
            </div>
          ))}
        </div>
        <Button type="button" variant="ghost" size="sm" className="mt-1.5" onClick={() => set({ phones: [...f.phones, { number: '', kind: 'mobile' }] })}>
          <Plus /> {t('fields.addPhone')}
        </Button>
      </fieldset>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Labeled label={t('fields.org')} htmlFor={`${id}-org`}>
          <input id={`${id}-org`} className={inputCls} value={f.org} onChange={(e) => set({ org: e.target.value })} dir="auto" autoComplete="off" />
        </Labeled>
        <Labeled label={t('fields.jobTitle')} htmlFor={`${id}-title`}>
          <input id={`${id}-title`} className={inputCls} value={f.title} onChange={(e) => set({ title: e.target.value })} dir="auto" autoComplete="off" />
        </Labeled>
      </div>

      <fieldset className="mt-4">
        <legend className="mb-1.5 text-[12px] font-medium text-text-2">{t('fields.addresses')}</legend>
        <div className="space-y-3">
          {f.addresses.map((a, i) => {
            const upd = (patch: Partial<ContactForm['addresses'][number]>) => set({ addresses: f.addresses.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={i} className="space-y-2 rounded-lg border border-line p-2.5">
                <div className="flex gap-2">
                  <input className={inputCls} value={a.street} placeholder={t('fields.street')} aria-label={t('fields.street')} onChange={(e) => upd({ street: e.target.value })} dir="auto" />
                  <select className={selectCls} aria-label={t('fields.kind')} value={a.kind} onChange={(e) => upd({ kind: e.target.value as EmailKind })}>
                    {emailKinds.map((k) => (
                      <option key={k} value={k}>
                        {t(`kinds.${k}`)}
                      </option>
                    ))}
                  </select>
                  <IconButton label={t('fields.remove')} onClick={() => set({ addresses: f.addresses.filter((_, j) => j !== i) })}>
                    <X />
                  </IconButton>
                </div>
                <div className="grid grid-cols-[110px_1fr] gap-2">
                  <input className={inputCls} value={a.postcode} placeholder={t('fields.postcode')} aria-label={t('fields.postcode')} onChange={(e) => upd({ postcode: e.target.value })} dir="auto" />
                  <input className={inputCls} value={a.locality} placeholder={t('fields.locality')} aria-label={t('fields.locality')} onChange={(e) => upd({ locality: e.target.value })} dir="auto" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input className={inputCls} value={a.region} placeholder={t('fields.region')} aria-label={t('fields.region')} onChange={(e) => upd({ region: e.target.value })} dir="auto" />
                  <input className={inputCls} value={a.country} placeholder={t('fields.country')} aria-label={t('fields.country')} onChange={(e) => upd({ country: e.target.value })} dir="auto" />
                </div>
              </div>
            );
          })}
        </div>
        <Button type="button" variant="ghost" size="sm" className="mt-1.5" onClick={() => set({ addresses: [...f.addresses, { street: '', locality: '', region: '', postcode: '', country: '', kind: 'home' }] })}>
          <Plus /> {t('fields.addAddress')}
        </Button>
      </fieldset>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Labeled label={t('fields.birthday')} htmlFor={`${id}-bday`}>
          <input
            id={`${id}-bday`}
            className={inputCls}
            value={f.birthday}
            placeholder={t('fields.birthdayPlaceholder')}
            aria-invalid={birthdayInvalid || undefined}
            aria-describedby={`${id}-bday-hint`}
            onChange={(e) => set({ birthday: e.target.value })}
            dir="ltr"
            inputMode="numeric"
          />
          <span id={`${id}-bday-hint`} className="mt-1 block text-[11.5px] text-text-3">
            {t('fields.birthdayHint')}
          </span>
        </Labeled>
        <Labeled label={t('fields.website')} htmlFor={`${id}-web`}>
          <input id={`${id}-web`} type="url" className={inputCls} value={f.website} onChange={(e) => set({ website: e.target.value })} dir="ltr" />
        </Labeled>
      </div>

      <div className="mt-4">
        <Labeled label={t('fields.note')} htmlFor={`${id}-note`}>
          <textarea id={`${id}-note`} rows={3} className={cn(inputCls, 'h-auto py-2')} value={f.note} onChange={(e) => set({ note: e.target.value })} dir="auto" />
        </Labeled>
      </div>

      {writable.length > 1 && (
        <div className="mt-4">
          <Labeled label={t('fields.book')} htmlFor={`${id}-book`}>
            <select id={`${id}-book`} className={cn(inputCls, 'pe-7')} value={f.bookId} onChange={(e) => set({ bookId: e.target.value })}>
              {writable.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.book.name}
                </option>
              ))}
            </select>
          </Labeled>
        </div>
      )}

      <AnimatePresence>
        {error && (
          <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={tFast} role="alert" className="mt-4 text-[12.5px] text-danger">
            {error}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" disabled={busy}>
          {row ? t('save') : t('create')}
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ groupe

function GroupView({ account, row, rows }: { account: Account; row: CardRow; rows: CardRow[] }) {
  const { t } = useTranslation('contacts');
  const group = row.card;
  const [name, setName] = useState(cardDisplayName(group));
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const people = useMemo(() => rows.filter((r) => r.kind !== 'group'), [rows]);
  const members = useMemo(() => groupMembers(group, people), [group, people]);
  const pending = row.id.startsWith('local-');
  const candidates = useMemo(() => {
    const q = foldText(query);
    if (!q) return [];
    return people.filter((p) => p.uid && !members.includes(p) && p.search.includes(q)).slice(0, 6);
  }, [query, people, members]);
  useEffect(() => setName(cardDisplayName(group)), [group]);

  const rename = async () => {
    const next = name.trim();
    if (!next || next === cardDisplayName(group)) return;
    try {
      const r = await updateCard(account.id, group, { ...group, name: { ...(group.name ?? {}), full: next } });
      toast.success(r.queued ? t('toast.queued') : t('toast.saved'));
    } catch (e) {
      toast.error(t('toast.failed'), { description: errorMessage(e) });
    }
  };
  const change = async (uids: string[], on: boolean) => {
    try {
      const r = await setGroupMembers(account.id, group, uids, on);
      if (r.queued) toast(t('toast.queued'));
    } catch (e) {
      toast.error(t('toast.failed'), { description: errorMessage(e) });
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({ title: t('deleteGroup.title', { name: cardDisplayName(group) }), description: t('deleteGroup.description'), confirmLabel: t('delete'), destructive: true });
    if (!ok) return;
    try {
      const r = await deleteCards(account.id, [row.id]);
      toast.success(r.queued ? t('toast.queued') : t('toast.deleted'));
      goTarget(contactsTarget({ in: account.email.toLowerCase() }), { replace: true });
    } catch (e) {
      toast.error(t('toast.failed'), { description: errorMessage(e) });
    }
  };
  const recipients = expandGroup(group, people.map((p) => p.card));
  const uidOfMember = (m: CardRow) => Object.keys(group.members ?? {}).find((u) => sameUid(u, m.uid)) ?? m.uid!;

  return (
    <div className="mx-auto w-full max-w-[640px] px-6 py-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <ContactPhoto accountId={account.id} card={group} size={56} />
        <form
          className="min-w-[160px] flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <label className="sr-only" htmlFor="group-name">
            {t('groupName')}
          </label>
          <input
            id="group-name"
            value={name}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void rename()}
            dir="auto"
            className="w-full rounded-md bg-transparent px-1 text-[20px] font-semibold text-text-1 outline-none voxel-transition hover:bg-black/[0.03] focus:bg-panel focus:ring-2 focus:ring-voxel-accent dark:hover:bg-white/[0.04]"
          />
          <p className="px-1 text-[12.5px] text-text-3">{t('membersCount', { count: members.length })}</p>
        </form>
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" disabled={!recipients.length} onClick={() => startCompose({ accountId: account.id, to: recipients.map((r) => ({ name: r.name, email: r.email })) })}>
            <PenLine /> {t('writeGroup')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={t('moreActions')}>
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => void exportCards([group, ...members.map((m) => m.card)], `${cardDisplayName(group).replace(/[\\/:*?"<>|]/g, '_') || 'group'}.vcf`)}>
                <Download /> {t('exportGroup')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                <Trash2 /> {t('deleteGroupAction')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="relative mt-6">
        <label htmlFor="group-add" className="mb-1 block text-[12px] font-medium text-text-2">
          {t('addMember')}
        </label>
        <input
          id="group-add"
          role="combobox"
          aria-expanded={candidates.length > 0}
          aria-controls="group-add-list"
          aria-activedescendant={candidates[hi] ? `group-add-${candidates[hi]!.id}` : undefined}
          className={inputCls}
          value={query}
          disabled={pending}
          placeholder={t('addMemberPlaceholder')}
          onChange={(e) => {
            setQuery(e.target.value);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && candidates.length) {
              e.preventDefault();
              setHi((h) => (h + 1) % candidates.length);
            } else if (e.key === 'ArrowUp' && candidates.length) {
              e.preventDefault();
              setHi((h) => (h - 1 + candidates.length) % candidates.length);
            } else if (e.key === 'Enter' && candidates[hi]) {
              e.preventDefault();
              void change([candidates[hi]!.uid!], true);
              setQuery('');
            }
          }}
          dir="auto"
          autoComplete="off"
        />
        {candidates.length > 0 && (
          <div id="group-add-list" role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 rounded-xl border border-(--voxel-float-border) bg-popover p-1 shadow-(--voxel-float-shadow)">
            {candidates.map((c, i) => (
              <button
                key={c.id}
                id={`group-add-${c.id}`}
                type="button"
                role="option"
                aria-selected={i === hi}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHi(i)}
                onClick={() => {
                  void change([c.uid!], true);
                  setQuery('');
                }}
                className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start', i === hi && 'bg-accent')}
              >
                <ContactPhoto accountId={account.id} card={c.card} size={24} />
                <span dir="auto" className="min-w-0 flex-1 truncate text-[13px] text-text-1">
                  {cardDisplayName(c.card)}
                </span>
                <span className="truncate text-[11.5px] text-text-3">{c.emails[0]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <ul className="mt-4 divide-y divide-line" aria-label={t('members')}>
        {members.length === 0 && <li className="py-6 text-center text-[13px] text-text-3">{t('noMembers')}</li>}
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 py-2">
            <ContactPhoto accountId={account.id} card={m.card} size={30} />
            <button type="button" onClick={() => openContact(account.email, m.id)} className="min-w-0 flex-1 text-start focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none">
              <span dir="auto" className="block truncate text-[13.5px] text-text-1">
                {cardDisplayName(m.card) || t('unnamed')}
              </span>
              <span className="block truncate text-[12px] text-text-3">{m.emails[0] ?? ''}</span>
            </button>
            <IconButton label={t('removeMember', { name: cardDisplayName(m.card) })} disabled={pending} onClick={() => void change([uidOfMember(m)], false)}>
              <UserMinus />
            </IconButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ point d'entrée

export function ContactDetail({
  account,
  row,
  rows,
  books,
  defaultBookId,
  onClose,
}: {
  account: Account;
  row?: CardRow;
  rows: CardRow[];
  books: BookRow[];
  defaultBookId?: string;
  mobile: boolean;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(!row);
  const content = !row ? (
    <ContactEditor
      account={account}
      books={books}
      defaultBookId={defaultBookId}
      onDone={(id) => (id ? openContact(account.email, id, { replace: true }) : onClose())}
    />
  ) : row.kind === 'group' ? (
    <GroupView account={account} row={row} rows={rows} />
  ) : editing ? (
    <ContactEditor account={account} row={row} books={books} onDone={() => setEditing(false)} />
  ) : (
    <ContactView account={account} row={row} rows={rows} books={books} onEdit={() => setEditing(true)} />
  );
  return <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>;
}
