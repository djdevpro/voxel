/**
 * Contrat de la façade IMAP → JMAP : la passerelle HTTP (`/imap/*`) ne parle qu'à cette interface.
 */

export type JmapInvocation = [name: string, args: Record<string, unknown>, callId: string];

export interface JmapRequest {
  using: string[];
  methodCalls: JmapInvocation[];
  createdIds?: Record<string, string>;
}

export interface JmapResponse {
  methodResponses: JmapInvocation[];
  sessionState: string;
  createdIds?: Record<string, string>;
}

/** Objet session JMAP (RFC 8620 §2) ; la passerelle HTTP y place ses propres URL. */
export interface JmapSessionJson {
  capabilities: Record<string, unknown>;
  accounts: Record<string, { name: string; isPersonal: boolean; isReadOnly: boolean; accountCapabilities: Record<string, unknown> }>;
  primaryAccounts: Record<string, string>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

export interface UploadResult {
  accountId: string;
  blobId: string;
  type: string;
  size: number;
}

export interface DownloadResult {
  body: ReadableStream<Uint8Array>;
  type: string;
  size?: number;
}

/** Événement poussé au client : `state` porte un objet StateChange JMAP (`{ "@type": "StateChange", changed: {...} }`). */
export type BackendEvent = { type: 'state'; data: Record<string, unknown> } | { type: 'ping' };

export interface MailBackend {
  session(): Promise<JmapSessionJson>;
  api(req: JmapRequest): Promise<JmapResponse>;
  upload(accountId: string, body: ReadableStream<Uint8Array>, type: string): Promise<UploadResult>;
  download(accountId: string, blobId: string, name: string, type?: string): Promise<DownloadResult>;
  /** Flux d'événements tant que `signal` n'est pas annulé ; doit libérer ses ressources (IDLE, SSE amont) à l'annulation. */
  events(types: string[], signal: AbortSignal): AsyncIterable<BackendEvent>;
  /** Vérifie les identifiants (LOGIN IMAP + AUTH SMTP). Lève BackendAuthError si refusés. */
  verify(): Promise<void>;
  /**
   * Vérifie les protocoles compagnons (ManageSieve, QUOTA IMAP, CardDAV) au premier `/imap/session` : 5 s au plus
   * chacun, en parallèle ; un échec rend seulement la capacité absente.
   */
  probe?(): Promise<void>;
  close(): Promise<void>;
}

export interface ImapEndpoint {
  host: string;
  port: number;
  /** true : TLS implicite (993/465) ; false : STARTTLS (143/587). */
  secure: boolean;
}

export interface ImapConfig {
  email: string;
  username: string;
  auth: { password: string };
  imap: ImapEndpoint;
  smtp: ImapEndpoint;
  /** ManageSieve (`X-Voxel-Sieve`), facultatif. */
  sieve?: ImapEndpoint;
  /** Service CardDAV (`X-Voxel-CardDav`, URL https), facultatif. */
  carddav?: string;
  /** Service CalDAV (`X-Voxel-CalDav`, URL https), facultatif. */
  caldav?: string;
}

/** Stockage clé/valeur persistant, propre à une boîte (table imap_kv). */
export interface KvStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** Identifiants refusés par le serveur de messagerie (→ `invalid_credentials` à la vérification, `upstream_auth` ensuite). */
export class BackendAuthError extends Error {
  constructor(message = 'authentication failed') {
    super(message);
    this.name = 'BackendAuthError';
  }
}

/** Serveur de messagerie injoignable ou en erreur (→ code API `upstream_unreachable`). */
export class BackendUnavailableError extends Error {
  constructor(message = 'mail server unreachable') {
    super(message);
    this.name = 'BackendUnavailableError';
  }
}
