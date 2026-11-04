/**
 * Passerelle IMAP légère : sans session, sans cookie, sans identifiant stocké.
 * Chaque requête porte `Authorization: Basic …`, `X-Voxel-Imap`, `X-Voxel-Smtp` et, si l'identifiant n'est pas l'adresse,
 * `X-Voxel-Email` (expéditeur par défaut) ; la façade IMAP → JMAP
 * répond comme un serveur JMAP dont les URL sont relatives à `/imap/`. Aucun en-tête CORS : même origine seulement.
 * Ni `Authorization` ni `X-Voxel-*` ne sont jamais journalisés.
 */
import { Hono, type Context } from 'hono';
import { getBackend, type GatewayTarget, type PoolHandle } from '../backend/pool.js';
import { BackendAuthError, type BackendEvent, type ImapEndpoint, type JmapRequest, type JmapSessionJson } from '../backend/types.js';
import { config } from '../config.js';
import { discover, emailDomain } from '../discovery.js';
import { ApiError, clientIp, readJson, type AppEnv } from '../http.js';
import { isAllowedPort } from '../netguard.js';
import { parseDavUrl } from '../carddav/dav.js';
import { assertNotLimited, recordAttempt } from '../ratelimit.js';

export const imapRoutes = new Hono<AppEnv>();

const MAX_REQUEST = 10 * 1024 * 1024;
const HOST_RE = /^[a-z0-9.-]{1,253}$|^\[[0-9a-f:]{2,45}\]$/i;

// ---------------------------------------------------------------- en-têtes

/** `Authorization: Basic base64(utf8(username:password))` ; null si absent ou mal formé. */
export function parseBasic(header: string | undefined): { username: string; password: string } | null {
  const m = header?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!m) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(m[1]!, 'base64'));
  } catch {
    return null;
  }
  const i = text.indexOf(':');
  if (i <= 0) return null;
  const username = text.slice(0, i).trim();
  const password = text.slice(i + 1);
  if (!username || !password || username.length > 320 || password.length > 1024) return null;
  return { username, password };
}

/** `<hôte>:<port>:<ssl|starttls>` ; null si mal formé ou port non autorisé. */
export function parseEndpoint(kind: 'imap' | 'smtp' | 'sieve', header: string | undefined): ImapEndpoint | null {
  if (!header) return null;
  const parts = header.trim().toLowerCase().split(':');
  if (parts.length < 3) return null;
  const security = parts.pop()!;
  const port = Number(parts.pop());
  const host = parts.join(':');
  if (!HOST_RE.test(host) || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (security !== 'ssl' && security !== 'starttls') return null;
  if (!isAllowedPort(kind, port)) return null;
  return { host: host.replace(/^\[|\]$/g, ''), port, secure: security === 'ssl' };
}

/** Lit et valide les en-têtes ; aucun appel réseau. */
export function targetOf(c: Context): GatewayTarget {
  const creds = parseBasic(c.req.header('authorization'));
  if (!creds) throw new ApiError(401, 'invalid_credentials', 'Basic credentials required');
  const imap = parseEndpoint('imap', c.req.header('x-voxel-imap'));
  const smtp = parseEndpoint('smtp', c.req.header('x-voxel-smtp'));
  if (!imap || !smtp) throw new ApiError(400, 'validation', 'X-Voxel-Imap and X-Voxel-Smtp headers required (host:port:ssl|starttls)');
  const given = c.req.header('x-voxel-email')?.trim().toLowerCase();
  if (given !== undefined && (given.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(given))) {
    throw new ApiError(400, 'validation', 'X-Voxel-Email must be an email address');
  }
  const email = given || (creds.username.includes('@') ? creds.username.toLowerCase() : undefined);
  // ManageSieve : facultatif ; mal formé ou port non autorisé → 400
  const sieveHeader = c.req.header('x-voxel-sieve');
  const sieve = sieveHeader ? parseEndpoint('sieve', sieveHeader) : undefined;
  if (sieve === null) throw new ApiError(400, 'validation', 'X-Voxel-Sieve must be host:port:ssl|starttls (port 4190)');
  // CardDAV : facultatif ; URL https (port 443), sans identifiants
  const davHeader = c.req.header('x-voxel-carddav');
  const carddav = davHeader ? parseDavUrl(davHeader) : undefined;
  if (carddav === null) throw new ApiError(400, 'validation', 'X-Voxel-CardDav must be an https URL (port 443)');
  // CalDAV : mêmes règles
  const calHeader = c.req.header('x-voxel-caldav');
  const caldav = calHeader ? parseDavUrl(calHeader) : undefined;
  if (caldav === null) throw new ApiError(400, 'validation', 'X-Voxel-CalDav must be an https URL (port 443)');
  if (config.allowedEmailDomains.length) {
    const domain = emailDomain(email ?? '');
    if (!config.allowedEmailDomains.includes(domain)) throw new ApiError(403, 'domain_not_allowed', 'domain not allowed on this gateway');
  }
  return { ...creds, ...(email ? { email } : {}), imap, smtp, ...(sieve ? { sieve } : {}), ...(carddav ? { carddav: carddav.href } : {}), ...(caldav ? { caldav: caldav.href } : {}) };
}

/**
 * Façade prête pour ces identifiants. Première utilisation d'une empreinte : vérification IMAP + SMTP,
 * sous la limite d'échecs ; refus → `invalid_credentials` (à la session) ou `upstream_auth` (ailleurs).
 */
async function backendFor(c: Context, onSession = false): Promise<PoolHandle> {
  const t = targetOf(c);
  const ip = clientIp(c);
  const h = getBackend(t, ip);
  if (h.verified) return h;
  assertNotLimited('login', ip, t.username);
  try {
    await h.backend.verify();
    h.markVerified();
    return h;
  } catch (err) {
    h.discard();
    if (err instanceof BackendAuthError) {
      recordAttempt('login', ip, t.username);
      throw new ApiError(401, onSession ? 'invalid_credentials' : 'upstream_auth', 'the mail server rejected the credentials');
    }
    throw err;
  }
}

// ---------------------------------------------------------------- blobs

const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/pdf', 'text/plain']);

/**
 * Type MIME sûr : un seul type `type/sous-type` (charset seulement pour text/*), sinon application/octet-stream.
 * Ne jamais refléter tel quel le type demandé.
 */
export function safeMimeType(raw: string | undefined | null): string {
  const value = (raw ?? '').trim().toLowerCase();
  const m = value.match(/^([a-z0-9][a-z0-9!#$&^_.+-]{0,126})\/([a-z0-9][a-z0-9!#$&^_.+-]{0,126})\s*(?:;\s*(.*))?$/);
  if (!m) return 'application/octet-stream';
  const base = `${m[1]}/${m[2]}`;
  if (m[1] === 'text' && m[3]) {
    const cs = m[3].match(/^charset="?([a-z0-9._-]{1,40})"?\s*$/);
    if (cs) return `${base}; charset=${cs[1]}`;
  }
  return base;
}

export function blobHeaders(rawType: string, name: string, wantInline: boolean): Record<string, string> {
  const type = safeMimeType(rawType);
  const base = type.split(';')[0]!;
  const inline = wantInline && INLINE_TYPES.has(base);
  const safeAscii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    'Content-Type': type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  };
}

async function readTextLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------- routes

imapRoutes.get('/session', async (c) => {
  const { backend } = await backendFor(c, true);
  // protocoles compagnons (ManageSieve, QUOTA, CardDAV) : vérifiés une fois, résultat gardé par la façade
  await backend.probe?.();
  const session = await backend.session();
  const capabilities = { ...session.capabilities };
  delete capabilities['urn:ietf:params:jmap:websocket'];
  const out: JmapSessionJson = {
    ...session,
    capabilities,
    apiUrl: '/imap/api',
    downloadUrl: '/imap/download/{accountId}/{blobId}/{name}?type={type}',
    uploadUrl: '/imap/upload/{accountId}',
    eventSourceUrl: '/imap/events?types={types}&closeafter={closeafter}&ping={ping}',
  };
  c.header('Cache-Control', 'no-store');
  return c.json(out);
});

imapRoutes.post('/api', async (c) => {
  const { backend } = await backendFor(c);
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_REQUEST) throw new ApiError(413, 'validation', 'request too large');
  const text = await readTextLimited(c.req.raw.body, MAX_REQUEST);
  if (text === null) return c.json({ type: 'urn:ietf:params:jmap:error:limit', limit: 'maxSizeRequest', status: 413 }, 413);
  let req: JmapRequest;
  try {
    req = JSON.parse(text) as JmapRequest;
  } catch {
    return c.json({ type: 'urn:ietf:params:jmap:error:notJSON', status: 400 }, 400);
  }
  if (!req || !Array.isArray(req.using) || !Array.isArray(req.methodCalls)) {
    return c.json({ type: 'urn:ietf:params:jmap:error:notRequest', status: 400 }, 400);
  }
  c.header('Cache-Control', 'no-store');
  return c.json(await backend.api(req));
});

imapRoutes.post('/upload/:accountId', async (c) => {
  const { backend } = await backendFor(c);
  const body = c.req.raw.body;
  if (!body) throw new ApiError(400, 'validation', 'empty upload');
  const res = await backend.upload(c.req.param('accountId'), body, safeMimeType(c.req.header('content-type') ?? 'application/octet-stream'));
  c.header('Cache-Control', 'no-store');
  return c.json(res, 201);
});

async function download(c: Context<AppEnv>): Promise<Response> {
  const { backend } = await backendFor(c);
  const name = c.req.param('name') ?? 'download';
  const requested = c.req.query('type') || undefined;
  const type = requested ? safeMimeType(requested) : undefined;
  const res = await backend.download(c.req.param('accountId') ?? '', c.req.param('blobId') ?? '', name, type);
  const headers = blobHeaders(res.type, name, c.req.query('inline') === '1');
  if (res.size !== undefined) headers['Content-Length'] = String(res.size);
  return new Response(res.body, { status: 200, headers });
}

imapRoutes.get('/download/:accountId/:blobId/:name', download);
imapRoutes.get('/download/:accountId/:blobId', download);

// Flux d'événements JMAP (RFC 8620 §7.3) depuis IMAP IDLE ; pings émis par la passerelle.
imapRoutes.get('/events', async (c) => {
  const { backend } = await backendFor(c);
  const typesParam = c.req.query('types') ?? '*';
  const types = typesParam === '*' || !typesParam ? [] : typesParam.split(',').map((s) => s.trim()).filter(Boolean);
  const closeAfterState = c.req.query('closeafter') === 'state';
  const pingRaw = Number(c.req.query('ping') ?? '30');
  const ping = Number.isFinite(pingRaw) && pingRaw > 0 ? Math.min(Math.max(Math.round(pingRaw), 5), 300) : 0;

  const abort = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          abort.abort();
        }
      };
      const finish = () => {
        if (timer) clearInterval(timer);
        abort.abort();
        try {
          controller.close();
        } catch {
          /* déjà fermé */
        }
      };
      controller.enqueue(encoder.encode(': ok\n\n'));
      if (ping) timer = setInterval(() => send('ping', { interval: ping }), ping * 1000);
      void (async () => {
        try {
          for await (const ev of backend.events(types, abort.signal) as AsyncIterable<BackendEvent>) {
            if (ev.type !== 'state') continue;
            send('state', ev.data);
            if (closeAfterState) break;
          }
        } catch (err) {
          if (!abort.signal.aborted) console.warn('[voxel] events:', (err as Error).message);
        } finally {
          finish();
        }
      })();
    },
    cancel() {
      if (timer) clearInterval(timer);
      abort.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// Découverte : JMAP → le navigateur s'y connecte directement ; IMAP → serveurs à utiliser.
imapRoutes.post('/discover', async (c) => {
  const ip = clientIp(c);
  const body = await readJson<{ email: string }>(c);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new ApiError(400, 'validation', 'valid email required');
  assertNotLimited('discover', ip);
  recordAttempt('discover', ip);
  const d = await discover(email);
  c.header('Cache-Control', 'no-store');
  if (!d) return c.json({ protocol: null });
  if (d.protocol === 'jmap') return c.json({ protocol: 'jmap', sessionUrl: d.sessionUrl });
  const ep = (e: ImapEndpoint) => ({ host: e.host, port: e.port, security: e.secure ? 'ssl' : 'starttls' });
  return c.json({
    protocol: 'imap',
    imap: ep(d.imap),
    smtp: ep(d.smtp),
    ...(d.sieve ? { sieve: ep(d.sieve) } : {}),
    ...(d.carddav ? { carddav: d.carddav } : {}),
    ...(d.caldav ? { caldav: d.caldav } : {}),
    ...(d.username ? { username: d.username } : {}),
  });
});

imapRoutes.all('*', () => {
  throw new ApiError(404, 'not_found', 'unknown route');
});
