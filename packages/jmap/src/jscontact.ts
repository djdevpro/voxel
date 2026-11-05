/**
 * Fiches de contact JSContact (RFC 9553) telles qu'échangées par JMAP for Contacts (RFC 9610),
 * et petites fonctions pures communes au webmail et à la passerelle (nom affiché, adresses, groupes,
 * découpage d'un fichier `.vcf`).
 *
 * Module autonome (aucun import) : la passerelle (`apps/server`) l'importe tel quel.
 *
 * Écarts constatés avec Stalwart v1.0.1 (2026-11-03, boîte de test) :
 * - `uid` n'est pas attribué par le serveur : le client doit le fixer à la création (sinon les groupes,
 *   dont `members` est indexé par `uid`, ne peuvent pas désigner la fiche) ;
 * - une propriété inconnue (`x-…`, `exemple.com:…`, `vCardProps`) est refusée (`invalidProperties`) ; les
 *   propriétés vCard sans équivalent passent par `vCard.properties` (RFC 9555), accepté ;
 * - `ContactCard/parse` ne renvoie que la PREMIÈRE vCard d'un blob (`parsed: { blobId: Card }`) : un fichier
 *   de plusieurs contacts doit être découpé (`splitVcards`) en un blob par contact ;
 * - tri de `ContactCard/query` : seulement `created` et `updated` (`name/…` → `unsupportedSort`) ;
 * - `media` en `data:` est converti par le serveur en `blobId` + `mediaType` ;
 * - un carnet créé par `AddressBook/set` a `isSubscribed: false`.
 */

export type JSContactKind = 'individual' | 'group' | 'org' | 'location' | 'device' | 'application';

export interface NameComponent {
  kind: 'title' | 'given' | 'given2' | 'surname' | 'surname2' | 'credential' | 'generation' | 'separator' | (string & {});
  value: string;
  phonetic?: string;
}

export interface CardName {
  full?: string;
  components?: NameComponent[];
  isOrdered?: boolean;
  defaultSeparator?: string;
  sortAs?: Record<string, string>;
}

export type Contexts = Record<string, boolean>;

export interface CardEmail {
  address: string;
  contexts?: Contexts;
  pref?: number;
  label?: string;
}

export interface CardPhone {
  number: string;
  features?: Record<string, boolean>;
  contexts?: Contexts;
  pref?: number;
  label?: string;
}

export interface AddressComponent {
  kind:
    | 'room'
    | 'apartment'
    | 'floor'
    | 'building'
    | 'number'
    | 'name'
    | 'block'
    | 'subdistrict'
    | 'district'
    | 'locality'
    | 'region'
    | 'postcode'
    | 'country'
    | 'direction'
    | 'landmark'
    | 'postOfficeBox'
    | 'separator'
    | (string & {});
  value: string;
}

export interface CardAddress {
  components?: AddressComponent[];
  full?: string;
  countryCode?: string;
  contexts?: Contexts;
  pref?: number;
  isOrdered?: boolean;
  defaultSeparator?: string;
  label?: string;
}

export interface PartialDate {
  '@type'?: 'PartialDate';
  year?: number;
  month?: number;
  day?: number;
  calendarScale?: string;
}

export interface Timestamp {
  '@type': 'Timestamp';
  utc: string;
}

export interface CardAnniversary {
  kind?: 'birth' | 'death' | 'wedding' | (string & {});
  date: PartialDate | Timestamp;
}

export interface CardMedia {
  kind: 'photo' | 'sound' | 'logo' | (string & {});
  uri?: string;
  blobId?: string;
  mediaType?: string;
  pref?: number;
}

/** Propriété vCard conservée telle quelle (forme jCard, RFC 7095 : nom, paramètres, type, valeur…). */
export type VCardProp = [name: string, params: Record<string, unknown>, type: string, ...values: unknown[]];

/** Contenu d'une fiche (sans `id`) : forme d'une création. */
export interface ContactCardCreate {
  '@type'?: 'Card';
  version?: string;
  uid?: string;
  kind?: JSContactKind;
  /** Carnets qui contiennent la fiche (JMAP for Contacts). */
  addressBookIds?: Record<string, boolean>;
  created?: string;
  updated?: string;
  prodId?: string;
  language?: string;
  name?: CardName;
  nicknames?: Record<string, { name: string; contexts?: Contexts }>;
  emails?: Record<string, CardEmail>;
  phones?: Record<string, CardPhone>;
  organizations?: Record<string, { name?: string; units?: Array<{ name: string }>; sortAs?: string }>;
  titles?: Record<string, { name: string; kind?: 'title' | 'role'; organizationId?: string }>;
  addresses?: Record<string, CardAddress>;
  anniversaries?: Record<string, CardAnniversary>;
  links?: Record<string, { uri: string; kind?: string; contexts?: Contexts; label?: string }>;
  notes?: Record<string, { note: string; created?: string }>;
  media?: Record<string, CardMedia>;
  keywords?: Record<string, boolean>;
  onlineServices?: Record<string, { service?: string; uri?: string; user?: string; label?: string }>;
  /** Groupe (`kind: "group"`) : `uid` des membres. */
  members?: Record<string, boolean>;
  /** Propriétés vCard sans équivalent JSContact, conservées pour l'aller-retour (RFC 9555). */
  vCard?: { properties?: VCardProp[]; convertedProperties?: Record<string, unknown> };
  [k: string]: unknown;
}

/** Fiche telle que lue (`ContactCard/get`). */
export interface ContactCard extends ContactCardCreate {
  id: string;
}

/** Carnet d'adresses (RFC 9610 §2). */
export interface AddressBook {
  id: string;
  name: string;
  description?: string | null;
  sortOrder?: number;
  isDefault?: boolean;
  isSubscribed?: boolean;
  shareWith?: Record<string, unknown> | null;
  myRights?: { mayRead?: boolean; mayWrite?: boolean; mayDelete?: boolean; mayShare?: boolean; [k: string]: boolean | undefined };
}

/** Capacité de compte `urn:ietf:params:jmap:contacts`. */
export interface ContactsAccountCapability {
  maxAddressBooksPerCard?: number | null;
  mayCreateAddressBook?: boolean;
}

export interface ContactCardFilterCondition {
  inAddressBook?: string;
  uid?: string;
  hasMember?: string;
  kind?: JSContactKind;
  text?: string;
  name?: string;
  email?: string;
  phone?: string;
}

// ------------------------------------------------------------------ fonctions pures

/** Nouvel identifiant de fiche (`urn:uuid:…`), à fixer à la création. */
export function newCardUid(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}

/** Compare deux `uid` en ignorant le préfixe `urn:uuid:` (Apple écrit les membres avec, les fiches sans). */
export function sameUid(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const n = (s: string) => s.trim().replace(/^urn:uuid:/i, '').toLowerCase();
  return n(a) === n(b);
}

function byPref<T extends { pref?: number }>(o: Record<string, T> | undefined): T[] {
  return Object.values(o ?? {}).sort((x, y) => (x.pref ?? 101) - (y.pref ?? 101));
}

/** Composant de nom (`given`, `surname`…) concaténé. */
export function nameComponent(card: Pick<Partial<ContactCard>, 'name'>, kind: string): string {
  return (card.name?.components ?? [])
    .filter((c) => c.kind === kind)
    .map((c) => c.value)
    .join(' ')
    .trim();
}

const NAME_ORDER = ['title', 'given', 'given2', 'surname', 'surname2', 'generation', 'credential'];

/** Nom affiché : nom complet, sinon composants, surnom, organisation, première adresse. */
export function cardDisplayName(card: Partial<ContactCard>): string {
  const full = card.name?.full?.trim();
  if (full) return full;
  const comps = (card.name?.components ?? []).filter((c) => c.kind !== 'separator' && c.value.trim());
  if (comps.length) {
    const sorted = card.name?.isOrdered ? comps : [...comps].sort((a, b) => NAME_ORDER.indexOf(a.kind) - NAME_ORDER.indexOf(b.kind));
    return sorted.map((c) => c.value.trim()).join(' ');
  }
  const nick = Object.values(card.nicknames ?? {})[0]?.name?.trim();
  if (nick) return nick;
  const org = Object.values(card.organizations ?? {})[0]?.name?.trim();
  if (org) return org;
  return byPref(card.emails)[0]?.address ?? '';
}

/** Adresses e-mail de la fiche, la préférée d'abord. */
export function cardEmails(card: Partial<ContactCard>): string[] {
  return byPref(card.emails)
    .map((e) => e.address?.trim())
    .filter((a): a is string => !!a);
}

/** Minuscules sans diacritiques (recherche instantanée, index alphabétique). */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Clé de tri : nom de famille puis prénom, sinon nom affiché (minuscules, sans accents). */
export function cardSortKey(card: Partial<ContactCard>): string {
  const surname = nameComponent(card, 'surname');
  const given = nameComponent(card, 'given');
  return foldText(surname ? `${surname} ${given}` : cardDisplayName(card));
}

/** Texte de recherche d'une fiche (noms, surnoms, adresses, téléphones, organisation, fonctions, notes). */
export function cardSearchText(card: Partial<ContactCard>): string {
  const parts: string[] = [cardDisplayName(card)];
  for (const c of card.name?.components ?? []) parts.push(c.value);
  for (const n of Object.values(card.nicknames ?? {})) parts.push(n.name);
  for (const e of Object.values(card.emails ?? {})) parts.push(e.address);
  for (const p of Object.values(card.phones ?? {})) parts.push(p.number);
  for (const o of Object.values(card.organizations ?? {})) parts.push(o.name ?? '');
  for (const t of Object.values(card.titles ?? {})) parts.push(t.name);
  for (const n of Object.values(card.notes ?? {})) parts.push(n.note);
  return foldText(parts.filter(Boolean).join(' '));
}

/** Initiale de l'index alphabétique (`#` pour ce qui ne commence pas par une lettre). */
export function indexLetter(card: Partial<ContactCard>): string {
  const ch = cardSortKey(card).charAt(0).toUpperCase();
  return /\p{L}/u.test(ch) ? ch : '#';
}

/** La fiche est-elle un groupe ? */
export function isGroup(card: Partial<ContactCard>): boolean {
  return card.kind === 'group';
}

/** Membres d'un groupe parmi des fiches connues (comparaison des `uid` sans `urn:uuid:`). */
export function groupMembers<T extends { uid?: string }>(group: Partial<ContactCard>, cards: T[]): T[] {
  const uids = Object.entries(group.members ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (!uids.length) return [];
  return cards.filter((c) => c.uid && uids.some((u) => sameUid(u, c.uid)));
}

/** Destinataires d'un groupe : première adresse de chaque membre (doublons retirés). */
export function expandGroup<T extends Partial<ContactCard>>(group: Partial<ContactCard>, cards: T[]): Array<{ name: string; email: string }> {
  const out: Array<{ name: string; email: string }> = [];
  const seen = new Set<string>();
  for (const m of groupMembers(group, cards)) {
    const email = cardEmails(m)[0];
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push({ name: cardDisplayName(m), email });
  }
  return out;
}

/**
 * Découpe un fichier `.vcf` en vCard individuelles (`BEGIN:VCARD` … `END:VCARD`, imbrication comprise,
 * lignes repliées conservées). Fins de ligne normalisées en CRLF.
 */
export function splitVcards(text: string): string[] {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const out: string[] = [];
  let cur: string[] = [];
  let depth = 0;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') {
      depth++;
      cur.push(line);
      continue;
    }
    if (depth === 0) continue;
    cur.push(line);
    if (upper === 'END:VCARD') {
      depth--;
      if (depth === 0) {
        out.push(`${cur.join('\r\n')}\r\n`);
        cur = [];
      }
    }
  }
  return out;
}

/** Applique K1, K2, K3, K6 et K9 à une entrée ; renvoie l'entrée elle-même s'il n'y a rien à corriger. */
function fixCardEntry(entry: unknown, table: string): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const e = entry as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  const edit = () => (out ??= { ...e });
  const ctx = e.contexts as Record<string, unknown> | undefined;
  if (ctx && typeof ctx === 'object' && (ctx.pref === true || 'internet' in ctx)) {
    const { pref, internet: _i, ...rest } = ctx;
    const o = edit();
    if (pref === true) {
      if (o.pref === undefined) o.pref = 1;
    } else if (pref !== undefined) rest.pref = pref;
    if (Object.keys(rest).length) o.contexts = rest;
    else delete o.contexts;
  }
  const label = typeof e.label === 'string' ? /^_\$!<(.*)>!\$_$/.exec(e.label) : null;
  if (label) edit().label = label[1];
  if (table === 'phones' && typeof e.number === 'string' && e.number.slice(0, 4).toLowerCase() === 'tel:') edit().number = e.number.slice(4);
  if ((table === 'links' || table === 'onlineServices') && typeof e.uri === 'string' && /\\[:,;]/.test(e.uri)) {
    edit().uri = e.uri.replace(/\\([:,;])/g, '$1');
  }
  return out ?? entry;
}

/**
 * Fiche lue d'un serveur → modèle de l'interface. Corrige ce que Stalwart (conversion calcard) et Cyrus renvoient
 * pour des vCard venues de téléphones ou de logiciels (mesuré sur les jeux d'essai DAV). Pure et idempotente ;
 * renvoie la fiche elle-même s'il n'y a rien à corriger.
 */
export function fromServerCard<T extends object>(card: T): T {
  const c = card as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const table of ['emails', 'phones', 'addresses', 'links', 'onlineServices']) {
    const map = c[table] as Record<string, unknown> | undefined;
    if (!map || typeof map !== 'object') continue;
    let copy: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(map)) {
      const fixed = fixCardEntry(v, table);
      if (fixed !== v) (copy ??= { ...map })[k] = fixed;
    }
    if (copy) (out ??= { ...c })[table] = copy;
  }
  // K8 : année 1604, écrite par Apple quand l'année manque (`X-APPLE-OMIT-YEAR` n'est pas visible en JMAP)
  const ann = c.anniversaries as Record<string, unknown> | undefined;
  if (ann && typeof ann === 'object') {
    let copy: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(ann)) {
      const date = (v as { date?: Record<string, unknown> } | null)?.date;
      if (!date || typeof date !== 'object' || date.year !== 1604) continue;
      if (date['@type'] !== undefined && date['@type'] !== 'PartialDate') continue;
      const { year: _y, ...rest } = date;
      (copy ??= { ...ann })[k] = { ...(v as Record<string, unknown>), date: rest };
    }
    if (copy) (out ??= { ...c }).anniversaries = copy;
  }
  return (out ?? card) as T;
}

/** Arguments de `ContactCard/set` pour un compte JMAP : `version: '1.0'` ajoutée à chaque création qui n'en a pas (Cyrus l'exige). Copie ; le reste passe tel quel. */
export function toServerCardSet<A extends Record<string, unknown>>(args: A): A {
  const out: Record<string, unknown> = { ...args };
  const create = args.create as Record<string, Record<string, unknown>> | null | undefined;
  if (create) {
    const c: Record<string, unknown> = {};
    for (const [id, card] of Object.entries(create)) c[id] = card.version === undefined ? { ...card, version: '1.0' } : { ...card };
    out.create = c;
  }
  return out as A;
}
