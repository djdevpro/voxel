/** Sert le front buildé (apps/web/dist) avec repli SPA sur index.html. */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { config } from './config.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Les images distantes des mails sont affichées à la demande dans l'iframe sandboxée (qui hérite de cette CSP).
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // JMAP et fournisseurs IA appelés directement par le navigateur (https), Deepgram en WebSocket (wss),
  // Ollama sur le poste de l'utilisateur (http://localhost)
  "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:*",
  "frame-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** En-têtes de sécurité de toutes les réponses. */
export function securityHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  };
  if (config.csp !== 'off') h['Content-Security-Policy'] = config.csp || DEFAULT_CSP;
  return h;
}

function fileResponse(path: string, c: Context, isIndex: boolean): Response {
  const st = statSync(path);
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Length': String(st.size),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  const rel = path.slice(config.webDist.length).replaceAll('\\', '/');
  if (isIndex || rel === '/sw.js' || rel === '/registerSW.js' || rel === '/config.json' || rel.endsWith('.webmanifest') || rel.startsWith('/workbox-')) {
    headers['Cache-Control'] = 'no-cache';
  } else if (rel.startsWith('/assets/')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'public, max-age=3600';
  }
  if (type.startsWith('text/html')) headers['X-Frame-Options'] = 'DENY';
  if (c.req.method === 'HEAD') return new Response(null, { headers });
  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
  return new Response(stream, { headers });
}

/** Préfixes jamais servis par le front (gérés par leurs routes ; 404 propre si inconnus). */
const RESERVED = /^\/(?:imap|healthz)(?:\/|$)/;

/**
 * Requête de navigation (barre d'adresse, lien, rechargement) : elle reçoit toujours index.html,
 * même si l'URL contient des points ou un @ (/m/alice@example.com/inbox).
 */
function isNavigation(c: Context): boolean {
  const mode = c.req.header('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return (c.req.header('accept') ?? '').includes('text/html');
}

/** Chemin qui ressemble à un fichier statique (extension connue) : 404 s'il manque, pour une requête hors navigation. */
function looksLikeAsset(pathname: string): boolean {
  return pathname.startsWith('/assets/') || extname(pathname).toLowerCase() in TYPES;
}

export function serveWeb(c: Context): Response | null {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return null;
  const root = config.webDist;
  const index = join(root, 'index.html');
  if (!existsSync(index)) return null;
  const rawPath = new URL(c.req.url).pathname;
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    // Encodage invalide : jamais un fichier ; une navigation reçoit l'appli (qui affichera sa propre erreur).
    return isNavigation(c) && !RESERVED.test(rawPath) ? fileResponse(index, c, true) : null;
  }
  if (RESERVED.test(pathname) || pathname.includes('\0')) return null;
  // normalize(join()) résout les « .. » : on vérifie ensuite que le résultat reste sous la racine du dist.
  const candidate = normalize(join(root, pathname));
  const inside = candidate === root || candidate.startsWith(root + sep);
  if (!inside) return null;
  if (candidate !== root && existsSync(candidate)) {
    try {
      if (statSync(candidate).isFile()) return fileResponse(candidate, c, candidate === index);
    } catch {
      /* fichier disparu entre-temps : traité comme absent */
    }
  }
  // Un asset buildé manquant reste un 404 (sinon le navigateur exécuterait index.html comme script).
  if (pathname.startsWith('/assets/')) return null;
  if (isNavigation(c) || !looksLikeAsset(pathname)) return fileResponse(index, c, true);
  return null;
}
