/**
 * Mode démo, chargé par `npm run dev:demo` (`VOXEL_DEMO=1`) :
 * - `GET /config.json` → `{ "jmap": { "*": "/__demo/jmap/session" } }` ;
 * - `/__demo/jmap/*` → serveur JMAP en mémoire (session, API, upload, download, flux d'événements), Basic obligatoire ;
 * - `/__demo/llm/v1/*` → LLM simulé compatible OpenAI.
 * Identifiants : une adresse et un mot de passe non vide (`demo`). Données perdues à l'arrêt de Vite.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { DemoAccount } from './jmap.ts';
import { handleLlm } from './llm.ts';
import { seedFor } from './seed.ts';

const JMAP = '/__demo/jmap';
const LLM = '/__demo/llm/v1';
const accounts = new Map<string, DemoAccount>();

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Compte de l'en-tête Basic, créé au premier accès. */
function authenticate(req: IncomingMessage): DemoAccount | undefined {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return undefined;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  const user = decoded.slice(0, i).trim().toLowerCase();
  if (i < 0 || !user.includes('@') || !decoded.slice(i + 1)) return undefined;
  let acc = accounts.get(user);
  if (!acc) {
    acc = new DemoAccount(user, seedFor(user));
    accounts.set(user, acc);
  }
  return acc;
}

function session(acc: DemoAccount) {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': {
        maxSizeUpload: 50_000_000, maxConcurrentUpload: 4, maxSizeRequest: 10_000_000, maxConcurrentRequests: 8,
        maxCallsInRequest: 64, maxObjectsInGet: 1000, maxObjectsInSet: 1000, collationAlgorithms: ['i;ascii-casemap', 'i;unicode-casemap'],
      },
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:submission': {},
    },
    accounts: {
      [acc.id]: {
        name: acc.username, isPersonal: true, isReadOnly: false,
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {
            maxMailboxesPerEmail: null, maxMailboxDepth: 10, maxSizeMailboxName: 255, maxSizeAttachmentsPerEmail: 50_000_000,
            emailQuerySortOptions: ['receivedAt', 'sentAt', 'size', 'from', 'to', 'subject'], mayCreateTopLevelMailbox: true,
          },
          'urn:ietf:params:jmap:submission': { maxDelayedSend: 0, submissionExtensions: {} },
        },
      },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': acc.id, 'urn:ietf:params:jmap:submission': acc.id },
    username: acc.username,
    apiUrl: `${JMAP}/api`,
    downloadUrl: `${JMAP}/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${JMAP}/upload/{accountId}/`,
    eventSourceUrl: `${JMAP}/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    state: 'demo-1',
  };
}

/** Flux d'événements (RFC 8620 §7.3), lu par `fetch` avec `Authorization` côté client. */
function eventSource(acc: DemoAccount, url: URL, req: IncomingMessage, res: ServerResponse) {
  const ping = Math.max(1, Number(url.searchParams.get('ping')) || 30);
  const closeAfterState = url.searchParams.get('closeafter') === 'state';
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': demo\n\n');
  const off = acc.onChange((changed) => {
    res.write(`event: state\ndata: ${JSON.stringify({ '@type': 'StateChange', changed: { [acc.id]: changed } })}\n\n`);
    if (closeAfterState) res.end();
  });
  const timer = setInterval(() => res.write(`event: ping\ndata: ${JSON.stringify({ interval: ping })}\n\n`), ping * 1000);
  const stop = () => {
    clearInterval(timer);
    off();
  };
  req.on('close', stop);
  res.on('close', stop);
}

async function handleJmap(req: IncomingMessage, res: ServerResponse, url: URL) {
  const acc = authenticate(req);
  if (!acc) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="demo"', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'about:blank', status: 401, detail: 'Authentication required' }));
    return;
  }
  const path = url.pathname.slice(JMAP.length);
  if (path === '/session' && req.method === 'GET') return json(res, 200, session(acc));
  if (path === '/api' && req.method === 'POST') {
    let body: { methodCalls?: unknown; createdIds?: Record<string, string> };
    try {
      body = JSON.parse((await readBody(req)).toString('utf8')) as typeof body;
    } catch {
      return json(res, 400, { type: 'urn:ietf:params:jmap:error:notJSON', status: 400, detail: 'Invalid JSON' });
    }
    if (!Array.isArray(body.methodCalls)) return json(res, 400, { type: 'urn:ietf:params:jmap:error:notRequest', status: 400, detail: 'methodCalls missing' });
    const r = acc.handle(body.methodCalls as Array<[string, Record<string, unknown>, string]>, body.createdIds);
    return json(res, 200, { methodResponses: r.methodResponses, sessionState: 'demo-1', ...(body.createdIds ? { createdIds: r.createdIds } : {}) });
  }
  const up = /^\/upload\/([^/]+)\/?$/.exec(path);
  if (up && req.method === 'POST') {
    if (decodeURIComponent(up[1]!) !== acc.id) return json(res, 404, { type: 'about:blank', status: 404, detail: 'Unknown account' });
    const data = await readBody(req);
    const type = req.headers['content-type'] ?? 'application/octet-stream';
    return json(res, 201, { accountId: acc.id, blobId: acc.addBlob(data, type), type, size: data.length });
  }
  const down = /^\/download\/([^/]+)\/([^/]+)\/([^/]*)$/.exec(path);
  if (down && req.method === 'GET') {
    const blob = decodeURIComponent(down[1]!) === acc.id ? acc.getBlob(decodeURIComponent(down[2]!)) : undefined;
    if (!blob) return json(res, 404, { type: 'about:blank', status: 404, detail: 'Blob not found' });
    const name = decodeURIComponent(down[3]!) || 'download';
    res.writeHead(200, {
      'content-type': url.searchParams.get('type') || blob.type,
      'content-length': blob.data.length,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, max-age=3600',
    });
    res.end(blob.data);
    return;
  }
  if (path === '/eventsource' && req.method === 'GET') return eventSource(acc, url, req, res);
  json(res, 404, { type: 'about:blank', status: 404, detail: 'Not found' });
}

export function demoServer(): Plugin {
  return {
    name: 'voxel-demo-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://demo.local');
        if (url.pathname === '/config.json') return json(res, 200, { jmap: { '*': `${JMAP}/session` }, accountPortal: {} });
        if (url.pathname === JMAP || url.pathname.startsWith(`${JMAP}/`)) {
          handleJmap(req, res, url).catch((e: unknown) => {
            if (!res.headersSent) json(res, 500, { type: 'about:blank', status: 500, detail: e instanceof Error ? e.message : 'error' });
            else res.end();
          });
          return;
        }
        if (url.pathname.startsWith(`${LLM}/`)) {
          handleLlm(req, res, url.pathname.slice(LLM.length)).catch(() => {
            if (!res.headersSent) json(res, 500, { error: { message: 'Demo LLM failure' } });
            else res.end();
          });
          return;
        }
        next();
      });
    },
  };
}
