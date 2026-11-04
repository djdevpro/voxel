import Dexie, { type EntityTable } from 'dexie';
import type { AiSummary } from '@/lib/ai/types';
import type { AddressBook, Calendar, CalendarEvent, ContactCard, Invocation } from '@voxel/jmap';

export interface KvRow {
  key: string;
  value: unknown;
}

/** Action en attente de synchronisation (rejouée au retour en ligne). */
export interface OutboxRow {
  id?: number;
  accountId: string;
  kind: 'send' | 'move' | 'keywords' | 'delete' | 'mailbox' | 'contact' | 'event' | 'other';
  label: string;
  /** Appels JMAP prêts à rejouer (références arrière autorisées). */
  calls: Invocation[];
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface ContactRow {
  email: string;
  name: string | null;
  count: number;
  lastSeen: number;
}

/** Fiche de contact en cache (table `cards`, synchronisée par `ContactCard/changes`). */
export interface CardRow {
  accountId: string;
  /** Id JMAP ; `local-…` pour une fiche créée hors ligne, pas encore confirmée. */
  id: string;
  uid?: string;
  card: ContactCard;
  /** Clé de tri (nom de famille, prénom), minuscules sans accents. */
  sortKey: string;
  /** Texte de recherche instantanée. */
  search: string;
  /** Adresses e-mail en minuscules (index multiple). */
  emails: string[];
  kind: string;
  bookIds: string[];
}

/** Carnet d'adresses en cache. */
export interface BookRow {
  accountId: string;
  id: string;
  book: AddressBook;
}

/** Agenda en cache. */
export interface CalendarRow {
  accountId: string;
  id: string;
  calendar: Calendar;
}

/**
 * Événement en cache (série entière, développée à l'affichage), table `events` : ceux des plages consultées et
 * ceux que `CalendarEvent/changes` a signalés. `start` / `end` : bornes (ms) de toute la série, `end` très grand
 * pour une récurrence sans fin ; servent au filtrage par plage avant le développement.
 */
export interface EventRow {
  accountId: string;
  /** Id JMAP ; `local-…` pour un événement créé hors ligne, pas encore confirmé. */
  id: string;
  uid?: string;
  event: CalendarEvent;
  calendarIds: string[];
  start: number;
  end: number;
}

export interface DraftRow {
  /** id de la fenêtre de rédaction */
  id: string;
  accountId: string;
  data: unknown;
  updatedAt: number;
}

/** Secret chiffré (AES-GCM 256, IV de 12 octets). */
export interface SecretBox {
  iv: Uint8Array;
  data: ArrayBuffer;
}

/** Serveur IMAP, SMTP ou ManageSieve d'une boîte IMAP. */
export interface MailEndpoint {
  host: string;
  port: number;
  security: 'ssl' | 'starttls';
}

/** Boîte ouverte sur cet appareil. */
export interface AccountRow {
  /** Identifiant local stable (`crypto.randomUUID()`). */
  id: string;
  email: string;
  username: string;
  protocol: 'jmap' | 'imap';
  /** URL de session JMAP (boîte JMAP) ; `/imap/session` pour une boîte IMAP (passerelle). */
  sessionUrl: string;
  imap?: MailEndpoint;
  smtp?: MailEndpoint;
  /** ManageSieve (filtres côté serveur), facultatif : en-tête `X-Voxel-Sieve`. */
  sieve?: MailEndpoint;
  /** Service CardDAV (contacts), facultatif : en-tête `X-Voxel-CardDav` (URL https). */
  carddav?: string;
  /** Service CalDAV (agenda), facultatif : en-tête `X-Voxel-CalDav` (URL https). */
  caldav?: string;
  displayName: string;
  color: string;
  sortOrder: number;
  /** Mot de passe chiffré ; absent si « Rester connecté » était décoché. */
  secret?: SecretBox;
  createdAt: number;
}

export interface StateRow {
  /** `${accountId}:${type}` */
  key: string;
  state: string;
  updatedAt: number;
}

class VoxelDb extends Dexie {
  kv!: EntityTable<KvRow, 'key'>;
  outbox!: EntityTable<OutboxRow, 'id'>;
  contacts!: EntityTable<ContactRow, 'email'>;
  drafts!: EntityTable<DraftRow, 'id'>;
  states!: EntityTable<StateRow, 'key'>;
  accounts!: EntityTable<AccountRow, 'id'>;
  cards!: Dexie.Table<CardRow, [string, string]>;
  addressBooks!: Dexie.Table<BookRow, [string, string]>;
  calendars!: Dexie.Table<CalendarRow, [string, string]>;
  events!: Dexie.Table<EventRow, [string, string]>;
  aiSummaries!: EntityTable<AiSummary, 'id'>;

  constructor() {
    super('voxel');
    this.version(1).stores({
      kv: 'key',
      outbox: '++id, accountId, createdAt',
      contacts: 'email, name, count, lastSeen',
      drafts: 'id, accountId, updatedAt',
      states: 'key',
    });
    // v3 : comptes sur l'appareil (les tables existantes sont conservées telles quelles)
    this.version(2).stores({ accounts: 'id, email, sortOrder' });
    // v4 (lot A2) : contacts et carnets par boîte
    this.version(3).stores({ cards: '[accountId+id], accountId, uid, *emails', addressBooks: '[accountId+id], accountId' });
    // v4 (lot A3) : agendas et événements par boîte
    this.version(4).stores({ calendars: '[accountId+id], accountId', events: '[accountId+id], accountId, uid, start, end' });
    // v5 : résumés quotidiens de l'IA
    this.version(5).stores({ aiSummaries: 'id, createdAt' });
  }
}

export const db = new VoxelDb();

let persistRequested = false;

/** Demande un stockage persistant (une fois par chargement), pour que le navigateur n'évince pas IndexedDB. */
export async function requestPersistentStorage(): Promise<void> {
  if (persistRequested) return;
  persistRequested = true;
  try {
    if ((await navigator.storage?.persisted?.()) === false) await navigator.storage?.persist?.();
  } catch {
    /* ignoré */
  }
}

export async function getState(accountId: string, type: string): Promise<string | undefined> {
  try {
    return (await db.states.get(`${accountId}:${type}`))?.state;
  } catch {
    return undefined;
  }
}

export async function setState(accountId: string, type: string, state: string) {
  try {
    await db.states.put({ key: `${accountId}:${type}`, state, updatedAt: Date.now() });
  } catch {
    /* best effort */
  }
}

/** Mémorise des adresses vues (auto-complétion). */
export async function rememberContacts(list: Array<{ email: string; name: string | null }>, weight = 1) {
  if (!list.length) return;
  const now = Date.now();
  const map = new Map<string, { email: string; name: string | null }>();
  for (const a of list) {
    const email = a.email?.trim().toLowerCase();
    if (email && email.includes('@')) map.set(email, { email, name: a.name });
  }
  try {
    await db.transaction('rw', db.contacts, async () => {
      const keys = [...map.keys()];
      const existing = await db.contacts.bulkGet(keys);
      const rows: ContactRow[] = keys.map((email, i) => {
        const a = map.get(email)!;
        const e = existing[i];
        return { email, name: a.name || e?.name || null, count: (e?.count ?? 0) + weight, lastSeen: now };
      });
      await db.contacts.bulkPut(rows);
    });
  } catch {
    /* cache best effort */
  }
}

/**
 * Efface tout ce que l'appareil garde d'une boîte : brouillons locaux, file d'actions
 * en attente et états `*\/changes`. (Le cache react-query est purgé par `queryClient.ts`.)
 */
export async function purgeMailboxData(mailboxId: string) {
  try {
    await db.transaction('rw', [db.drafts, db.outbox, db.states, db.kv, db.cards, db.addressBooks, db.calendars, db.events], async () => {
      await db.drafts.where('accountId').equals(mailboxId).delete();
      await db.calendars.where('accountId').equals(mailboxId).delete();
      await db.events.where('accountId').equals(mailboxId).delete();
      await db.cards.where('accountId').equals(mailboxId).delete();
      await db.addressBooks.where('accountId').equals(mailboxId).delete();
      await db.outbox.where('accountId').equals(mailboxId).delete();
      await db.states.where('key').startsWith(`${mailboxId}:`).delete();
      await db.kv.bulkDelete([`session:${mailboxId}`, `mbset:${mailboxId}`]);
    });
    // résumés dont une source vient de cette boîte
    await db.aiSummaries.filter((s) => s.sources.some((x) => x.accountId === mailboxId)).delete();
  } catch {
    /* base indisponible (navigation privée) */
  }
  try {
    localStorage.removeItem(`voxel-contacts-${mailboxId}`);
  } catch {
    /* ignoré */
  }
}

/** « Tout déconnecter » : vide toutes les tables (y compris les adresses mémorisées pour l'auto-complétion). */
export async function purgeAllData() {
  try {
    await Promise.all([db.kv.clear(), db.outbox.clear(), db.contacts.clear(), db.drafts.clear(), db.states.clear(), db.accounts.clear(), db.cards.clear(), db.addressBooks.clear(), db.calendars.clear(), db.events.clear(), db.aiSummaries.clear()]);
  } catch {
    /* ignoré */
  }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('voxel-contacts-')) localStorage.removeItem(k);
  } catch {
    /* ignoré */
  }
}

/** Supprime les données locales des boîtes qui ne sont plus dans la session (ex. cache v1, session perdue). */
export async function pruneLocalData(mailboxIds: string[]) {
  try {
    const keep = new Set(mailboxIds);
    await db.transaction('rw', [db.drafts, db.outbox, db.states, db.cards, db.addressBooks, db.calendars, db.events], async () => {
      await db.drafts.filter((d) => !keep.has(d.accountId)).delete();
      await db.calendars.filter((c) => !keep.has(c.accountId)).delete();
      await db.events.filter((e) => !keep.has(e.accountId)).delete();
      await db.cards.filter((c) => !keep.has(c.accountId)).delete();
      await db.addressBooks.filter((b) => !keep.has(b.accountId)).delete();
      await db.outbox.filter((o) => !keep.has(o.accountId)).delete();
      await db.states.filter((s) => !keep.has(s.key.split(':')[0]!)).delete();
    });
  } catch {
    /* ignoré */
  }
}
