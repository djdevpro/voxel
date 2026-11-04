/**
 * Outils communs de la façade IMAP : identifiants, erreurs JMAP, cache LRU, pointeurs JSON.
 */
import { createHash, randomBytes } from 'node:crypto';

// ------------------------------------------------------------------ erreurs JMAP

/** Erreur de méthode JMAP (RFC 8620 §3.6.2) : renvoyée comme `["error", {type, description}, callId]`. */
export class MethodError extends Error {
  readonly type: string;
  readonly extra: Record<string, unknown> | undefined;
  constructor(type: string, description?: string, extra?: Record<string, unknown>) {
    super(description ?? type);
    this.name = 'MethodError';
    this.type = type;
    this.extra = extra;
  }
  toJSON(): Record<string, unknown> {
    return { type: this.type, ...(this.message && this.message !== this.type ? { description: this.message } : {}), ...(this.extra ?? {}) };
  }
}

/** Erreur par objet dans un `/set` (SetError, RFC 8620 §5.3). */
export class SetError extends Error {
  readonly type: string;
  readonly properties: string[] | undefined;
  constructor(type: string, description?: string, properties?: string[]) {
    super(description ?? type);
    this.name = 'SetError';
    this.type = type;
    this.properties = properties;
  }
  toJSON(): Record<string, unknown> {
    return { type: this.type, ...(this.message && this.message !== this.type ? { description: this.message } : {}), ...(this.properties ? { properties: this.properties } : {}) };
  }
}

export function setErrorOf(e: unknown): Record<string, unknown> {
  if (e instanceof SetError) return e.toJSON();
  if (e instanceof MethodError) return { type: e.type === 'notFound' ? 'notFound' : 'invalidProperties', description: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  return { type: 'serverFail', description: msg };
}

// ------------------------------------------------------------------ hachage et ids

export function hashOf(input: string, len = 16): string {
  return createHash('sha256').update(input).digest('base64url').slice(0, len);
}

export function randomHex(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

/** Id court en base 36 (caractères [a-z0-9]). */
export function randomBase36(len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[buf[i]! % 36];
  return out;
}

function bigToBase36(v: bigint): string {
  return v.toString(36);
}

function base36ToBig(s: string): bigint | null {
  if (!/^[0-9a-z]+$/.test(s)) return null;
  let v = 0n;
  for (const ch of s) v = v * 36n + BigInt(parseInt(ch, 36));
  return v;
}

export interface EmailKey {
  mbId: string;
  uidValidity: bigint;
  uid: number;
}

/** Id d'email = `<mailboxId>-<UIDVALIDITY base36>-<UID base36>` (id de dossier en [a-z0-9], préfixe `m`). */
export function encodeEmailId(mbId: string, uidValidity: bigint, uid: number): string {
  return `${mbId}-${bigToBase36(uidValidity)}-${uid.toString(36)}`;
}

export function decodeEmailId(id: string): EmailKey | null {
  if (typeof id !== 'string' || !id.startsWith('m')) return null;
  const parts = id.split('-');
  if (parts.length !== 3) return null;
  const [mbId, v, u] = parts as [string, string, string];
  const uidValidity = base36ToBig(v);
  const uid = parseInt(u, 36);
  if (!/^m[0-9a-z]+$/.test(mbId) || uidValidity === null || !Number.isFinite(uid) || uid <= 0) return null;
  return { mbId, uidValidity, uid };
}

/** Ensemble de séquences IMAP compact (`1:4,7,9:12`) à partir d'UID. */
export function toSeqSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i]!;
    out.push(start === end ? String(start) : `${start}:${end}`);
    i++;
  }
  return out.join(',');
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ------------------------------------------------------------------ cache LRU

export class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
  }
  delete(key: K): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

// ------------------------------------------------------------------ pointeurs JSON (références arrière)

export function unescapePointerToken(t: string): string {
  return t.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Évalue un pointeur JSON avec l'extension `*` de JMAP (RFC 8620 §3.7). */
export function evalPointer(value: unknown, path: string): unknown {
  if (path === '' || path === '/') return value;
  if (!path.startsWith('/')) throw new MethodError('invalidResultReference', `bad path ${path}`);
  const tokens = path.slice(1).split('/').map(unescapePointerToken);
  const walk = (obj: unknown, toks: string[]): unknown => {
    if (!toks.length) return obj;
    const [t, ...rest] = toks as [string, ...string[]];
    if (Array.isArray(obj)) {
      if (t === '*') {
        const out: unknown[] = [];
        for (const item of obj) {
          const v = walk(item, rest);
          if (Array.isArray(v)) out.push(...v);
          else out.push(v);
        }
        return out;
      }
      const i = Number(t);
      if (!Number.isInteger(i) || i < 0 || i >= obj.length) throw new MethodError('invalidResultReference', `index ${t} out of range`);
      return walk(obj[i], rest);
    }
    if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, t)) return walk((obj as Record<string, unknown>)[t], rest);
    throw new MethodError('invalidResultReference', `path ${path} not found`);
  };
  return walk(value, tokens);
}

// ------------------------------------------------------------------ divers

export function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function utcDate(d: Date | string | number | undefined | null): string | null {
  if (d === undefined || d === null) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function bufferFromStream(stream: AsyncIterable<Uint8Array | Buffer | string>): Promise<Buffer> {
  return (async () => {
    const parts: Buffer[] = [];
    for await (const c of stream) parts.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c));
    return Buffer.concat(parts);
  })();
}

export function streamFromBuffer(buf: Buffer | Uint8Array): ReadableStream<Uint8Array> {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      const size = 64 * 1024;
      for (let i = 0; i < bytes.length; i += size) ctrl.enqueue(bytes.slice(i, i + size));
      ctrl.close();
    },
  });
}
