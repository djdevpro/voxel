import {
  CAP,
  type ArgsOf,
  type ChangesResponse,
  type Id,
  type Invocation,
  type JmapRequest,
  type JmapResponse,
  type MethodErrorBody,
  type MethodName,
  type ResponseOf,
  type ResultReference,
  type Session,
  type StateChange,
  type UploadResponse,
  type WithRefs,
} from './types.ts';
import { createSseParser } from './sse.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JmapClientOptions {
  /** URL de la session JMAP (absolue ou relative à la page en navigateur). */
  sessionUrl: string;
  /** Implémentation fetch (par défaut globalThis.fetch). */
  fetch?: FetchLike;
  /** En-têtes ajoutés à chaque requête (ex. Authorization). Peut être une fonction. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Mode credentials de fetch (navigateur). */
  credentials?: RequestCredentials;
  /** Capacités `using` par défaut. */
  using?: string[];
  /** Session déjà connue (cache hors ligne) : servie tant qu'aucune session fraîche n'est chargée. */
  initialSession?: Session;
  /** Appelé à chaque session chargée depuis le serveur (mise en cache). */
  onSession?: (s: Session) => void;
}

export class JmapError extends Error {
  readonly status: number | undefined;
  readonly type: string;
  readonly body: unknown;
  /** Délai demandé par le serveur (`Retry-After`, en secondes), s'il est connu. */
  readonly retryAfter: number | undefined;
  constructor(message: string, type: string, status?: number, body?: unknown, retryAfter?: number) {
    super(message);
    this.name = 'JmapError';
    this.type = type;
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

export class MethodError extends JmapError {
  readonly method: string;
  readonly callId: string;
  constructor(method: string, callId: string, body: MethodErrorBody) {
    super(`${method} : ${body.type}${body.description ? ` — ${body.description}` : ''}`, body.type, undefined, body);
    this.name = 'MethodError';
    this.method = method;
    this.callId = callId;
  }
}

/** Remplace les variables d'un gabarit d'URL RFC 6570 de niveau 1. */
export function expandUrlTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, k: string) => encodeURIComponent(vars[k] ?? ''));
}

/** Délai d'un en-tête `Retry-After` (secondes ou date HTTP), en millisecondes. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Attente annulable : rejette avec la raison du signal s'il est déclenché. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Corps d'une réponse en erreur (problème JSON, RFC 7807), s'il se lit. */
async function errorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function retryAfterSecs(res: Response): number | undefined {
  const ms = retryAfterMs(res.headers.get('retry-after'));
  return ms === undefined ? undefined : Math.ceil(ms / 1000);
}

/** Nouvelles tentatives après un 429 (et un 503 en lecture) : délai `Retry-After`, sinon 1, 2, 4, 8 puis 16 s. */
const RETRY_ATTEMPTS = 5;
/** Attente au-delà de laquelle la réponse revient à l'appelant (quota horaire de téléversement, par exemple). */
export const RETRY_MAX_WAIT_MS = 60_000;

function resolveUrl(url: string, base: string): string {
  const pageBase = typeof globalThis.location !== 'undefined' ? globalThis.location.href : undefined;
  try {
    const absBase = new URL(base, pageBase).href;
    return new URL(url, absBase).href;
  } catch {
    return url;
  }
}

/** Poignée vers un appel d'un lot, permettant les références arrière et la lecture du résultat. */
export class CallHandle<M extends MethodName> {
  readonly name: M;
  readonly callId: string;
  /** @internal */ _result: ResponseOf<M> | undefined;
  /** @internal */ _error: MethodError | undefined;
  constructor(name: M, callId: string) {
    this.name = name;
    this.callId = callId;
  }
  /** Référence arrière vers un chemin JSON Pointer du résultat (ex. `/ids`, `/list/*\/threadId`). */
  ref(path: string, name: string = this.name): ResultReference {
    return { resultOf: this.callId, name, path };
  }
  get result(): ResponseOf<M> {
    if (this._error) throw this._error;
    if (this._result === undefined) throw new JmapError(`No result for ${this.name} (${this.callId})`, 'noResult');
    return this._result;
  }
  get error(): MethodError | undefined {
    return this._error;
  }
  get ok(): boolean {
    return this._result !== undefined && !this._error;
  }
}

/** Lot d'appels JMAP envoyés dans une seule requête. */
export class JmapBatch {
  private calls: Invocation[] = [];
  private handles = new Map<string, CallHandle<MethodName>[]>();
  private n = 0;
  private extraUsing = new Set<string>();
  private readonly client: JmapClient;
  constructor(client: JmapClient) {
    this.client = client;
  }

  call<M extends MethodName>(name: M, args: WithRefs<ArgsOf<M>>, callId?: string): CallHandle<M> {
    const id = callId ?? `c${this.n++}`;
    this.calls.push([name, args as Record<string, unknown>, id]);
    const h = new CallHandle(name, id);
    const list = this.handles.get(id) ?? [];
    list.push(h as unknown as CallHandle<MethodName>);
    this.handles.set(id, list);
    return h;
  }

  using(...caps: string[]): this {
    caps.forEach((c) => this.extraUsing.add(c));
    return this;
  }

  get size(): number {
    return this.calls.length;
  }

  async send(): Promise<JmapResponse> {
    const res = await this.client.rawRequest({
      using: this.client.usingFor(this.calls, [...this.extraUsing]),
      methodCalls: this.calls,
    });
    for (const [name, body, callId] of res.methodResponses) {
      const hs = this.handles.get(callId);
      if (!hs) continue;
      const h = hs.find((x) => x.name === name && x._result === undefined) ?? hs.find((x) => x._result === undefined && !x._error);
      if (!h) continue;
      if (name === 'error') h._error = new MethodError(h.name, callId, body as unknown as MethodErrorBody);
      else h._result = body as never;
    }
    return res;
  }
}

export interface EventSourceOptions {
  types?: string[] | '*';
  closeafter?: 'state' | 'no';
  ping?: number;
  onStateChange: (change: StateChange) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
}

export class JmapClient {
  readonly sessionUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly opts: JmapClientOptions;
  private session: Session | undefined;
  private sessionPromise: Promise<Session> | undefined;

  constructor(opts: JmapClientOptions) {
    this.opts = opts;
    this.sessionUrl = opts.sessionUrl;
    this.fetchImpl = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
    this.session = opts.initialSession;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h = typeof this.opts.headers === 'function' ? this.opts.headers() : (this.opts.headers ?? {});
    return { ...h, ...extra };
  }

  /**
   * Requête HTTP. Un 429 (limite de débit du serveur, qui n'a donc rien traité) est renvoyé après le délai demandé,
   * un 503 aussi pour une lecture ; une attente plus longue que `RETRY_MAX_WAIT_MS` revient à l'appelant.
   */
  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    const read = !init.method || init.method === 'GET' || init.method === 'HEAD';
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        ...init,
        credentials: this.opts.credentials ?? init.credentials,
        headers: this.headers(init.headers as Record<string, string> | undefined),
      });
      if (!(res.status === 429 || (res.status === 503 && read)) || attempt >= RETRY_ATTEMPTS) return res;
      const wait = retryAfterMs(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt;
      if (wait > RETRY_MAX_WAIT_MS) return res;
      await res.body?.cancel().catch(() => undefined);
      await delay(wait, init.signal ?? undefined);
    }
  }

  /** Récupère (et met en cache) la session. */
  async getSession(force = false): Promise<Session> {
    if (this.session && !force) return this.session;
    if (this.sessionPromise && !force) return this.sessionPromise;
    this.sessionPromise = (async () => {
      const res = await this.doFetch(this.sessionUrl, { method: 'GET', headers: { Accept: 'application/json' } });
      if (!res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        throw new JmapError(`JMAP session unavailable (HTTP ${res.status})`, 'session', res.status, body, retryAfterSecs(res));
      }
      const s = (await res.json()) as Session;
      this.session = s;
      this.opts.onSession?.(s);
      return s;
    })();
    try {
      return await this.sessionPromise;
    } finally {
      this.sessionPromise = undefined;
    }
  }

  get cachedSession(): Session | undefined {
    return this.session;
  }

  /** Identifiant du compte principal pour une capacité (par défaut mail). */
  async accountId(capability: string = CAP.mail): Promise<Id> {
    const s = await this.getSession();
    const id = s.primaryAccounts[capability] ?? s.primaryAccounts[CAP.mail] ?? Object.keys(s.accounts)[0];
    if (!id) throw new JmapError('No JMAP account in session', 'noAccount');
    return id;
  }

  hasCapability(cap: string): boolean {
    return !!this.session && cap in this.session.capabilities;
  }

  accountCapability<T = unknown>(cap: string, accountId?: Id): T | undefined {
    const s = this.session;
    if (!s) return undefined;
    const id = accountId ?? s.primaryAccounts[cap] ?? s.primaryAccounts[CAP.mail];
    if (!id) return undefined;
    return s.accounts[id]?.accountCapabilities[cap] as T | undefined;
  }

  /** @internal */
  usingFor(calls: Invocation[], extra: string[] = []): string[] {
    const set = new Set<string>([CAP.core, ...(this.opts.using ?? []), ...extra]);
    for (const [name] of calls) {
      const type = name.split('/')[0];
      switch (type) {
        case 'Mailbox':
        case 'Email':
        case 'Thread':
        case 'SearchSnippet':
          set.add(CAP.mail);
          break;
        case 'Identity':
        case 'EmailSubmission':
          set.add(CAP.mail);
          set.add(CAP.submission);
          break;
        case 'VacationResponse':
          set.add(CAP.vacation);
          break;
        case 'ContactCard':
        case 'AddressBook':
          set.add(CAP.contacts);
          if (name === 'ContactCard/parse') set.add(CAP.contactsParse);
          break;
        case 'Calendar':
        case 'CalendarEvent':
          set.add(CAP.calendars);
          if (name === 'CalendarEvent/parse') set.add(CAP.calendarsParse);
          break;
        case 'SieveScript':
          set.add(CAP.sieve);
          break;
        case 'Quota':
          set.add(CAP.quota);
          break;
      }
    }
    return [...set];
  }

  /** Envoie une requête JMAP brute. */
  async rawRequest(req: JmapRequest): Promise<JmapResponse> {
    const s = await this.getSession();
    const url = resolveUrl(s.apiUrl, this.sessionUrl);
    const res = await this.doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const type = (body as { type?: string } | undefined)?.type ?? 'http';
      throw new JmapError(`JMAP request rejected (HTTP ${res.status})`, type, res.status, body, retryAfterSecs(res));
    }
    const json = (await res.json()) as JmapResponse;
    if (this.session && json.sessionState && json.sessionState !== this.session.state) {
      // la session a changé : on la rechargera au prochain besoin
      this.session = undefined;
    }
    return json;
  }

  /** Crée un lot d'appels. */
  batch(): JmapBatch {
    return new JmapBatch(this);
  }

  /** Appel unique typé ; lève MethodError en cas d'erreur de méthode. */
  async call<M extends MethodName>(name: M, args: WithRefs<ArgsOf<M>>): Promise<ResponseOf<M>> {
    const b = this.batch();
    const h = b.call(name, args);
    await b.send();
    return h.result;
  }

  /** Récupère toutes les modifications depuis un état, en suivant `hasMoreChanges`. */
  async allChanges(
    type: 'Mailbox' | 'Email' | 'Thread' | 'Identity' | 'AddressBook' | 'ContactCard' | 'Calendar' | 'CalendarEvent',
    accountId: Id,
    sinceState: string,
    maxPages = 20,
  ): Promise<ChangesResponse> {
    const acc: ChangesResponse = { accountId, oldState: sinceState, newState: sinceState, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
    let state = sinceState;
    for (let i = 0; i < maxPages; i++) {
      const r = (await this.call(`${type}/changes` as 'Email/changes', { accountId, sinceState: state, maxChanges: 500 })) as ChangesResponse;
      acc.created.push(...r.created);
      acc.updated.push(...r.updated);
      acc.destroyed.push(...r.destroyed);
      acc.newState = r.newState;
      state = r.newState;
      if (!r.hasMoreChanges) return acc;
    }
    acc.hasMoreChanges = true;
    return acc;
  }

  /** Téléverse un blob ; renvoie blobId/type/taille. */
  async upload(accountId: Id, data: Blob | ArrayBuffer | Uint8Array, type?: string): Promise<UploadResponse> {
    const s = await this.getSession();
    const url = resolveUrl(expandUrlTemplate(s.uploadUrl, { accountId }), this.sessionUrl);
    const contentType = type ?? (data instanceof Blob ? data.type : '') ?? 'application/octet-stream';
    const res = await this.doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'application/octet-stream' },
      body: data as BodyInit,
    });
    if (!res.ok) throw new JmapError(`Upload failed (HTTP ${res.status})`, 'upload', res.status, await errorBody(res), retryAfterSecs(res));
    return (await res.json()) as UploadResponse;
  }

  /** URL de téléchargement d'un blob (nécessite une session déjà chargée). */
  downloadUrl(accountId: Id, blobId: Id, name: string, type = 'application/octet-stream'): string {
    const s = this.session;
    if (!s) throw new JmapError('Session not loaded', 'session');
    return resolveUrl(expandUrlTemplate(s.downloadUrl, { accountId, blobId, name, type }), this.sessionUrl);
  }

  async download(accountId: Id, blobId: Id, name: string, type?: string): Promise<Blob> {
    await this.getSession();
    const res = await this.doFetch(this.downloadUrl(accountId, blobId, name, type), { method: 'GET' });
    if (!res.ok) throw new JmapError(`Download failed (HTTP ${res.status})`, 'download', res.status, await errorBody(res), retryAfterSecs(res));
    return res.blob();
  }

  /** URL EventSource (push). */
  async eventSourceUrl(types: string[] | '*' = '*', closeafter: 'state' | 'no' = 'no', ping = 30): Promise<string> {
    const s = await this.getSession();
    return resolveUrl(
      expandUrlTemplate(s.eventSourceUrl, {
        types: types === '*' ? '*' : types.join(','),
        closeafter,
        ping: String(ping),
      }),
      this.sessionUrl,
    );
  }

  /**
   * Ouvre le flux push JMAP (RFC 8620 §7.3) avec `fetch` : contrairement à l'EventSource natif,
   * il porte les en-têtes du client (`Authorization`). Reconnexion avec attente croissante
   * (1 s, doublée jusqu'à 60 s) tant que le flux n'est pas fermé. Renvoie une fonction de fermeture.
   */
  async subscribe(opts: EventSourceOptions): Promise<() => void> {
    const url = await this.eventSourceUrl(opts.types ?? '*', opts.closeafter ?? 'no', opts.ping ?? 30);
    const ctrl = new AbortController();
    let closed = false;
    let delay = 1000;
    let lastId: string | undefined;
    let wait: ReturnType<typeof setTimeout> | undefined;

    const once = async () => {
      const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
      if (lastId) headers['Last-Event-ID'] = lastId;
      const res = await this.doFetch(url, { method: 'GET', headers, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new JmapError(`Event stream unavailable (HTTP ${res.status})`, 'eventsource', res.status);
      opts.onOpen?.();
      delay = 1000;
      const parser = createSseParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          if (ev.event === 'ping') continue;
          try {
            const data = JSON.parse(ev.data) as StateChange;
            if (data && data['@type'] === 'StateChange') opts.onStateChange(data);
          } catch {
            /* donnée invalide */
          }
        }
        lastId = parser.lastEventId ?? lastId;
      }
    };

    const loop = async () => {
      while (!closed) {
        try {
          await once();
        } catch (e) {
          if (closed) return;
          opts.onError?.(e);
        }
        if (closed) return;
        await new Promise<void>((r) => (wait = setTimeout(r, delay)));
        delay = Math.min(delay * 2, 60_000);
      }
    };
    void loop();
    return () => {
      closed = true;
      clearTimeout(wait);
      ctrl.abort();
    };
  }
}
