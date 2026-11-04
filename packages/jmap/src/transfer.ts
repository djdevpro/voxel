/**
 * Import et export de dossiers en mbox, partagés par l'appli et les tests. Module sans DOM.
 * - Le client réessaie seul les refus courts (429). Une attente plus longue imposée par le serveur (Stalwart :
 *   1 000 téléversements ou 50 Mo par heure et par compte) met l'import en pause, puis il reprend seul.
 * - Un message dont le Message-ID est déjà dans le dossier est ignoré : relancer un import interrompu ne crée pas
 *   de doublons.
 * - `Email/import` par lots de 25 messages : presque deux fois moins de requêtes qu'un appel par message.
 */
import { delay, JmapError, type JmapClient } from './client.ts';
import { binaryToBytes, bytesToBinary, looksLikeMbox, MboxSplitter, mboxEntry, rawMessageDate } from './mbox.ts';
import type { Id, UploadResponse } from './types.ts';

/** Messages d'un fichier, au fil de la lecture : un `.eml` = un message, un mbox = découpé. */
export async function* readMessages(file: Blob, name = ''): AsyncGenerator<string> {
  const head = bytesToBinary(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
  if (!/\.mbox$/i.test(name) && !looksLikeMbox(head)) {
    yield bytesToBinary(new Uint8Array(await file.arrayBuffer()));
    return;
  }
  const splitter = new MboxSplitter();
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const m of splitter.push(bytesToBinary(value))) yield m;
  }
  for (const m of splitter.end()) yield m;
}

/** Message-ID d'un message brut, sans chevrons (comme la propriété JMAP `messageId`), ou null. */
export function rawMessageId(raw: string): string | null {
  const end = raw.search(/\r?\n\r?\n/);
  const head = end >= 0 ? raw.slice(0, end) : raw.slice(0, 65536);
  const m = /^Message-ID:[ \t]*(?:\r?\n[ \t]+)?<([^<>\s]+)>/im.exec(head);
  return m ? m[1]! : null;
}

/** Message-ID des messages d'un dossier (une requête par tranche de 500). */
export async function mailboxMessageIds(client: JmapClient, accountId: Id, mailboxId: Id): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let position = 0; ; ) {
    const b = client.batch();
    const q = b.call('Email/query', { accountId, filter: { inMailbox: mailboxId }, position, limit: 500 });
    const g = b.call('Email/get', { accountId, '#ids': q.ref('/ids'), properties: ['messageId'] });
    await b.send();
    for (const e of g.result.list) for (const m of e.messageId ?? []) ids.add(m);
    position += q.result.ids.length;
    if (q.result.ids.length < 500) break;
  }
  return ids;
}

export interface TransferCounts {
  imported: number;
  /** Déjà dans le dossier (même Message-ID) ou en double dans le fichier. */
  skipped: number;
  failed: number;
}

export interface ImportOptions {
  accountId: Id;
  mailboxId: Id;
  /** Messages bruts (chaînes binaires, voir `readMessages`). */
  messages: AsyncIterable<string>;
  signal?: AbortSignal;
  onProgress?: (counts: TransferCounts) => void;
  /** Pause imposée par le serveur : l'import reprend seul vers `until`. */
  onWait?: (until: Date, counts: TransferCounts) => void;
  /** Messages par `Email/import` (25). */
  batchSize?: number;
  /** Attente annulable (remplacée dans les tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ImportResult extends TransferCounts {
  aborted: boolean;
  /** Échecs par type d'erreur. */
  errors: Record<string, number>;
}

/** Pause après un 429 sans `Retry-After` lisible : quota de téléversement (texte « quota ») ou simple débit. */
const QUOTA_WAIT_S = 300;
const RATE_WAIT_S = 30;
const MAX_WAIT_MS = 65 * 60_000;

function errorType(e: unknown): string {
  if (e instanceof JmapError) return e.status ? `${e.type} ${e.status}` : e.type;
  return e instanceof Error ? e.name : 'error';
}

/** Importe des messages bruts dans un dossier. */
export async function importMessages(client: JmapClient, o: ImportOptions): Promise<ImportResult> {
  const sleep = o.sleep ?? delay;
  const counts: TransferCounts = { imported: 0, skipped: 0, failed: 0 };
  const errors: Record<string, number> = {};
  const fail = (type: string, n = 1) => {
    counts.failed += n;
    errors[type] = (errors[type] ?? 0) + n;
  };
  const progress = () => o.onProgress?.({ ...counts });
  const known = await mailboxMessageIds(client, o.accountId, o.mailboxId);
  const size = o.batchSize ?? 25;
  let batch: { blobId: Id; receivedAt: string | undefined; messageId: string | null }[] = [];

  const flush = async () => {
    if (!batch.length) return;
    const items = batch;
    batch = [];
    const emails = Object.fromEntries(
      items.map((m, i) => [`m${i}`, { blobId: m.blobId, mailboxIds: { [o.mailboxId]: true }, keywords: { $seen: true }, ...(m.receivedAt ? { receivedAt: m.receivedAt } : {}) }]),
    );
    try {
      const r = await client.call('Email/import', { accountId: o.accountId, emails });
      items.forEach((m, i) => {
        if (r.created?.[`m${i}`]) return void counts.imported++;
        if (m.messageId) known.delete(m.messageId);
        fail(r.notCreated?.[`m${i}`]?.type ?? 'notCreated');
      });
    } catch (e) {
      for (const m of items) if (m.messageId) known.delete(m.messageId);
      fail(errorType(e), items.length);
    }
    progress();
  };

  /** Téléverse un message, en attendant quand le serveur le demande ; `undefined` : échec compté ou annulation. */
  const upload = async (raw: string): Promise<UploadResponse | undefined> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.upload(o.accountId, new Blob([binaryToBytes(raw)], { type: 'message/rfc822' }), 'message/rfc822');
      } catch (e) {
        if (o.signal?.aborted) return undefined;
        const status = e instanceof JmapError ? e.status : undefined;
        let wait: number;
        if (e instanceof JmapError && status === 429) {
          const quota = /quota/i.test(JSON.stringify(e.body ?? ''));
          wait = Math.min((e.retryAfter ?? (quota ? QUOTA_WAIT_S : RATE_WAIT_S)) * 1000 + 1000, MAX_WAIT_MS);
          // les messages déjà téléversés sont importés avant la pause (leurs blobs expirent)
          await flush();
          o.onWait?.(new Date(Date.now() + wait), { ...counts });
        } else if ((status === undefined || status >= 500) && attempt < 3) {
          wait = 2000 * 2 ** attempt;
        } else if (status === undefined) {
          throw e; // réseau toujours coupé : l'import s'arrête
        } else {
          fail(errorType(e));
          return undefined;
        }
        try {
          await sleep(wait, o.signal);
        } catch {
          return undefined;
        }
      }
    }
  };

  for await (const raw of o.messages) {
    if (o.signal?.aborted) break;
    const messageId = rawMessageId(raw);
    if (messageId && known.has(messageId)) {
      counts.skipped++;
      progress();
      continue;
    }
    if (messageId) known.add(messageId);
    const blob = await upload(raw);
    if (!blob) {
      if (messageId) known.delete(messageId);
      continue;
    }
    batch.push({ blobId: blob.blobId, receivedAt: rawMessageDate(raw), messageId });
    if (batch.length >= size) await flush();
  }
  if (!o.signal?.aborted) await flush();
  return { ...counts, aborted: !!o.signal?.aborted, errors };
}

export interface ExportOptions {
  accountId: Id;
  mailboxId: Id;
  /** Écrit un morceau du fichier, dans l'ordre. */
  write: (chunk: Uint8Array<ArrayBuffer>) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Exporte un dossier en mbox (mboxrd), du plus ancien au plus récent : quatre téléchargements à la fois, écrits dans l'ordre. */
export async function exportMessages(client: JmapClient, o: ExportOptions): Promise<{ exported: number; aborted: boolean }> {
  const ids: Id[] = [];
  for (let position = 0; ; ) {
    const q = await client.call('Email/query', { accountId: o.accountId, filter: { inMailbox: o.mailboxId }, sort: [{ property: 'receivedAt', isAscending: true }], position, limit: 500 });
    ids.push(...q.ids);
    position += q.ids.length;
    if (!q.ids.length || position >= (q.total ?? Infinity) || q.ids.length < 500) break;
  }
  o.onProgress?.(0, ids.length);
  let done = 0;
  for (let i = 0; i < ids.length && !o.signal?.aborted; i += 50) {
    const slice = ids.slice(i, i + 50);
    const g = await client.call('Email/get', { accountId: o.accountId, ids: slice, properties: ['id', 'blobId', 'from', 'receivedAt'] });
    // `/get` peut rendre les objets dans un autre ordre que les identifiants (RFC 8620 §5.1)
    const byId = new Map(g.list.map((e) => [e.id, e]));
    const list = slice.flatMap((id) => byId.get(id) ?? []);
    for (let j = 0; j < list.length && !o.signal?.aborted; j += 4) {
      const batch = list.slice(j, j + 4);
      const raws = await Promise.all(batch.map(async (e) => new Uint8Array(await (await client.download(o.accountId, e.blobId, 'message.eml', 'message/rfc822')).arrayBuffer())));
      for (let k = 0; k < batch.length; k++) {
        const e = batch[k]!;
        await o.write(binaryToBytes(mboxEntry(bytesToBinary(raws[k]!), { sender: e.from?.[0]?.email, date: new Date(e.receivedAt) })));
        done++;
      }
      o.onProgress?.(done, ids.length);
    }
  }
  return { exported: done, aborted: !!o.signal?.aborted };
}
