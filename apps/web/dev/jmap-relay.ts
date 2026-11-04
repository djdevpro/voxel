/**
 * Relais JMAP de développement, chargé par `npm run dev:mock` (`VOXEL_MOCK=1`).
 * - `GET /config.json` → `{ "jmap": { "*": "/__jmap/session" } }` ;
 * - `/__jmap/session` → vrai serveur JMAP (`VOXEL_DEV_JMAP_URL`), URL de la session réécrites vers `/__jmap/...` ;
 * - `/__jmap/<chemin>` → même chemin sur l'origine du serveur JMAP (API, upload, download, push, en flux).
 * Même origine que la page : pas de CORS en local. Aucun identifiant écrit sur disque ni journalisé.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const PREFIX = '/__jmap';
const FORWARD = ['authorization', 'accept', 'content-type', 'cache-control', 'last-event-id'];

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Réécrit récursivement les chaînes qui commencent par l'origine du serveur vers le préfixe local. */
function rewrite(v: unknown, origin: string): unknown {
  if (typeof v === 'string') return v.startsWith(origin) ? PREFIX + v.slice(origin.length) : v;
  if (Array.isArray(v)) return v.map((x) => rewrite(x, origin));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x, origin)]));
  return v;
}

export function jmapRelay(): Plugin {
  const sessionUrl = process.env.VOXEL_DEV_JMAP_URL;
  if (!sessionUrl) throw new Error('VOXEL_DEV_JMAP_URL manquant : URL de session JMAP du serveur de test (ex. https://mail.example.com/jmap/session)');
  const origin = new URL(sessionUrl).origin;

  const relay = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').slice(PREFIX.length) || '/';
    const isSession = path === '/session' || path.startsWith('/session?');
    const target = isSession ? sessionUrl : origin + path;
    const headers: Record<string, string> = {};
    for (const h of FORWARD) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    try {
      const body = await readBody(req);
      const up = await fetch(target, { method: req.method, headers, body, redirect: 'follow', signal: ctrl.signal });
      const type = up.headers.get('content-type') ?? '';
      if (isSession && up.ok && type.includes('json')) {
        const json = rewrite(await up.json(), origin);
        res.writeHead(up.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(json));
        return;
      }
      const out: Record<string, string> = {};
      for (const h of ['content-type', 'content-disposition', 'cache-control']) {
        const v = up.headers.get(h);
        if (v) out[h] = v;
      }
      res.writeHead(up.status, out);
      if (!up.body) return void res.end();
      Readable.fromWeb(up.body as import('node:stream/web').ReadableStream).on('error', () => res.end()).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    }
  };

  return {
    name: 'voxel-jmap-relay',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (url === '/config.json' || url.startsWith('/config.json?')) {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ jmap: { '*': `${PREFIX}/session` } }));
          return;
        }
        if (url === PREFIX || url.startsWith(`${PREFIX}/`)) return void relay(req, res);
        next();
      });
    },
  };
}
