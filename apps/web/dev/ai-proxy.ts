/**
 * Proxy CORS de développement pour les fournisseurs d'IA (serveur Vite seulement, jamais dans le build) :
 * `/__ai-proxy/<encodeURIComponent(baseUrl)>/<chemin>?<query>` → `baseUrl/<chemin>?<query>`, réponse en flux.
 * Sert à essayer un fournisseur qui refuse les appels depuis le navigateur. Rien n'est journalisé.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const PREFIX = '/__ai-proxy/';
const FORWARD = ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access', 'content-type', 'accept'];

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method !== 'POST') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fail(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

async function proxy(req: IncomingMessage, res: ServerResponse) {
  // uniquement depuis l'appli elle-même : pas de requête d'un autre site, en-tête ajouté par `models.ts`
  if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['x-voxel-dev-proxy'] !== '1') return fail(res, 403, 'Forbidden');
  const rest = (req.url ?? '').slice(PREFIX.length);
  const q = rest.indexOf('?');
  const pathPart = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? '' : rest.slice(q);
  const slash = pathPart.indexOf('/');
  let base: string;
  try {
    base = decodeURIComponent(slash < 0 ? pathPart : pathPart.slice(0, slash)).replace(/\/+$/, '');
  } catch {
    return fail(res, 400, 'Invalid base URL');
  }
  if (!/^https?:\/\/[^\s/]+/i.test(base)) return fail(res, 400, 'Base URL must start with http:// or https://');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return void res.end();
  }
  if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const target = `${base}/${slash < 0 ? '' : pathPart.slice(slash + 1)}${query}`;
  const headers: Record<string, string> = {};
  for (const h of FORWARD) {
    const v = req.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  try {
    const body = await readBody(req);
    const up = await fetch(target, { method: req.method, headers, body, redirect: 'manual', signal: ctrl.signal });
    const out: Record<string, string> = { 'cache-control': 'no-store' };
    const type = up.headers.get('content-type');
    if (type) out['content-type'] = type;
    res.writeHead(up.status, out);
    if (!up.body) return void res.end();
    Readable.fromWeb(up.body as import('node:stream/web').ReadableStream).on('error', () => res.end()).pipe(res);
  } catch {
    if (!res.headersSent) fail(res, 502, 'Upstream unreachable');
    else res.end();
  }
}

export function aiDevProxy(): Plugin {
  return {
    name: 'voxel-ai-dev-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').startsWith(PREFIX)) return void proxy(req, res);
        next();
      });
    },
  };
}
