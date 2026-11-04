/**
 * Formulaire de fiche ↔ JSContact. Pur : la fiche d'origine est conservée telle quelle pour tout ce
 * que le formulaire ne montre pas (propriétés vCard inconnues, surnoms supplémentaires, préférences…).
 */
import {
  cardDisplayName,
  nameComponent,
  type CardAddress,
  type CardPhone,
  type ContactCard,
  type ContactCardCreate,
  type PartialDate,
} from '@voxel/jmap';

export type EmailKind = 'home' | 'work' | 'other';
export type PhoneKind = 'mobile' | 'home' | 'work' | 'fax' | 'other';

export interface ContactForm {
  given: string;
  surname: string;
  /** nom complet (vide : prénom + nom) */
  full: string;
  nickname: string;
  emails: Array<{ address: string; kind: EmailKind }>;
  phones: Array<{ number: string; kind: PhoneKind }>;
  org: string;
  title: string;
  addresses: Array<{ street: string; locality: string; region: string; postcode: string; country: string; kind: EmailKind }>;
  /** `AAAA-MM-JJ` ou `--MM-JJ` (sans année) */
  birthday: string;
  website: string;
  note: string;
  /** photo en `data:` (nouvelle), ou `keep` (celle de la fiche), ou vide (aucune) */
  photo: string;
  /** carnet de la fiche */
  bookId: string;
}

const contextKind = (c: Record<string, boolean> | undefined): EmailKind => (c?.private ? 'home' : c?.work ? 'work' : 'other');
const kindContexts = (k: EmailKind): Record<string, boolean> | undefined => (k === 'home' ? { private: true } : k === 'work' ? { work: true } : undefined);

function phoneKind(p: CardPhone): PhoneKind {
  if (p.features?.mobile) return 'mobile';
  if (p.features?.fax) return 'fax';
  if (p.contexts?.private) return 'home';
  if (p.contexts?.work) return 'work';
  return 'other';
}

function phoneOf(number: string, kind: PhoneKind, prev?: CardPhone): CardPhone {
  const base: CardPhone = { ...(prev ?? {}), number };
  delete base.features;
  delete base.contexts;
  if (kind === 'mobile') base.features = { mobile: true };
  else if (kind === 'fax') base.features = { fax: true };
  else if (kind === 'home') base.contexts = { private: true };
  else if (kind === 'work') base.contexts = { work: true };
  return base;
}

const pad = (n: number, l = 2) => String(n).padStart(l, '0');

export function birthdayText(d: PartialDate | undefined): string {
  if (!d?.month || !d.day) return d?.year ? String(d.year) : '';
  return d.year ? `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}` : `--${pad(d.month)}-${pad(d.day)}`;
}

/** `AAAA-MM-JJ`, `--MM-JJ` ou vide → PartialDate (null : invalide). */
export function parseBirthday(s: string): PartialDate | null | undefined {
  const v = s.trim();
  if (!v) return undefined;
  const m = v.match(/^(\d{4}|--)-?(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { '@type': 'PartialDate', ...(m[1] !== '--' ? { year: Number(m[1]) } : {}), month, day };
}

function birthOf(card: Partial<ContactCard>): { key: string; date: PartialDate } | null {
  for (const [key, a] of Object.entries(card.anniversaries ?? {})) {
    if (a.kind === 'birth' && (a.date as { '@type'?: string })['@type'] !== 'Timestamp') return { key, date: a.date as PartialDate };
  }
  return null;
}

/** Composant d'adresse d'une sorte. */
const comp = (a: CardAddress, ...kinds: string[]) =>
  (a.components ?? [])
    .filter((c) => kinds.includes(c.kind))
    .map((c) => c.value)
    .join(' ');

export function emptyForm(bookId: string): ContactForm {
  return { given: '', surname: '', full: '', nickname: '', emails: [{ address: '', kind: 'other' }], phones: [], org: '', title: '', addresses: [], birthday: '', website: '', note: '', photo: '', bookId };
}

export function formFromCard(card: ContactCard): ContactForm {
  const given = nameComponent(card, 'given');
  const surname = nameComponent(card, 'surname');
  const composed = [given, surname].filter(Boolean).join(' ');
  const full = card.name?.full ?? '';
  return {
    given,
    surname,
    full: full && full !== composed ? full : '',
    nickname: Object.values(card.nicknames ?? {})[0]?.name ?? '',
    emails: Object.values(card.emails ?? {}).map((e) => ({ address: e.address, kind: contextKind(e.contexts) })),
    phones: Object.values(card.phones ?? {}).map((p) => ({ number: p.number, kind: phoneKind(p) })),
    org: Object.values(card.organizations ?? {})[0]?.name ?? '',
    title: Object.values(card.titles ?? {}).find((t) => t.kind !== 'role')?.name ?? '',
    addresses: Object.values(card.addresses ?? {}).map((a) => ({
      street: comp(a, 'number', 'name', 'apartment', 'building', 'floor', 'room', 'postOfficeBox') || (a.components?.length ? '' : (a.full ?? '')),
      locality: comp(a, 'locality'),
      region: comp(a, 'region'),
      postcode: comp(a, 'postcode'),
      country: comp(a, 'country'),
      kind: contextKind(a.contexts),
    })),
    birthday: birthdayText(birthOf(card)?.date),
    website: Object.values(card.links ?? {})[0]?.uri ?? '',
    note: Object.values(card.notes ?? {})[0]?.note ?? '',
    photo: Object.values(card.media ?? {}).some((m) => m.kind === 'photo') ? 'keep' : '',
    bookId: Object.entries(card.addressBookIds ?? {}).find(([, on]) => on)?.[0] ?? '',
  };
}

/** Le formulaire est-il enregistrable (un nom, une adresse, un téléphone ou une organisation) ? */
export function formHasIdentity(f: ContactForm): boolean {
  return !!(f.given.trim() || f.surname.trim() || f.full.trim() || f.org.trim() || f.emails.some((e) => e.address.trim()) || f.phones.some((p) => p.number.trim()));
}

/** Applique le formulaire à une fiche (nouvelle si `base` est vide). */
export function applyForm(base: Partial<ContactCard>, f: ContactForm): ContactCardCreate & { id?: string } {
  const card: ContactCardCreate & { id?: string } = structuredClone(base) as ContactCardCreate & { id?: string };
  const trimmedFull = f.full.trim();
  const components = [
    ...(f.given.trim() ? [{ kind: 'given' as const, value: f.given.trim() }] : []),
    ...(f.surname.trim() ? [{ kind: 'surname' as const, value: f.surname.trim() }] : []),
  ];
  // composants non édités ici (titre, second prénom…) conservés
  const kept = (base.name?.components ?? []).filter((c) => c.kind !== 'given' && c.kind !== 'surname');
  const allComps = [...kept.filter((c) => c.kind === 'title'), ...components, ...kept.filter((c) => c.kind !== 'title')];
  const full = trimmedFull || components.map((c) => c.value).join(' ');
  if (full || allComps.length) {
    card.name = { ...(base.name ?? {}), ...(full ? { full } : {}), ...(allComps.length ? { components: allComps } : {}) };
    if (!allComps.length) delete card.name.components;
    if (!full) delete card.name.full;
    delete card.name.isOrdered;
  } else delete card.name;

  const nicks = Object.entries(base.nicknames ?? {});
  if (f.nickname.trim()) card.nicknames = { [nicks[0]?.[0] ?? 'k1']: { name: f.nickname.trim() }, ...Object.fromEntries(nicks.slice(1)) };
  else if (nicks.length > 1) card.nicknames = Object.fromEntries(nicks.slice(1));
  else delete card.nicknames;

  const prevEmails = Object.values(base.emails ?? {});
  const emails = f.emails.filter((e) => e.address.trim());
  if (emails.length) {
    card.emails = Object.fromEntries(
      emails.map((e, i) => {
        const prev = prevEmails.find((p) => p.address.toLowerCase() === e.address.trim().toLowerCase());
        const ctx = kindContexts(e.kind);
        const v = { ...(prev ?? {}), address: e.address.trim() };
        delete v.contexts;
        return [`e${i + 1}`, { ...v, ...(ctx ? { contexts: ctx } : {}) }];
      }),
    );
  } else delete card.emails;

  const prevPhones = Object.values(base.phones ?? {});
  const phones = f.phones.filter((p) => p.number.trim());
  if (phones.length) card.phones = Object.fromEntries(phones.map((p, i) => [`p${i + 1}`, phoneOf(p.number.trim(), p.kind, prevPhones.find((x) => x.number === p.number.trim()))]));
  else delete card.phones;

  const orgs = Object.entries(base.organizations ?? {});
  if (f.org.trim()) card.organizations = { [orgs[0]?.[0] ?? 'o1']: { ...(orgs[0]?.[1] ?? {}), name: f.org.trim() }, ...Object.fromEntries(orgs.slice(1)) };
  else if (orgs.length > 1) card.organizations = Object.fromEntries(orgs.slice(1));
  else delete card.organizations;

  const titles = Object.entries(base.titles ?? {});
  const roles = titles.filter(([, t]) => t.kind === 'role');
  const firstTitle = titles.find(([, t]) => t.kind !== 'role');
  const otherTitles = titles.filter(([, t]) => t.kind !== 'role' && t !== firstTitle?.[1]);
  const nextTitles = [...(f.title.trim() ? [[firstTitle?.[0] ?? 't1', { name: f.title.trim(), kind: 'title' as const }]] : []), ...otherTitles, ...roles];
  if (nextTitles.length) card.titles = Object.fromEntries(nextTitles);
  else delete card.titles;

  const addrs = f.addresses.filter((a) => [a.street, a.locality, a.region, a.postcode, a.country].some((x) => x.trim()));
  if (addrs.length) {
    card.addresses = Object.fromEntries(
      addrs.map((a, i) => {
        const components = (
          [
            ['name', a.street],
            ['locality', a.locality],
            ['region', a.region],
            ['postcode', a.postcode],
            ['country', a.country],
          ] as const
        )
          .filter(([, v]) => v.trim())
          .map(([kind, v]) => ({ kind, value: v.trim() }));
        const ctx = kindContexts(a.kind);
        return [`a${i + 1}`, { components, isOrdered: true, ...(ctx ? { contexts: ctx } : {}) }];
      }),
    );
  } else delete card.addresses;

  const birth = birthOf(base);
  const others = Object.entries(base.anniversaries ?? {}).filter(([k]) => k !== birth?.key);
  const date = parseBirthday(f.birthday);
  if (date) card.anniversaries = { [birth?.key ?? 'n1']: { kind: 'birth', date }, ...Object.fromEntries(others) };
  else if (date === undefined) {
    if (others.length) card.anniversaries = Object.fromEntries(others);
    else delete card.anniversaries;
  }

  const links = Object.entries(base.links ?? {});
  if (f.website.trim()) card.links = { [links[0]?.[0] ?? 'l1']: { ...(links[0]?.[1] ?? {}), uri: f.website.trim() }, ...Object.fromEntries(links.slice(1)) };
  else if (links.length > 1) card.links = Object.fromEntries(links.slice(1));
  else delete card.links;

  const notes = Object.entries(base.notes ?? {});
  if (f.note.trim()) card.notes = { [notes[0]?.[0] ?? 'm1']: { note: f.note }, ...Object.fromEntries(notes.slice(1)) };
  else if (notes.length > 1) card.notes = Object.fromEntries(notes.slice(1));
  else delete card.notes;

  const otherMedia = Object.entries(base.media ?? {}).filter(([, m]) => m.kind !== 'photo');
  const photos = Object.entries(base.media ?? {}).filter(([, m]) => m.kind === 'photo');
  const nextMedia = f.photo === 'keep' ? [...photos, ...otherMedia] : f.photo ? [['ph1', { kind: 'photo', uri: f.photo, mediaType: f.photo.slice(5, f.photo.indexOf(';')) }] as const, ...otherMedia] : otherMedia;
  if (nextMedia.length) card.media = Object.fromEntries(nextMedia);
  else delete card.media;

  if (f.bookId) card.addressBookIds = { [f.bookId]: true };
  if (!cardDisplayName(card) && !card.name) card.name = { full: '' };
  return card;
}
