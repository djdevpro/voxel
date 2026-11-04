/**
 * Client ManageSieve (RFC 5804), minimal : TLS implicite ou STARTTLS, `AUTHENTICATE "PLAIN"`, `CAPABILITY`,
 * `LISTSCRIPTS`, `GETSCRIPT`, `PUTSCRIPT`, `CHECKSCRIPT`, `SETACTIVE`, `DELETESCRIPT`, `RENAMESCRIPT`,
 * `HAVESPACE`, `LOGOUT`.
 *
 * Le transport est injecté (`connect`, `upgrade`) : la production passe par `netguard` (adresses publiques
 * épinglées, port 4190), les tests par un faux serveur en mémoire. Les commandes sont sérialisées ; délais et
 * tailles bornés. Rien de sensible n'est journalisé.
 */
import type { Duplex } from 'node:stream';

export interface SieveCapabilities {
  implementation?: string;
  sasl: string[];
  /** Extensions Sieve annoncées (`SIEVE`), en minuscules. */
  sieve: string[];
  starttls: boolean;
  maxRedirects?: number;
  /** Taille maximale d'un script, si le serveur l'annonce (extension non standard `MAXSCRIPTSIZE`). */
  maxScriptSize?: number;
  version?: string;
}

export interface SieveScriptInfo {
  name: string;
  active: boolean;
}

/** Réponse `NO` / `BYE` du serveur : `code` = code de réponse entre parenthèses (`QUOTA/MAXSIZE`, `NONEXISTENT`…). */
export class SieveResponseError extends Error {
  readonly kind: 'NO' | 'BYE';
  readonly code: string | undefined;
  constructor(kind: 'NO' | 'BYE', code: string | undefined, message: string) {
    super(message || `${kind}${code ? ` (${code})` : ''}`);
    this.name = 'SieveResponseError';
    this.kind = kind;
    this.code = code;
  }
}

/** Identifiants refusés. */
export class SieveAuthError extends Error {
  constructor(message = 'ManageSieve authentication failed') {
    super(message);
    this.name = 'SieveAuthError';
  }
}

export class SieveProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SieveProtocolError';
  }
}

export interface SieveClientOptions {
  /** Ouvre le transport (TLS implicite déjà négocié, ou connexion en clair avant STARTTLS). */
  connect: () => Promise<Duplex>;
  /** Négocie TLS sur la connexion après `STARTTLS` ; absent : TLS implicite (pas de STARTTLS). */
  upgrade?: (socket: Duplex) => Promise<Duplex>;
  username: string;
  password: string;
  /** Délai par commande (ms). */
  timeoutMs?: number;
  /** Taille maximale d'une réponse (octets). */
  maxResponse?: number;
}

type Token = { t: 'atom'; v: string } | { t: 'str'; v: string } | { t: 'code'; v: string };
interface Response {
  status: 'OK' | 'NO' | 'BYE';
  code?: string;
  message: string;
  lines: Token[][];
}

const CRLF = Buffer.from('\r\n');

/** Chaîne ManageSieve entre guillemets (ou littéral si elle contient CR, LF ou des caractères non imprimables). */
export function sieveString(s: string): string {
  if (/[\r\n\0]/.test(s) || Buffer.byteLength(s) > 1000) return `{${Buffer.byteLength(s)}+}\r\n${s}`;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Littéral non synchronisant (`{n+}`), toujours utilisé pour le contenu d'un script. */
function literal(s: string): string {
  return `{${Buffer.byteLength(s)}+}\r\n${s}`;
}

/**
 * Lecteur de réponses : tampon d'octets, lignes CRLF, littéraux `{n}` / `{n+}` intégrés aux lignes.
 * Exporté pour les tests.
 */
export class ResponseReader {
  private buf: Buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private ended: Error | null = null;
  private total = 0;

  constructor(private readonly max: number) {}

  /** Octets reçus mais pas encore lus (passage d'un transport à l'autre après STARTTLS). */
  takeRest(): Buffer {
    const b = this.buf;
    this.buf = Buffer.alloc(0);
    return b;
  }

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.total += chunk.length;
    this.wake();
  }

  end(err: Error): void {
    this.ended = err;
    this.wake();
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private async need(): Promise<void> {
    if (this.ended) throw this.ended;
    if (this.total > this.max) throw new SieveProtocolError('response too large');
    await new Promise<void>((r) => this.waiters.push(r));
    if (this.ended && !this.buf.length) throw this.ended;
  }

  /** Lit une ligne logique (littéraux inclus) et la découpe en jetons. */
  async readLine(): Promise<Token[]> {
    const tokens: Token[] = [];
    for (;;) {
      let i = this.buf.indexOf(CRLF);
      while (i < 0) {
        await this.need();
        i = this.buf.indexOf(CRLF);
      }
      const line = this.buf.subarray(0, i).toString('utf8');
      this.buf = this.buf.subarray(i + 2);
      const lit = tokenize(line, tokens);
      if (lit === null) return tokens;
      while (this.buf.length < lit) await this.need();
      tokens.push({ t: 'str', v: this.buf.subarray(0, lit).toString('utf8') });
      this.buf = this.buf.subarray(lit);
    }
  }

  /** Lit jusqu'à la ligne de statut (`OK`, `NO`, `BYE`). */
  async readResponse(): Promise<Response> {
    const lines: Token[][] = [];
    for (;;) {
      const tokens = await this.readLine();
      const first = tokens[0];
      if (first?.t === 'atom' && ['OK', 'NO', 'BYE'].includes(first.v.toUpperCase())) {
        const code = tokens.find((x) => x.t === 'code')?.v;
        const msg = tokens.find((x, i) => i > 0 && x.t === 'str')?.v ?? '';
        this.total = this.buf.length;
        return { status: first.v.toUpperCase() as Response['status'], ...(code ? { code } : {}), message: msg, lines };
      }
      lines.push(tokens);
    }
  }
}

/** Découpe une ligne ; renvoie la taille d'un littéral final `{n}` / `{n+}` à lire ensuite, sinon null. */
function tokenize(line: string, out: Token[]): number | null {
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === ' ') {
      i++;
    } else if (c === '"') {
      let v = '';
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i++;
        v += line[i];
        i++;
      }
      i++;
      out.push({ t: 'str', v });
    } else if (c === '(') {
      const j = line.indexOf(')', i);
      const end = j < 0 ? line.length : j;
      out.push({ t: 'code', v: line.slice(i + 1, end) });
      i = end + 1;
    } else if (c === '{') {
      const m = /^\{(\d{1,9})\+?\}$/.exec(line.slice(i));
      if (!m) throw new SieveProtocolError('bad literal');
      return Number(m[1]);
    } else {
      let j = i;
      while (j < line.length && line[j] !== ' ') j++;
      out.push({ t: 'atom', v: line.slice(i, j) });
      i = j;
    }
  }
  return null;
}

function parseCapabilities(lines: Token[][]): SieveCapabilities {
  const caps: SieveCapabilities = { sasl: [], sieve: [], starttls: false };
  for (const l of lines) {
    const name = l[0]?.v.toUpperCase();
    const value = l[1]?.v ?? '';
    switch (name) {
      case 'IMPLEMENTATION':
        caps.implementation = value;
        break;
      case 'SASL':
        caps.sasl = value.split(/\s+/).filter(Boolean).map((x) => x.toUpperCase());
        break;
      case 'SIEVE':
        caps.sieve = value.split(/\s+/).filter(Boolean).map((x) => x.toLowerCase());
        break;
      case 'STARTTLS':
        caps.starttls = true;
        break;
      case 'MAXREDIRECTS':
        if (/^\d+$/.test(value)) caps.maxRedirects = Number(value);
        break;
      case 'MAXSCRIPTSIZE':
        if (/^\d+$/.test(value)) caps.maxScriptSize = Number(value);
        break;
      case 'VERSION':
        caps.version = value;
        break;
    }
  }
  return caps;
}

export class ManageSieveClient {
  private socket: Duplex | null = null;
  private reader: ResponseReader | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  capabilities: SieveCapabilities | null = null;
  private readonly timeoutMs: number;
  private readonly maxResponse: number;

  constructor(private readonly opts: SieveClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxResponse = opts.maxResponse ?? 2 * 1024 * 1024;
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  private attach(socket: Duplex) {
    const reader = new ResponseReader(this.maxResponse);
    socket.on('data', (c: Buffer) => reader.push(c));
    socket.once('close', () => reader.end(new SieveProtocolError('connection closed')));
    socket.on('error', (e: Error) => reader.end(e));
    this.socket = socket;
    this.reader = reader;
  }

  private withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.destroy();
        reject(new SieveProtocolError(`${what}: timeout`));
      }, this.timeoutMs);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  private async command(line: string, what: string): Promise<Response> {
    if (!this.socket || !this.reader) throw new SieveProtocolError('not connected');
    const reader = this.reader;
    this.socket.write(`${line}\r\n`);
    const r = await this.withTimeout(reader.readResponse(), what);
    if (r.status === 'BYE') {
      this.destroy();
      throw new SieveResponseError('BYE', r.code, r.message);
    }
    return r;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Connexion, STARTTLS si demandé, puis authentification PLAIN. */
  connect(): Promise<SieveCapabilities> {
    return this.run(async () => {
      if (this.connected && this.capabilities) return this.capabilities;
      this.attach(await this.withTimeout(this.opts.connect(), 'connect'));
      let greet = await this.withTimeout(this.reader!.readResponse(), 'greeting');
      if (greet.status !== 'OK') throw new SieveResponseError(greet.status === 'BYE' ? 'BYE' : 'NO', greet.code, greet.message);
      let caps = parseCapabilities(greet.lines);
      if (this.opts.upgrade) {
        if (!caps.starttls) throw new SieveProtocolError('STARTTLS not offered');
        const r = await this.command('STARTTLS', 'starttls');
        if (r.status !== 'OK') throw new SieveResponseError('NO', r.code, r.message);
        const raw = this.socket!;
        const rest = this.reader!.takeRest();
        raw.removeAllListeners('data');
        raw.removeAllListeners('close');
        raw.removeAllListeners('error');
        raw.on('error', () => undefined);
        this.attach(await this.withTimeout(this.opts.upgrade(raw), 'tls'));
        if (rest.length) this.reader!.push(rest);
        // RFC 5804 §2.2 : le serveur renvoie ses capacités après la négociation TLS
        greet = await this.withTimeout(this.reader!.readResponse(), 'capability');
        caps = parseCapabilities(greet.lines);
      }
      if (caps.sasl.length && !caps.sasl.includes('PLAIN')) throw new SieveProtocolError('SASL PLAIN not offered');
      const token = Buffer.from(`\0${this.opts.username}\0${this.opts.password}`, 'utf8').toString('base64');
      const auth = await this.command(`AUTHENTICATE "PLAIN" "${token}"`, 'authenticate');
      if (auth.status !== 'OK') {
        this.destroy();
        throw new SieveAuthError();
      }
      // certains serveurs renvoient les capacités après l'authentification (RFC 5804 §2.1)
      if (auth.lines.length) caps = { ...caps, ...parseCapabilities(auth.lines) };
      this.capabilities = caps;
      return caps;
    });
  }

  capability(): Promise<SieveCapabilities> {
    return this.run(async () => {
      const r = await this.command('CAPABILITY', 'capability');
      this.check(r);
      this.capabilities = parseCapabilities(r.lines);
      return this.capabilities;
    });
  }

  private check(r: Response): void {
    if (r.status !== 'OK') throw new SieveResponseError('NO', r.code, r.message);
  }

  listScripts(): Promise<SieveScriptInfo[]> {
    return this.run(async () => {
      const r = await this.command('LISTSCRIPTS', 'listscripts');
      this.check(r);
      return r.lines
        .filter((l) => l[0]?.t === 'str')
        .map((l) => ({ name: l[0]!.v, active: l.some((x, i) => i > 0 && x.t === 'atom' && x.v.toUpperCase() === 'ACTIVE') }));
    });
  }

  getScript(name: string): Promise<string> {
    return this.run(async () => {
      const r = await this.command(`GETSCRIPT ${sieveString(name)}`, 'getscript');
      this.check(r);
      return r.lines[0]?.find((x) => x.t === 'str')?.v ?? '';
    });
  }

  putScript(name: string, content: string): Promise<void> {
    return this.run(async () => this.check(await this.command(`PUTSCRIPT ${sieveString(name)} ${literal(content)}`, 'putscript')));
  }

  /** `null` si le script est valide, sinon le message d'erreur du serveur. */
  checkScript(content: string): Promise<string | null> {
    return this.run(async () => {
      const r = await this.command(`CHECKSCRIPT ${literal(content)}`, 'checkscript');
      return r.status === 'OK' ? null : r.message || r.code || 'invalid script';
    });
  }

  /** `''` désactive tous les scripts. */
  setActive(name: string): Promise<void> {
    return this.run(async () => this.check(await this.command(`SETACTIVE ${sieveString(name)}`, 'setactive')));
  }

  deleteScript(name: string): Promise<void> {
    return this.run(async () => this.check(await this.command(`DELETESCRIPT ${sieveString(name)}`, 'deletescript')));
  }

  renameScript(from: string, to: string): Promise<void> {
    return this.run(async () => this.check(await this.command(`RENAMESCRIPT ${sieveString(from)} ${sieveString(to)}`, 'renamescript')));
  }

  haveSpace(name: string, size: number): Promise<boolean> {
    return this.run(async () => (await this.command(`HAVESPACE ${sieveString(name)} ${Math.max(0, Math.floor(size))}`, 'havespace')).status === 'OK');
  }

  async logout(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.run(async () => {
        await this.command('LOGOUT', 'logout').catch(() => undefined);
      });
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    const s = this.socket;
    this.socket = null;
    this.reader?.end(new SieveProtocolError('connection closed'));
    this.reader = null;
    this.capabilities = null;
    s?.destroy();
  }
}
