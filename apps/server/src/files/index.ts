/**
 * Pièces jointes volumineuses : au-delà du seuil (1 Mo), une pièce jointe est déposée dans S3 et le message
 * porte un lien de téléchargement à la place du fichier.
 *
 * - Le serveur est le plan de contrôle : il vérifie l'expéditeur (identity.ts), crée son compte de stockage à
 *   sa première utilisation, réserve la taille dans son espace (1 Go), signe l'envoi et le lien. Le moteur S3
 *   est celui de S3 Drive (`vendor/ud-s3`), chargé seulement quand la fonction est configurée.
 * - Les octets vont du navigateur à S3 par une URL présignée (PUT, `Content-Length` signé) ; si le bucket
 *   refuse l'origine (CORS), le navigateur les envoie au serveur, qui les relaie (`PUT …/data`).
 * - `/f/<id>/<nom>` est le lien du message : public, il redirige vers une URL présignée de 5 min, tant que le
 *   lien vit (30 jours) ; ensuite, une tâche horaire supprime l'objet et libère l'espace.
 */
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { config } from '../config.js';
import { ApiError, readJson, type AppEnv } from '../http.js';
import { safeMimeType } from '../routes/imap.js';
import { S3Error } from '../vendor/ud-s3/errors.js';
import type { UdS3 } from '../vendor/ud-s3/types.js';
import { verifySender, type Sender } from './identity.js';
import { readFilesSettings, type FilesSettings } from './settings.js';
import { FilesStore, type FileRow } from './store.js';

/** Ce que le module utilise du moteur S3. */
export type FilesEngine = Pick<UdS3, 'presignPut' | 'presignGet' | 'headObject' | 'deleteObject' | 'deleteObjects'>;

export interface FilesModule {
  api: Hono<AppEnv>;
  links: Hono<AppEnv>;
  /** Supprime de S3 puis de la base les fichiers expirés ; nombre de fichiers retirés. */
  sweep(): Promise<number>;
  close(): void;
}

const UPLOAD_SECONDS = 3600;
/** Délai de grâce d'une réservation après l'expiration de son URL d'envoi (confirmation tardive). */
const UPLOAD_GRACE_MS = 15 * 60_000;
const DOWNLOAD_SECONDS = 300;
const SWEEP_MS = 60 * 60_000;
const DAY_MS = 24 * 3600_000;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Nom de fichier affiché : sans caractères de contrôle ni séparateurs de chemin, 255 caractères au plus. */
export function cleanName(raw: unknown): string {
  const name = (typeof raw === 'string' ? raw : '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
    .slice(0, 255);
  return name || 'file';
}

function newId(): string {
  return randomBytes(16).toString('base64url');
}

/** Erreur du stockage : code stable pour le client, détail dans le journal seulement. */
function storageError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const code = e instanceof S3Error ? e.code : 'internal';
  console.warn('[voxel] pièces jointes volumineuses : erreur du stockage :', code, (e as Error)?.message);
  return new ApiError(502, 'storage_error', 'the file storage failed');
}

async function storage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw storageError(e);
  }
}

/** Envoie le corps de la requête à l'URL présignée (relais), avec la longueur exacte, sans découpage. */
function relayPut(url: string, headers: Record<string, string>, body: ReadableStream<Uint8Array>, size: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(target, { method: 'PUT', headers: { ...headers, 'content-length': String(size) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', reject);
    });
    req.on('error', reject);
    Readable.fromWeb(body as never).on('error', (e) => req.destroy(e)).pipe(req);
  });
}

function unavailable(c: Context): Response {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
  return c.text('Ce fichier n’est plus disponible.\nThis file is no longer available.\n', 404);
}

/**
 * Module des pièces jointes volumineuses. Sans réglages, seul `GET /files/config` répond (`enabled: false`).
 * `deps` remplace la base et le moteur S3 dans les tests.
 */
export function createFiles(settings: FilesSettings | null = readFilesSettings(), deps: { store?: FilesStore; engine?: FilesEngine } = {}): FilesModule {
  const api = new Hono<AppEnv>();
  const links = new Hono<AppEnv>();
  if (!settings) {
    api.get('/config', (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json({ enabled: false });
    });
    return { api, links, sweep: async () => 0, close: () => undefined };
  }
  const s = settings;
  const store = deps.store ?? new FilesStore(join(config.dataDir, 'files.sqlite'));
  let enginePromise: Promise<FilesEngine> | undefined = deps.engine ? Promise.resolve(deps.engine) : undefined;
  const engine = () =>
    (enginePromise ??= import('../vendor/ud-s3/client.js').then(({ createS3 }) =>
      createS3({
        endpoint: s.endpoint,
        region: s.region,
        addressing: s.addressing,
        credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
        allowPrivate: s.allowPrivate,
        maxAttempts: 3,
      }),
    ).catch((e: unknown) => {
      enginePromise = undefined;
      throw e;
    }));

  /** Fichier en attente d'envoi de cet expéditeur, sinon 404. */
  const pendingOf = (sender: Sender, id: string): FileRow => {
    const row = ID_RE.test(id) ? store.file(id) : undefined;
    if (!row || row.account_id !== sender.accountId || row.state !== 'pending' || row.expires_at <= Date.now()) {
      throw new ApiError(404, 'not_found', 'upload not found');
    }
    return row;
  };

  const linkOf = (row: FileRow) => ({
    id: row.id,
    name: row.name,
    size: row.size,
    type: row.type,
    url: `/f/${row.id}/${encodeURIComponent(row.name)}`,
    expiresAt: new Date(row.expires_at).toISOString(),
  });

  api.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  api.get('/config', (c) => c.json({ enabled: true, threshold: s.threshold, quota: s.quota, linkDays: s.linkDays }));

  /** Compte de l'expéditeur : existe-t-il déjà, et quel espace utilise-t-il ? */
  api.get('/account', async (c) => {
    const sender = await verifySender(c, s);
    const row = store.account(sender.accountId);
    return c.json({
      exists: !!row,
      createdAt: row ? new Date(row.created_at).toISOString() : null,
      used: store.usage(sender.accountId, Date.now()),
      quota: s.quota,
      threshold: s.threshold,
      linkDays: s.linkDays,
    });
  });

  /** Réserve la taille dans l'espace du compte (créé s'il n'existe pas) et signe l'envoi direct vers S3. */
  api.post('/uploads', async (c) => {
    const sender = await verifySender(c, s);
    const body = await readJson<{ name: unknown; size: unknown; type: unknown }>(c);
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 1) throw new ApiError(400, 'validation', 'size must be a positive integer');
    const name = cleanName(body.name);
    const type = safeMimeType(typeof body.type === 'string' ? body.type : '');
    const now = Date.now();
    // Réservation avant toute attente : deux envois simultanés ne dépassent pas l'espace ensemble.
    const created = store.ensureAccount(sender.accountId, sender.email, now);
    const used = store.usage(sender.accountId, now);
    if (size > s.quota || used + size > s.quota) {
      throw new ApiError(403, 'quota_exceeded', 'not enough space left', {}, { used: String(used), quota: String(s.quota) });
    }
    const id = newId();
    const row: FileRow = {
      id,
      account_id: sender.accountId,
      object_key: `${s.prefix}${sender.accountId.slice(0, 32)}/${id}`,
      name,
      type,
      size,
      state: 'pending',
      created_at: now,
      expires_at: now + UPLOAD_SECONDS * 1000 + UPLOAD_GRACE_MS,
    };
    store.insert(row);
    try {
      const signed = await storage(async () => (await engine()).presignPut({ bucket: s.bucket, key: row.object_key, expiresIn: UPLOAD_SECONDS, contentLength: size, contentType: type }));
      return c.json(
        {
          id,
          upload: { url: signed.url, headers: signed.headers, expiresAt: signed.expiresAt ?? null },
          account: { created, used: used + size, quota: s.quota },
        },
        201,
      );
    } catch (e) {
      store.delete(id);
      throw e;
    }
  });

  /** Relais : le navigateur n'a pas pu écrire dans S3 (CORS du bucket) ; le serveur le fait à sa place. */
  api.put('/uploads/:id/data', async (c) => {
    const sender = await verifySender(c, s);
    const row = pendingOf(sender, c.req.param('id'));
    if (Number(c.req.header('content-length')) !== row.size || !c.req.raw.body) {
      throw new ApiError(400, 'validation', 'Content-Length must be the declared size');
    }
    const signed = await storage(async () => (await engine()).presignPut({ bucket: s.bucket, key: row.object_key, expiresIn: 600, contentLength: row.size, contentType: row.type }));
    const status = await relayPut(signed.url, signed.headers, c.req.raw.body, row.size).catch((e: unknown) => {
      throw storageError(e);
    });
    if (status < 200 || status >= 300) throw storageError(new Error(`relay PUT ${status}`));
    return c.body(null, 204);
  });

  /** Confirme l'envoi (taille relue dans S3) et ouvre le lien pour `linkDays` jours. */
  api.post('/uploads/:id/complete', async (c) => {
    const sender = await verifySender(c, s);
    const row = pendingOf(sender, c.req.param('id'));
    let head: Awaited<ReturnType<FilesEngine['headObject']>>;
    try {
      head = await (await engine()).headObject({ bucket: s.bucket, key: row.object_key });
    } catch (e) {
      if (e instanceof S3Error && e.code === 'key_not_found') throw new ApiError(404, 'not_found', 'the file has not been received');
      throw storageError(e);
    }
    if (head.size !== row.size) {
      store.delete(row.id);
      await engine()
        .then((e) => e.deleteObject({ bucket: s.bucket, key: row.object_key }))
        .catch(() => undefined);
      throw new ApiError(400, 'validation', 'the received file does not have the declared size');
    }
    const expiresAt = Date.now() + s.linkDays * DAY_MS;
    store.markReady(row.id, expiresAt);
    return c.json(linkOf({ ...row, state: 'ready', expires_at: expiresAt }));
  });

  /** Retire un fichier (pièce jointe enlevée, brouillon abandonné) et libère son espace. */
  api.delete('/:id', async (c) => {
    const sender = await verifySender(c, s);
    const id = c.req.param('id');
    const row = ID_RE.test(id) ? store.file(id) : undefined;
    if (!row || row.account_id !== sender.accountId) throw new ApiError(404, 'not_found', 'file not found');
    // Espace libéré tout de suite ; si S3 refuse maintenant, le nettoyage horaire réessaiera.
    store.expire(row.id, Date.now());
    await storage(async () => (await engine()).deleteObject({ bucket: s.bucket, key: row.object_key }));
    store.delete(row.id);
    return c.body(null, 204);
  });

  /** Lien du message : redirection vers une URL de téléchargement de 5 min, tant que le lien vit. */
  const download = async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const row = ID_RE.test(id) ? store.file(id) : undefined;
    if (!row || row.state !== 'ready' || row.expires_at <= Date.now()) return unavailable(c);
    const signed = await storage(async () =>
      (await engine()).presignGet({ bucket: s.bucket, key: row.object_key, expiresIn: DOWNLOAD_SECONDS, disposition: 'attachment', filename: row.name, contentType: row.type }),
    );
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex');
    return c.redirect(signed.url, 302);
  };
  links.get('/:id', download);
  links.get('/:id/:name', download);

  const sweep = async (): Promise<number> => {
    const rows = store.expired(Date.now());
    if (!rows.length) return 0;
    const e = await engine();
    const r = await e.deleteObjects({ bucket: s.bucket, keys: rows.map((row) => ({ key: row.object_key })) });
    const failed = new Set(r.errors.filter((x) => x.code !== 'key_not_found').map((x) => x.key));
    let removed = 0;
    for (const row of rows) {
      if (failed.has(row.object_key)) continue;
      store.delete(row.id);
      removed += 1;
    }
    return removed;
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  if (!deps.store) {
    const run = () => void sweep().catch((e: unknown) => console.warn('[voxel] pièces jointes volumineuses : nettoyage reporté :', (e as Error).message));
    setTimeout(run, 60_000).unref();
    timer = setInterval(run, SWEEP_MS);
    timer.unref();
    console.log(`[voxel] pièces jointes volumineuses : S3 ${s.endpoint}, bucket ${s.bucket}, seuil ${s.threshold} o, ${s.quota} o par compte, liens de ${s.linkDays} jours`);
  }

  return {
    api,
    links,
    sweep,
    close: () => {
      if (timer) clearInterval(timer);
      store.close();
    },
  };
}
