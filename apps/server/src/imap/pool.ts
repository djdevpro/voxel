/**
 * Pool de connexions IMAP (imapflow) pour une boîte : connexions réutilisées, verrou exclusif
 * par opération, fermeture des connexions inactives, traduction des erreurs réseau/authentification.
 */
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { BackendAuthError, BackendUnavailableError, type ImapConfig } from '../backend/types.js';
import { assertAllowedPort, BlockedHostError, pinHostCandidates, tryCandidates } from '../netguard.js';

/**
 * Connexions IMAP simultanées par compte (hôte + identifiant), tous backends confondus. Beaucoup de serveurs
 * refusent au-delà d'une quinzaine de connexions par compte. Un backend ouvre au plus 3 connexions de pool + 1 IDLE.
 */
const DEFAULT_ACCOUNT_LIMIT = 30;
const SLOT_WAIT_MS = 30_000;

interface AccountSlots {
  used: number;
  limit: number;
  waiters: Array<() => void>;
}
const accountSlots = new Map<string, AccountSlots>();

function accountKey(host: string, username: string): string {
  return `${host.toLowerCase()}|${username.toLowerCase()}`;
}

/** Nombre de connexions ouvertes (ou en cours d'ouverture) pour un compte (tests, diagnostic). */
export function accountConnections(host: string, username: string): number {
  return accountSlots.get(accountKey(host, username))?.used ?? 0;
}

/** Réserve une place de connexion pour le compte (attend au plus 30 s) ; renvoie la fonction de libération. */
export async function takeAccountSlot(host: string, username: string, limit: number, waitMs = SLOT_WAIT_MS): Promise<() => void> {
  const key = accountKey(host, username);
  let s = accountSlots.get(key);
  if (!s) {
    s = { used: 0, limit, waiters: [] };
    accountSlots.set(key, s);
  }
  const slots = s;
  slots.limit = limit;
  if (slots.used >= slots.limit) {
    // la place est transmise directement par celui qui libère (pas de dépassement par une ouverture concurrente)
    await new Promise<void>((resolve, reject) => {
      const w = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        slots.waiters = slots.waiters.filter((x) => x !== w);
        reject(new BackendUnavailableError(`too many IMAP connections for this account (limit ${slots.limit})`));
      }, waitMs);
      t.unref?.();
      slots.waiters.push(w);
    });
  } else slots.used++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = slots.waiters.shift();
    if (next) next();
    else {
      slots.used--;
      if (!slots.used && accountSlots.get(key) === slots) accountSlots.delete(key);
    }
  };
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETIMEOUT',
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectText',
  'ClosedAfterConnectTLS',
  'StateLogout',
  'ESOCKET',
  'ECONNECTION',
  'EDNS',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

interface ErrLike {
  code?: string;
  authenticationFailed?: boolean;
  tlsFailed?: boolean;
  responseText?: string;
  message?: string;
}

export function isConnectionError(e: unknown): boolean {
  const err = e as ErrLike | undefined;
  if (!err) return false;
  if (err.tlsFailed) return true;
  return !!err.code && NETWORK_CODES.has(err.code);
}

/** Traduit une erreur imapflow en erreur de backend quand elle concerne l'accès au serveur. */
export function mapImapError(e: unknown): unknown {
  if (e instanceof BackendAuthError || e instanceof BackendUnavailableError) return e;
  const err = e as (ErrLike & { response?: unknown; serverResponseCode?: string }) | undefined;
  if (err?.authenticationFailed) {
    // imapflow : `response` = texte de la réponse NO,
    // `serverResponseCode` = code entre crochets (ALERT, AUTHENTICATIONFAILED…). Ce texte n'est jamais renvoyé au client.
    const text = typeof err.response === 'string' ? err.response : undefined;
    // LOGIN refusé au-delà d'un nombre de connexions (« [ALERT] Too many simultaneous connections ») : ce n'est pas
    // un mauvais mot de passe, le compte est seulement saturé (autres clients de l'utilisateur).
    if (/too many simultaneous connections/i.test(`${text ?? ''} ${err.message ?? ''}`)) {
      return new BackendUnavailableError('IMAP server refused: too many simultaneous connections for this account');
    }
    const code = err.serverResponseCode ? ` [${err.serverResponseCode}]` : '';
    return new BackendAuthError(`IMAP authentication failed${code}`);
  }
  if (isConnectionError(e)) return new BackendUnavailableError(`IMAP server unreachable (${err?.code ?? 'tls'})`);
  return e;
}

interface PooledConn {
  client: ImapFlow;
  busy: boolean;
  lastUsed: number;
}

export class ImapPool {
  private conns: PooledConn[] = [];
  private waiters: Array<{ resolve: (c: PooledConn) => void; reject: (e: unknown) => void }> = [];
  private connecting = 0;
  private authFailedAt = 0;
  private authFailure: BackendAuthError | undefined;
  private synced = new WeakMap<ImapFlow, { path: string; at: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  /** Capacités du serveur (connues après la première connexion). */
  capabilities = new Map<string, boolean | number>();

  constructor(
    private readonly cfg: ImapConfig,
    private readonly max = 3,
    private readonly idleMs = 3 * 60_000,
  ) {}

  options(): ImapFlowOptions {
    const { cfg } = this;
    const auth = { user: cfg.username, pass: cfg.auth.password };
    return {
      host: cfg.imap.host,
      port: cfg.imap.port,
      secure: cfg.imap.secure,
      doSTARTTLS: cfg.imap.secure ? undefined : true,
      auth,
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 10 * 60_000,
      clientInfo: { name: 'Voxel' },
    };
  }

  /** Ouvre une nouvelle connexion authentifiée (hors pool). */
  async open(extra: Partial<ImapFlowOptions> = {}): Promise<ImapFlow> {
    if (this.closed) throw new BackendUnavailableError('backend closed');
    // Évite de marteler le serveur (bannissement) après un refus d'authentification.
    if (this.authFailedAt && Date.now() - this.authFailedAt < 60_000) {
      throw new BackendAuthError('IMAP authentication failed (cached)');
    }
    // Garde-fou SSRF au moment de la connexion (hôte issu de la découverte ou des réglages avancés) :
    // port IMAP autorisé, IP publique vérifiée puis épinglée (servername = nom d'origine pour SNI et certificat).
    // Toutes les adresses vérifiées sont candidates, IPv4 d'abord : une AAAA injoignable (pas d'IPv6 sortant) ne bloque pas.
    let candidates: Array<{ host: string; servername?: string }>;
    try {
      assertAllowedPort('imap', this.cfg.imap.port);
      candidates = await pinHostCandidates(this.cfg.imap.host);
    } catch (e) {
      if (e instanceof BlockedHostError) throw new BackendUnavailableError(`IMAP ${e.message}`);
      throw e;
    }
    const limit = DEFAULT_ACCOUNT_LIMIT;
    const release = await takeAccountSlot(this.cfg.imap.host, this.cfg.username, limit);
    let client: ImapFlow;
    try {
      client = await tryCandidates(candidates, async (pinned) => {
        const c = new ImapFlow({ ...this.options(), ...extra, host: pinned.host, ...(pinned.servername ? { servername: pinned.servername } : {}) });
        c.on('error', () => {
          /* l'erreur est remontée par la commande en cours ou par 'close' */
        });
        try {
          await c.connect();
        } catch (e) {
          try {
            c.close();
          } catch {
            /* déjà fermée */
          }
          throw e;
        }
        return c;
      });
    } catch (e) {
      release();
      const mapped = mapImapError(e);
      if (mapped instanceof BackendAuthError) {
        this.authFailedAt = Date.now();
        this.authFailure = mapped;
      }
      throw mapped instanceof Error ? mapped : new BackendUnavailableError(String(mapped));
    }
    client.once('close', release);
    this.authFailedAt = 0;
    this.authFailure = undefined;
    this.capabilities = client.capabilities;
    return client;
  }

  private startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.reap(), 30_000);
    this.timer.unref?.();
  }

  private reap() {
    const now = Date.now();
    for (const c of [...this.conns]) {
      if (!c.busy && now - c.lastUsed > this.idleMs) this.discard(c, true);
    }
    if (!this.conns.length && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private discard(c: PooledConn, logout = false) {
    this.conns = this.conns.filter((x) => x !== c);
    if (logout) c.client.logout().catch(() => c.client.close());
    else {
      try {
        c.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Ouvre une connexion en arrière-plan ; elle sert la première attente (ou reste libre). */
  private grow() {
    if (this.closed || this.conns.length + this.connecting >= this.max) return;
    this.connecting++;
    this.open().then(
      (client) => {
        this.connecting--;
        if (this.closed) {
          client.logout().catch(() => client.close());
          return;
        }
        const pc: PooledConn = { client, busy: true, lastUsed: Date.now() };
        client.on('close', () => {
          this.conns = this.conns.filter((x) => x !== pc);
        });
        this.conns.push(pc);
        this.startTimer();
        this.release(pc);
        // une connexion de réserve évite d'attendre une ouverture (≈ 300 ms) lors des opérations parallèles
        if (this.conns.length < 2) this.grow();
      },
      (e: unknown) => {
        this.connecting--;
        if (!this.conns.length && this.connecting === 0) for (const w of this.waiters.splice(0)) w.reject(e);
      },
    );
  }

  private acquire(): Promise<PooledConn> {
    for (const c of this.conns.filter((x) => !x.busy && !x.client.usable)) this.discard(c);
    const free = this.conns.find((c) => !c.busy && c.client.usable);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise<PooledConn>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.grow();
    });
  }

  private release(c: PooledConn) {
    c.lastUsed = Date.now();
    if (!c.client.usable || !this.conns.includes(c)) {
      c.busy = false;
      if (this.waiters.length) this.grow();
      return;
    }
    const w = this.waiters.shift();
    if (w) {
      c.busy = true;
      w.resolve(c);
      return;
    }
    c.busy = false;
  }

  /** Exécute `fn` avec une connexion exclusive ; une connexion tombée avant l'envoi est rouverte une fois. */
  async use<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.acquire();
      try {
        const r = await fn(c.client);
        this.release(c);
        return r;
      } catch (e) {
        const conn = isConnectionError(e) || !c.client.usable;
        if (conn) this.discard(c);
        this.release(c);
        const code = (e as ErrLike).code;
        if (conn && attempt === 0 && (code === 'NoConnection' || code === 'EConnectionClosed')) continue;
        throw mapImapError(e);
      }
    }
  }

  /** Tient un verrou de dossier le temps de `fn`. */
  withMailbox<T>(path: string, fn: (client: ImapFlow) => Promise<T>, readOnly = false): Promise<T> {
    return this.use(async (client) => {
      const wasSelected = !!client.mailbox && client.mailbox.path === path;
      const lock = await client.getMailboxLock(path, { readOnly, description: 'voxel-facade' });
      try {
        // Dossier déjà sélectionné sur cette connexion (pas de nouveau SELECT) : sa vue peut ignorer les messages
        // arrivés ou déplacés par une autre connexion (le serveur ne synchronise pas pendant FETCH/STORE/SEARCH).
        // Un NOOP (au plus une fois par seconde et par connexion) met la vue à jour avant d'agir.
        const last = this.synced.get(client);
        if (wasSelected && (!last || last.path !== path || Date.now() - last.at > 1000)) await client.noop();
        this.synced.set(client, { path, at: Date.now() });
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const all = this.conns;
    this.conns = [];
    await Promise.all(all.map((c) => c.client.logout().catch(() => c.client.close())));
  }
}
