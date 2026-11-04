/**
 * Contacts : cache Dexie (`cards`, `addressBooks`) par boîte, synchronisé par `ContactCard/changes`
 * (repli : relecture complète) ; modifications par `ContactCard/set` via l'`outbox` (type `contact`), rejouées
 * au retour du réseau ; import `.vcf` (`ContactCard/parse`, un blob par vCard) et export vCard 4.0 côté client.
 *
 * Boîtes JMAP : Stalwart (JMAP for Contacts). Boîtes IMAP : façade CardDAV de la passerelle (même API).
 * Le `uid` de chaque fiche est fixé ici à la création (Stalwart ne l'attribue pas, et les groupes le citent).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CAP,
  cardDisplayName,
  cardEmails,
  cardSearchText,
  cardSortKey,
  newCardUid,
  splitVcards,
  type AddressBook,
  type ContactCard,
  type ContactCardCreate,
  type ContactsAccountCapability,
} from '@voxel/jmap';
import { db, getState, setState, type BookRow, type CardRow } from './db';
import { jmap } from './jmap';
import { isOffline, runCalls } from './outbox';

const GET_CHUNK = 200;
const SET_CHUNK = 100;
const LOCAL = 'local-';

// ------------------------------------------------------------------ lignes du cache

export function rowOf(accountId: string, card: ContactCard): CardRow {
  return {
    accountId,
    id: card.id,
    uid: card.uid,
    card,
    sortKey: cardSortKey(card),
    search: cardSearchText(card),
    emails: cardEmails(card).map((e) => e.toLowerCase()),
    kind: card.kind ?? 'individual',
    bookIds: Object.entries(card.addressBookIds ?? {})
      .filter(([, on]) => on)
      .map(([k]) => k),
  };
}

/** Compte JMAP des contacts, si la session de la boîte annonce la capacité. */
async function contactsAccount(accountId: string): Promise<string | null> {
  const c = jmap(accountId);
  const s = await c.getSession();
  if (!(CAP.contacts in s.capabilities)) return null;
  return c.accountId(CAP.contacts);
}

/** Capacités de contacts d'un compte (création de carnet, import par le serveur). */
export function contactsCapability(accountId: string): ContactsAccountCapability | undefined {
  return jmap(accountId).accountCapability<ContactsAccountCapability>(CAP.contacts);
}

// ------------------------------------------------------------------ synchronisation

const syncing = new Map<string, Promise<void>>();

async function fullReload(accountId: string, aid: string) {
  const c = jmap(accountId);
  const r = await c.call('ContactCard/get', { accountId: aid, ids: null });
  await db.transaction('rw', db.cards, async () => {
    // les fiches créées hors ligne et pas encore rejouées restent visibles
    const pending = await db.cards.where('accountId').equals(accountId).filter((x) => x.id.startsWith(LOCAL)).toArray();
    await db.cards.where('accountId').equals(accountId).delete();
    const uids = new Set(r.list.map((x) => x.uid).filter(Boolean));
    await db.cards.bulkPut([...r.list.map((card) => rowOf(accountId, card)), ...pending.filter((p) => !p.uid || !uids.has(p.uid))]);
  });
  await setState(accountId, 'ContactCard', r.state);
}

async function syncBooks(accountId: string, aid: string) {
  const r = await jmap(accountId).call('AddressBook/get', { accountId: aid, ids: null });
  await db.transaction('rw', db.addressBooks, async () => {
    await db.addressBooks.where('accountId').equals(accountId).delete();
    await db.addressBooks.bulkPut(r.list.map((book) => ({ accountId, id: book.id, book })));
  });
}

async function syncOnce(accountId: string) {
  const aid = await contactsAccount(accountId);
  if (!aid) return;
  const c = jmap(accountId);
  await syncBooks(accountId, aid);
  const since = await getState(accountId, 'ContactCard');
  if (!since) return fullReload(accountId, aid);
  let changes;
  try {
    changes = await c.allChanges('ContactCard', aid, since);
  } catch {
    return fullReload(accountId, aid); // cannotCalculateChanges : relecture complète
  }
  if (changes.hasMoreChanges) return fullReload(accountId, aid);
  const want = [...new Set([...changes.created, ...changes.updated])];
  const fetched: ContactCard[] = [];
  for (let i = 0; i < want.length; i += GET_CHUNK) {
    const r = await c.call('ContactCard/get', { accountId: aid, ids: want.slice(i, i + GET_CHUNK) });
    fetched.push(...r.list);
  }
  await db.transaction('rw', db.cards, async () => {
    if (changes.destroyed.length) await db.cards.bulkDelete(changes.destroyed.map((id) => [accountId, id] as [string, string]));
    if (fetched.length) await db.cards.bulkPut(fetched.map((card) => rowOf(accountId, card)));
    // fiches créées hors ligne désormais connues du serveur (même uid) : la copie locale disparaît
    const uids = new Set(fetched.map((f) => f.uid).filter(Boolean));
    if (uids.size) await db.cards.where('accountId').equals(accountId).filter((x) => x.id.startsWith(LOCAL) && !!x.uid && uids.has(x.uid)).delete();
  });
  await setState(accountId, 'ContactCard', changes.newState);
}

/** Synchronise les contacts d'une boîte (sans effet si la capacité est absente ou hors ligne). */
export function syncContacts(accountId: string): Promise<void> {
  if (isOffline()) return Promise.resolve();
  const running = syncing.get(accountId);
  if (running) return running;
  const p = syncOnce(accountId)
    .catch(() => undefined)
    .finally(() => syncing.delete(accountId));
  syncing.set(accountId, p);
  return p;
}

// ------------------------------------------------------------------ lecture (hooks)

/** Fiches en cache des boîtes données, triées par nom. */
export function useCards(accountIds: string[]): CardRow[] | undefined {
  const key = accountIds.join(',');
  return useLiveQuery(
    async () => {
      if (!accountIds.length) return [];
      try {
        const rows = await db.cards.where('accountId').anyOf(accountIds).toArray();
        return rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.id.localeCompare(b.id));
      } catch {
        return [];
      }
    },
    [key],
  );
}

/** Carnets en cache des boîtes données. */
export function useAddressBooks(accountIds: string[]): BookRow[] | undefined {
  const key = accountIds.join(',');
  return useLiveQuery(
    async () => {
      if (!accountIds.length) return [];
      try {
        const rows = await db.addressBooks.where('accountId').anyOf(accountIds).toArray();
        return rows.sort((a, b) => (a.book.sortOrder ?? 0) - (b.book.sortOrder ?? 0) || a.book.name.localeCompare(b.book.name));
      } catch {
        return [];
      }
    },
    [key],
  );
}

/** Adresse (minuscules) → nom du contact, toutes boîtes confondues (lecteur). */
export function useContactNames(): Map<string, string> {
  return (
    useLiveQuery(async () => {
      const map = new Map<string, string>();
      try {
        await db.cards.each((row) => {
          if (row.kind === 'group') return;
          const name = cardDisplayName(row.card);
          if (!name) return;
          for (const e of row.emails) if (!map.has(e) && name.toLowerCase() !== e) map.set(e, name);
        });
      } catch {
        /* base indisponible */
      }
      return map;
    }, []) ?? EMPTY_NAMES
  );
}
const EMPTY_NAMES = new Map<string, string>();

/** Fiche d'une adresse dans une boîte (pour « Ajouter aux contacts » : déjà présente ?). */
export async function findCardByEmail(accountId: string, email: string): Promise<CardRow | undefined> {
  try {
    return await db.cards
      .where('emails')
      .equals(email.trim().toLowerCase())
      .filter((r) => r.accountId === accountId)
      .first();
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ modifications

/** Échappe une clé de chemin de patch JMAP (JSON Pointer : `~` → `~0`, `/` → `~1`). */
export const pointerKey = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

/** Patch de premier niveau entre deux fiches (propriétés remplacées en entier, `null` = supprimée). */
export function cardPatch(before: Partial<ContactCard>, after: Partial<ContactCard>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === 'id' || k === 'uid' || k === '@type' || k === 'version' || k === 'created' || k === 'updated') continue;
    const a = (before as Record<string, unknown>)[k];
    const b = (after as Record<string, unknown>)[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    patch[k] = b === undefined ? null : b;
  }
  return patch;
}

async function afterWrite(accountId: string, queued: boolean) {
  if (!queued) await syncContacts(accountId);
}

/** Crée une fiche (uid fixé ici) dans un carnet ; visible tout de suite, même hors ligne. */
export async function createCard(accountId: string, bookId: string, card: ContactCardCreate): Promise<{ id: string; queued: boolean }> {
  const aid = (await contactsAccount(accountId)) ?? '';
  const create: ContactCardCreate = { ...card, uid: card.uid || newCardUid(), addressBookIds: { [bookId]: true } };
  delete (create as { id?: string }).id;
  const localId = `${LOCAL}${crypto.randomUUID()}`;
  await db.cards.put(rowOf(accountId, { ...create, id: localId } as ContactCard));
  try {
    const r = await runCalls(accountId, [['ContactCard/set', { accountId: aid, create: { c0: create } }]], { kind: 'contact', label: cardDisplayName(create) });
    if (r.queued) return { id: localId, queued: true };
    const body = r.responses?.[0]?.[1] as { created?: Record<string, { id: string }> } | undefined;
    const id = body?.created?.c0?.id ?? localId;
    await db.cards.delete([accountId, localId]);
    await afterWrite(accountId, false);
    return { id, queued: false };
  } catch (e) {
    await db.cards.delete([accountId, localId]);
    throw e;
  }
}

/** Modifie une fiche (patch des propriétés changées), avec mise à jour immédiate du cache. */
export async function updateCard(accountId: string, before: ContactCard, after: ContactCard): Promise<{ queued: boolean }> {
  const patch = cardPatch(before, after);
  if (!Object.keys(patch).length) return { queued: false };
  if (before.id.startsWith(LOCAL)) throw new Error('pending');
  const aid = (await contactsAccount(accountId)) ?? '';
  const old = await db.cards.get([accountId, before.id]);
  await db.cards.put(rowOf(accountId, after));
  try {
    const r = await runCalls(accountId, [['ContactCard/set', { accountId: aid, update: { [before.id]: patch } }]], { kind: 'contact', label: cardDisplayName(after) });
    await afterWrite(accountId, r.queued);
    return { queued: r.queued };
  } catch (e) {
    if (old) await db.cards.put(old);
    throw e;
  }
}

/** Ajoute ou retire des membres d'un groupe (`members/<uid>`). */
export async function setGroupMembers(accountId: string, group: ContactCard, uids: string[], on: boolean): Promise<{ queued: boolean }> {
  const aid = (await contactsAccount(accountId)) ?? '';
  const patch: Record<string, unknown> = {};
  const members = { ...(group.members ?? {}) };
  for (const u of uids) {
    patch[`members/${pointerKey(u)}`] = on ? true : null;
    if (on) members[u] = true;
    else delete members[u];
  }
  const old = await db.cards.get([accountId, group.id]);
  await db.cards.put(rowOf(accountId, { ...group, members }));
  try {
    const r = await runCalls(accountId, [['ContactCard/set', { accountId: aid, update: { [group.id]: patch } }]], { kind: 'contact', label: cardDisplayName(group) });
    await afterWrite(accountId, r.queued);
    return { queued: r.queued };
  } catch (e) {
    if (old) await db.cards.put(old);
    throw e;
  }
}

/** Supprime des fiches (et les retire des groupes qui les citent). */
export async function deleteCards(accountId: string, ids: string[]): Promise<{ queued: boolean }> {
  const aid = (await contactsAccount(accountId)) ?? '';
  const rows = (await db.cards.bulkGet(ids.map((id) => [accountId, id] as [string, string]))).filter((r): r is CardRow => !!r);
  const remote = ids.filter((id) => !id.startsWith(LOCAL));
  await db.cards.bulkDelete(ids.map((id) => [accountId, id] as [string, string]));
  if (!remote.length) return { queued: false };
  try {
    const r = await runCalls(accountId, [['ContactCard/set', { accountId: aid, destroy: remote }]], { kind: 'contact', label: rows.map((x) => cardDisplayName(x.card)).join(', ') });
    await afterWrite(accountId, r.queued);
    return { queued: r.queued };
  } catch (e) {
    await db.cards.bulkPut(rows);
    throw e;
  }
}

/** Crée un carnet (boîtes JMAP qui le permettent). */
export async function createAddressBook(accountId: string, name: string): Promise<void> {
  const aid = (await contactsAccount(accountId)) ?? '';
  // Stalwart crée le carnet avec isSubscribed: false : on l'abonne explicitement
  await runCalls(accountId, [['AddressBook/set', { accountId: aid, create: { b0: { name, isSubscribed: true } as Partial<AddressBook> } }]], { kind: 'contact', label: name });
  await syncContacts(accountId);
}

// ------------------------------------------------------------------ import / export

export interface ImportItem {
  card: ContactCardCreate;
  /** Fiche existante de la même boîte avec une adresse commune. */
  duplicate?: CardRow;
}

export type DuplicateAction = 'skip' | 'replace' | 'both';

/** Limite de lecture d'un fichier `.vcf`. */
export const MAX_VCF_BYTES = 10 * 1024 * 1024;

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

/**
 * Lit un fichier `.vcf` : découpage en vCard, un blob téléversé par vCard, `ContactCard/parse` (le serveur
 * ne lit que la première vCard d'un blob) ; doublons repérés par adresse e-mail dans la boîte.
 */
export async function parseVcfForImport(accountId: string, text: string, onProgress?: (done: number, total: number) => void): Promise<{ items: ImportItem[]; invalid: number }> {
  const aid = await contactsAccount(accountId);
  if (!aid) throw new Error('contacts unavailable');
  const parts = splitVcards(text);
  const c = jmap(accountId);
  let done = 0;
  const blobs = await pool(parts, 4, async (p) => {
    const r = await c.upload(aid, new TextEncoder().encode(p), 'text/vcard');
    onProgress?.(++done, parts.length);
    return r.blobId;
  });
  const cards: ContactCardCreate[] = [];
  let invalid = 0;
  for (let i = 0; i < blobs.length; i += 50) {
    const ids = blobs.slice(i, i + 50);
    const r = await c.call('ContactCard/parse', { accountId: aid, blobIds: ids });
    for (const id of ids) {
      const v = r.parsed?.[id];
      if (!v) invalid++;
      else if (Array.isArray(v)) cards.push(...v);
      else cards.push(v);
    }
  }
  const existing = await db.cards.where('accountId').equals(accountId).toArray();
  const byEmail = new Map<string, CardRow>();
  for (const row of existing) for (const e of row.emails) if (!byEmail.has(e)) byEmail.set(e, row);
  const items = cards.map((card) => {
    const dup = cardEmails(card)
      .map((e) => byEmail.get(e.toLowerCase()))
      .find(Boolean);
    return dup ? { card, duplicate: dup } : { card };
  });
  return { items, invalid };
}

/** Enregistre un import : créations et remplacements par lots de 100. */
export async function importCards(accountId: string, bookId: string, items: Array<ImportItem & { action: DuplicateAction }>): Promise<{ created: number; replaced: number; skipped: number; queued: boolean }> {
  const aid = (await contactsAccount(accountId)) ?? '';
  const known = new Set((await db.cards.where('accountId').equals(accountId).toArray()).map((r) => r.uid).filter(Boolean));
  const creates: Record<string, ContactCardCreate> = {};
  const updates: Record<string, Record<string, unknown>> = {};
  let skipped = 0;
  items.forEach((it, i) => {
    if (it.duplicate && it.action === 'skip') {
      skipped++;
      return;
    }
    const clean: ContactCardCreate = { ...it.card };
    delete (clean as { id?: string }).id;
    delete clean.addressBookIds;
    if (it.duplicate && it.action === 'replace' && !it.duplicate.id.startsWith(LOCAL)) {
      const { uid: _uid, ...rest } = clean;
      void _uid;
      updates[it.duplicate.id] = cardPatch(it.duplicate.card, { ...rest, id: it.duplicate.id } as ContactCard);
      return;
    }
    const uid = clean.uid && !known.has(clean.uid) ? clean.uid : newCardUid();
    known.add(uid);
    creates[`i${i}`] = { ...clean, uid, addressBookIds: { [bookId]: true } };
  });
  let queued = false;
  const createKeys = Object.keys(creates);
  for (let i = 0; i < createKeys.length; i += SET_CHUNK) {
    const part = Object.fromEntries(createKeys.slice(i, i + SET_CHUNK).map((k) => [k, creates[k]!]));
    const r = await runCalls(accountId, [['ContactCard/set', { accountId: aid, create: part }]], { kind: 'contact', label: `vcf (${Object.keys(part).length})` });
    queued ||= r.queued;
  }
  const updateKeys = Object.keys(updates).filter((k) => Object.keys(updates[k]!).length);
  for (let i = 0; i < updateKeys.length; i += SET_CHUNK) {
    const part = Object.fromEntries(updateKeys.slice(i, i + SET_CHUNK).map((k) => [k, updates[k]!]));
    const r = await runCalls(accountId, [['ContactCard/set', { accountId: aid, update: part }]], { kind: 'contact', label: `vcf (${Object.keys(part).length})` });
    queued ||= r.queued;
  }
  await afterWrite(accountId, queued);
  return { created: createKeys.length, replaced: updateKeys.length, skipped, queued };
}

/** Exporte des fiches en vCard 4.0 (généré côté client) et lance le téléchargement. */
export async function exportCards(cards: ContactCard[], fileName = 'contacts.vcf'): Promise<void> {
  const { cardsToVcf } = await import('@voxel/jmap/vcard');
  const clean = cards.map((c) => {
    const { addressBookIds: _b, id: _i, ...rest } = c;
    void _b;
    void _i;
    return rest;
  });
  const text = cardsToVcf(clean, { version: '4.0' });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/vcard;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
