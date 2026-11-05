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
import { DEFAULT_LIMITS, Semaphore, evalPointer, limitError, limitsOf, type SessionLimits } from './limits.ts';

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

/** Sous-appel envoyé au serveur ; `round` = numéro de sa sous-requête (-1 : pas encore placé). */
interface Part {
  group: Group;
  call: Invocation;
  round: number;
  replies: Invocation[];
}

/** Appel d'origine et ses sous-appels (un seul s'il n'est pas découpé). */
interface Group {
  call: Invocation;
  parts: Part[];
  split: boolean;
  seq: number;
  replayed: boolean;
}

/** Sous-appel répondu par le client sans envoi (référence vers un appel en échec). */
const LOCAL = -2;

type SetEntry = ['create' | 'update', string, unknown] | ['destroy', string];

function setParts(g: Group, calls: Invocation[]): void {
  g.parts = calls.map((call) => ({ group: g, call, round: -1, replies: [] }));
  g.split = calls.length > 1;
}

/** Entrées littérales d'un `…/set`, dans l'ordre create, update, destroy. */
function setEntries(args: Record<string, unknown>): SetEntry[] {
  const out: SetEntry[] = [];
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  for (const [k, v] of Object.entries(obj(args.create))) out.push(['create', k, v]);
  for (const [k, v] of Object.entries(obj(args.update))) out.push(['update', k, v]);
  if (Array.isArray(args.destroy)) for (const id of args.destroy as string[]) out.push(['destroy', id]);
  return out;
}

function setChunk(args: Record<string, unknown>, entries: SetEntry[], first: boolean): Record<string, unknown> {
  const { create: _c, update: _u, destroy: _d, ifInState, ...rest } = args;
  const out: Record<string, unknown> = { ...rest };
  if (first && ifInState !== undefined) out.ifInState = ifInState;
  for (const e of entries) {
    if (e[0] === 'destroy') ((out.destroy ??= []) as string[]).push(e[1]);
    else ((out[e[0]] ??= {}) as Record<string, unknown>)[e[1]] = e[2];
  }
  return out;
}

/** Découpe d'un appel trop gros (`ids` d'un `…/get`, entrées d'un `…/set`), identifiants `<callId>~<n>`. */
function splitCall(g: Group, call: Invocation, limits: SessionLimits): Invocation[] {
  const [name, args, id] = call;
  const chunks: Record<string, unknown>[] = [];
  if (name.endsWith('/get') && Array.isArray(args.ids) && args.ids.length > limits.maxObjectsInGet) {
    for (let i = 0; i < args.ids.length; i += limits.maxObjectsInGet) chunks.push({ ...args, ids: args.ids.slice(i, i + limits.maxObjectsInGet) });
  } else if (name.endsWith('/set')) {
    const entries = setEntries(args);
    if (entries.length > limits.maxObjectsInSet)
      for (let i = 0; i < entries.length; i += limits.maxObjectsInSet) chunks.push(setChunk(args, entries.slice(i, i + limits.maxObjectsInSet), i === 0));
  }
  if (!chunks.length) return [call];
  return chunks.map((a): Invocation => [name, a, `${id}~${g.seq++}`]);
}

function refsOf(args: Record<string, unknown>): ResultReference[] {
  return Object.keys(args)
    .filter((k) => k.startsWith('#'))
    .map((k) => args[k] as ResultReference);
}

/** Réponses d'un appel d'origine, sous son identifiant ; un groupe découpé est réuni en une réponse. */
function groupResult(g: Group): Invocation[] {
  const id = g.call[2];
  if (!g.split) return g.parts[0]?.replies ?? [];
  const firsts = g.parts.map((p) => p.replies[0]).filter((r): r is Invocation => !!r);
  const err = firsts.find((r) => r[0] === 'error');
  if (err) return [['error', err[1], id]];
  if (!firsts.length) return [];
  const bodies = firsts.map((r) => r[1]);
  const first = bodies[0]!;
  const lastBody = bodies[bodies.length - 1]!;
  const name = firsts[0]![0];
  if (g.call[0].endsWith('/get')) {
    return [
      [
        name,
        {
          ...first,
          state: lastBody.state,
          list: bodies.flatMap((b) => (b.list as unknown[] | undefined) ?? []),
          notFound: bodies.flatMap((b) => (b.notFound as unknown[] | null | undefined) ?? []),
        },
        id,
      ],
    ];
  }
  const merged = (k: string) => {
    const o = Object.assign({}, ...bodies.map((b) => b[k] ?? {})) as Record<string, unknown>;
    return Object.keys(o).length ? o : null;
  };
  const destroyed = bodies.flatMap((b) => (b.destroyed as unknown[] | null | undefined) ?? []);
  return [
    [
      name,
      {
        ...first,
        oldState: first.oldState,
        newState: lastBody.newState,
        created: merged('created'),
        updated: merged('updated'),
        destroyed: destroyed.length ? destroyed : null,
        notCreated: merged('notCreated'),
        notUpdated: merged('notUpdated'),
        notDestroyed: merged('notDestroyed'),
      },
      id,
    ],
  ];
}

export class JmapClient {
  readonly sessionUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly opts: JmapClientOptions;
  private session: Session | undefined;
  private sessionPromise: Promise<Session> | undefined;
  private requestGate = new Semaphore(DEFAULT_LIMITS.maxConcurrentRequests);
  private uploadGate = new Semaphore(DEFAULT_LIMITS.maxConcurrentUpload);

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
    const limits = limitsOf(s);
    this.requestGate.max = limits.maxConcurrentRequests;
    const release = await this.requestGate.acquire();
    let json: JmapResponse;
    try {
      json = await this.sendWithinLimits(req, limits);
    } finally {
      release();
    }
    if (this.session && json.sessionState && json.sessionState !== this.session.state) {
      // la session a changé : on la rechargera au prochain besoin
      this.session = undefined;
    }
    return json;
  }

  /**
   * Envoie une requête en respectant les limites de la session : appels `…/get` et `…/set` trop gros découpés,
   * sous-requêtes successives (nombre d'appels, taille), références arrière résolues localement entre sous-requêtes,
   * repli sur `requestTooLarge`, puis réponses réunies dans l'ordre des appels d'origine.
   */
  private async sendWithinLimits(req: JmapRequest, limits: SessionLimits): Promise<JmapResponse> {
    const enc = new TextEncoder();
    const sizeOf = (r: JmapRequest) => enc.encode(JSON.stringify(r)).length;
    const groups: Group[] = req.methodCalls.map((call) => {
      const g: Group = { call, parts: [], split: false, seq: 0, replayed: false };
      setParts(g, splitCall(g, call, limits));
      return g;
    });
    const byId = new Map<string, Group>();
    const created: Record<Id, Id> = {};
    let pending: Part[] = [];
    let round = 0;
    let last: JmapResponse | undefined;
    let replayed = false;

    const isDone = (g: Group) => g.parts.every((p) => p.round === LOCAL || (p.round >= 0 && p.round < round));
    const inPending = (g: Group) => g.parts.some((p) => p.round === round);
    const bodyOf = (calls: Invocation[]): JmapRequest => {
      const r: JmapRequest = { using: this.usingFor(calls, req.using), methodCalls: calls };
      if (round > 0) r.createdIds = { ...req.createdIds, ...created };
      else if (req.createdIds) r.createdIds = req.createdIds;
      return r;
    };
    /** Valeur d'une référence vers un appel terminé ; `undefined` si l'appel visé a échoué ou si le chemin est introuvable. */
    const resolve = (t: Group, ref: ResultReference): { value: unknown } | undefined => {
      const hit = groupResult(t).find((r) => r[0] === ref.name);
      if (!hit) return undefined;
      try {
        return { value: evalPointer(hit[1], ref.path) };
      } catch {
        return undefined;
      }
    };

    const flush = async (body?: JmapRequest): Promise<void> => {
      const sent = pending;
      pending = [];
      const res = await this.post(body ?? bodyOf(sent.map((p) => p.call)));
      last = res;
      const own = new Map(sent.map((p) => [p.call[2], p]));
      for (const inv of res.methodResponses) own.get(inv[2])?.replies.push(inv);
      round++;
      if (res.createdIds) Object.assign(created, res.createdIds);
      else
        for (const [name, body] of res.methodResponses) {
          if (!name.endsWith('/set')) continue;
          for (const [cid, o] of Object.entries((body.created ?? {}) as Record<string, { id?: Id } | null>)) if (o?.id) created[cid] = o.id;
        }
      await fallback(sent);
    };

    /** Repli `requestTooLarge` : `…/get` dont `ids` venait d'une référence, rejoué avec ses `ids` résolus et découpés, puis ses dépendants. */
    const fallback = async (sent: Part[]): Promise<void> => {
      const replay: Group[] = [];
      const ids = new Set<string>();
      for (const p of sent) {
        const g = p.group;
        const [name, body] = p.replies[0] ?? [];
        if (name !== 'error') continue;
        const type = (body as unknown as MethodErrorBody).type;
        const ref = g.call[1]['#ids'] as ResultReference | undefined;
        if (type === 'requestTooLarge' && !g.replayed && g.call[0].endsWith('/get') && ref) {
          const t = byId.get(ref.resultOf);
          if (!t || !t.parts.some((x) => sent.includes(x))) continue;
          const v = resolve(t, ref);
          if (!v || !Array.isArray(v.value)) continue;
          const { '#ids': _, ...rest } = g.call[1];
          g.replayed = true;
          setParts(g, splitCall(g, [g.call[0], { ...rest, ids: v.value }, g.call[2]], limits));
          replay.push(g);
          ids.add(g.call[2]);
        } else if (type === 'invalidResultReference' && refsOf(g.call[1]).some((r) => ids.has(r.resultOf))) {
          setParts(g, [g.call]);
          replay.push(g);
          ids.add(g.call[2]);
        }
      }
      if (!replay.length) return;
      replayed = true;
      await run(replay);
    };

    const place = async (g: Group, i: number): Promise<void> => {
      for (;;) {
        const p = g.parts[i]!;
        const args = { ...p.call[1] };
        let blocked = false;
        let failed = false;
        for (const k of Object.keys(args)) {
          if (!k.startsWith('#')) continue;
          const ref = args[k] as ResultReference;
          const t = byId.get(ref.resultOf);
          if (!t || t === g) continue;
          if (isDone(t)) {
            const v = resolve(t, ref);
            if (!v) {
              failed = true;
              break;
            }
            delete args[k];
            args[k.slice(1)] = v.value;
          } else if (inPending(t) && t.split) blocked = true;
        }
        if (failed) {
          p.round = LOCAL;
          p.replies = [['error', { type: 'invalidResultReference' }, p.call[2]]];
          return;
        }
        const call: Invocation = [p.call[0], args, p.call[2]];
        if (
          pending.length &&
          (blocked || pending.length >= limits.maxCallsInRequest || sizeOf(bodyOf([...pending.map((x) => x.call), call])) > limits.maxSizeRequest)
        ) {
          await flush();
          continue;
        }
        if (!pending.length && sizeOf(bodyOf([call])) > limits.maxSizeRequest) {
          const entries = call[0].endsWith('/set') ? setEntries(args) : undefined;
          if (!entries || entries.length < 2) throw limitError('maxSizeRequest');
          const half = Math.ceil(entries.length / 2);
          const halves = [setChunk(args, entries.slice(0, half), true), setChunk(args, entries.slice(half), false)].map(
            (a): Part => ({ group: g, call: [call[0], a, `${g.call[2]}~${g.seq++}`], round: -1, replies: [] }),
          );
          g.parts.splice(i, 1, ...halves);
          g.split = true;
          continue;
        }
        p.call = call;
        p.round = round;
        pending.push(p);
        return;
      }
    };

    const run = async (list: Group[]): Promise<void> => {
      for (const g of list) {
        byId.set(g.call[2], g);
        for (let i = 0; i < g.parts.length; i++) await place(g, i);
      }
      if (pending.length) await flush();
    };

    // contrôle préalable (C15) : chaque appel, ou chaque entrée d'un `…/set`, doit tenir seul avant tout envoi
    for (const g of groups)
      for (const { call } of g.parts) {
        if (sizeOf(bodyOf([call])) <= limits.maxSizeRequest) continue;
        const entries = call[0].endsWith('/set') ? setEntries(call[1]) : [];
        const fits = entries.length > 0 && entries.every((e, i) => sizeOf(bodyOf([[call[0], setChunk(call[1], [e], i === 0), call[2]]])) <= limits.maxSizeRequest);
        if (!fits) throw limitError('maxSizeRequest');
      }

    const fast =
      groups.every((g) => !g.split) && req.methodCalls.length <= limits.maxCallsInRequest && sizeOf(req) <= limits.maxSizeRequest;
    if (fast) {
      for (const g of groups) {
        byId.set(g.call[2], g);
        for (const p of g.parts) p.round = round;
        pending.push(...g.parts);
      }
      await flush(req);
      if (!replayed) return last!;
    } else await run(groups);

    const out: JmapResponse = {
      methodResponses: groups.flatMap(groupResult),
      sessionState: last?.sessionState ?? this.session?.state ?? '',
    };
    if (req.createdIds) out.createdIds = { ...req.createdIds, ...created };
    return out;
  }

  /** Envoie une requête JMAP telle quelle (un aller-retour). */
  private async post(req: JmapRequest): Promise<JmapResponse> {
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
    return (await res.json()) as JmapResponse;
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
    const limits = limitsOf(s);
    if ((data instanceof Blob ? data.size : data.byteLength) > limits.maxSizeUpload) throw limitError('maxSizeUpload');
    const url = resolveUrl(expandUrlTemplate(s.uploadUrl, { accountId }), this.sessionUrl);
    const contentType = type ?? (data instanceof Blob ? data.type : '') ?? 'application/octet-stream';
    this.uploadGate.max = limits.maxConcurrentUpload;
    const release = await this.uploadGate.acquire();
    try {
      const res = await this.doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
        body: data as BodyInit,
      });
      if (!res.ok) throw new JmapError(`Upload failed (HTTP ${res.status})`, 'upload', res.status, await errorBody(res), retryAfterSecs(res));
      return (await res.json()) as UploadResponse;
    } finally {
      release();
    }
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
