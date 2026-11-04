/**
 * Façade IMAP/SMTP → JMAP. Point d'entrée unique : createImapBackend.
 *
 * Le front et le MCP parlent JMAP ; pour une boîte IMAP, chaque requête JMAP est traduite ici :
 * dossiers (folders.ts), messages et fils (messages.ts), identités émulées (identities.ts),
 * envoi SMTP (submission.ts), blobs temporaires (blobs.ts), push IDLE (push.ts).
 */
import {
  BackendAuthError,
  BackendUnavailableError,
  type BackendEvent,
  type DownloadResult,
  type ImapConfig,
  type JmapInvocation,
  type JmapRequest,
  type JmapResponse,
  type JmapSessionJson,
  type KvStore,
  type MailBackend,
  type UploadResult,
} from '../backend/types.js';
import { BlobStore } from './blobs.js';
import { ChangeLog } from './changelog.js';
export { BlobTooLargeError } from './blobs.js';
import { Folders } from './folders.js';
import { Identities } from './identities.js';
import { Messages } from './messages.js';
import { ImapPool } from './pool.js';
import { ACCOUNT_ID, Push } from './push.js';
import { Submissions } from './submission.js';
import { evalPointer, hashOf, isObject, MethodError, streamFromBuffer } from './util.js';
import { CAP_SIEVE, SieveFacade } from '../sieve/facade.js';
import { sieveTransport } from '../sieve/transport.js';
import { CardDavFacade } from '../carddav/facade.js';
import { parseDavUrl } from '../carddav/dav.js';
import { CalDavFacade } from '../caldav/facade.js';

const CAP_CORE = 'urn:ietf:params:jmap:core';
const CAP_MAIL = 'urn:ietf:params:jmap:mail';
const CAP_SUBMISSION = 'urn:ietf:params:jmap:submission';
const CAP_QUOTA = 'urn:ietf:params:jmap:quota';
const QUOTA_ID = 'q-storage';
const MAX_UPLOAD = 50_000_000;

export function createImapBackend(cfg: ImapConfig, kv: KvStore): MailBackend {
  return new ImapBackend(cfg, kv);
}

/** Erreur « blob introuvable » (le routeur peut la traduire en 404). */
export class BlobNotFoundError extends Error {
  readonly status = 404;
  constructor(blobId: string) {
    super(`blob ${blobId} not found`);
    this.name = 'BlobNotFoundError';
  }
}

class ImapBackend implements MailBackend {
  private readonly pool: ImapPool;
  private readonly folders: Folders;
  private readonly messages: Messages;
  private readonly identities: Identities;
  private readonly submissions: Submissions;
  private readonly blobs: BlobStore;
  private readonly push: Push;
  /** ManageSieve, si `X-Voxel-Sieve` est fourni. */
  private readonly sieve: SieveFacade | null;
  /** CardDAV, si `X-Voxel-CardDav` est fourni. */
  private readonly carddav: CardDavFacade | null;
  /** CalDAV, si `X-Voxel-CalDav` est fourni. */
  private readonly caldav: CalDavFacade | null;
  /** QUOTA IMAP (RFC 9208) annoncé par le serveur : connu après la première connexion. */
  private quotaAvailable = false;

  constructor(
    private readonly cfg: ImapConfig,
    kv: KvStore,
  ) {
    this.pool = new ImapPool(cfg);
    this.folders = new Folders(this.pool, kv);
    this.blobs = new BlobStore(cfg.email, MAX_UPLOAD);
    this.messages = new Messages(this.pool, this.folders, kv, this.blobs, () => this.push.notify());
    this.identities = new Identities(kv, cfg.email);
    this.submissions = new Submissions(cfg, this.messages, this.identities);
    // Journal en mémoire des créations / suppressions / changements de mots-clés (Email/changes).
    const changelog = new ChangeLog(this.pool, (list) => Folders.emailStateOf(list));
    this.folders.onList = (list) => changelog.observe(list);
    this.messages.changelog = changelog;
    this.push = new Push(this.pool, this.folders, this.messages, changelog);
    const sieveEp = cfg.sieve;
    this.sieve = sieveEp
      ? new SieveFacade({
          transport: () => sieveTransport(sieveEp),
          username: cfg.username,
          password: cfg.auth.password,
          loadUpload: async (id) => (await this.blobs.get(id))?.data ?? null,
        })
      : null;
    const davUrl = cfg.carddav ? parseDavUrl(cfg.carddav) : null;
    this.carddav = davUrl
      ? new CardDavFacade({
          serviceUrl: davUrl,
          username: cfg.username,
          password: cfg.auth.password,
          loadUpload: async (id) => (await this.blobs.get(id))?.data ?? null,
        })
      : null;
    const calUrl = cfg.caldav ? parseDavUrl(cfg.caldav) : null;
    this.caldav = calUrl
      ? new CalDavFacade({
          serviceUrl: calUrl,
          username: cfg.username,
          password: cfg.auth.password,
          loadUpload: async (id) => (await this.blobs.get(id))?.data ?? null,
        })
      : null;
  }

  async probe(): Promise<void> {
    await Promise.all([
      this.sieve?.probe(),
      this.carddav?.probe(),
      this.caldav?.probe(),
      (async () => {
        if (!this.pool.capabilities.size) {
          // aucune connexion encore ouverte : on en ouvre une (capacités IMAP), 5 s au plus
          await Promise.race([this.pool.use(async () => undefined), new Promise((r) => setTimeout(r, 5_000))]).catch(() => undefined);
        }
        this.quotaAvailable = this.pool.capabilities.has('QUOTA');
      })(),
    ]);
  }

  async session(): Promise<JmapSessionJson> {
    const sieveCap = this.sieve?.sessionCapability() ?? null;
    const davCap = this.carddav?.sessionCapability() ?? null;
    const calCap = this.caldav?.sessionCapability() ?? null;
    return {
      capabilities: {
        [CAP_CORE]: {
          maxSizeUpload: MAX_UPLOAD,
          maxConcurrentUpload: 4,
          maxSizeRequest: 10_000_000,
          maxConcurrentRequests: 4,
          maxCallsInRequest: 32,
          maxObjectsInGet: 500,
          maxObjectsInSet: 500,
          collationAlgorithms: ['i;ascii-casemap', 'i;unicode-casemap'],
        },
        [CAP_MAIL]: {},
        [CAP_SUBMISSION]: {},
        ...(sieveCap ? { [CAP_SIEVE]: sieveCap.core } : {}),
        ...(this.quotaAvailable ? { [CAP_QUOTA]: {} } : {}),
        ...(davCap?.core ?? {}),
        ...(calCap?.core ?? {}),
      },
      accounts: {
        [ACCOUNT_ID]: {
          name: this.cfg.email,
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: {
            [CAP_MAIL]: {
              maxMailboxesPerEmail: null,
              maxMailboxDepth: 10,
              maxSizeMailboxName: 200,
              maxSizeAttachmentsPerEmail: 25_000_000,
              emailQuerySortOptions: ['receivedAt'],
              mayCreateTopLevelMailbox: true,
            },
            [CAP_SUBMISSION]: { maxDelayedSend: 0, submissionExtensions: {} },
            ...(sieveCap ? { [CAP_SIEVE]: sieveCap.account } : {}),
            ...(this.quotaAvailable ? { [CAP_QUOTA]: {} } : {}),
            ...(davCap?.account ?? {}),
            ...(calCap?.account ?? {}),
          },
        },
      },
      primaryAccounts: {
        [CAP_MAIL]: ACCOUNT_ID,
        [CAP_SUBMISSION]: ACCOUNT_ID,
        ...(sieveCap ? { [CAP_SIEVE]: ACCOUNT_ID } : {}),
        ...(this.quotaAvailable ? { [CAP_QUOTA]: ACCOUNT_ID } : {}),
        ...(davCap ? Object.fromEntries(Object.keys(davCap.core).map((k) => [k, ACCOUNT_ID])) : {}),
        ...(calCap ? Object.fromEntries(Object.keys(calCap.core).map((k) => [k, ACCOUNT_ID])) : {}),
      },
      username: this.cfg.email,
      apiUrl: '/imap/api',
      downloadUrl: '/jmap/download/{accountId}/{blobId}/{name}?type={type}',
      uploadUrl: '/jmap/upload/{accountId}/',
      eventSourceUrl: '/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
      state: `j${hashOf(`${this.cfg.email}|imap|1`, 10)}`,
    };
  }

  async verify(): Promise<void> {
    const client = await this.pool.open();
    await client.logout().catch(() => client.close());
    await this.submissions.verify();
  }

  async upload(accountId: string, body: ReadableStream<Uint8Array>, type: string): Promise<UploadResult> {
    if (accountId !== ACCOUNT_ID) throw new BlobNotFoundError(accountId);
    const r = await this.blobs.put(body, type);
    return { accountId, blobId: r.blobId, type: r.type, size: r.size };
  }

  async download(accountId: string, blobId: string, _name: string, type?: string): Promise<DownloadResult> {
    if (accountId !== ACCOUNT_ID) throw new BlobNotFoundError(blobId);
    if (this.sieve && SieveFacade.isScriptBlob(blobId)) {
      const text = await this.sieve.scriptContent(blobId);
      if (text === null) throw new BlobNotFoundError(blobId);
      const data = Buffer.from(text, 'utf8');
      return { body: streamFromBuffer(data), type: type || 'application/sieve', size: data.length };
    }
    const r = await this.messages.loadBlob(blobId);
    if (!r) throw new BlobNotFoundError(blobId);
    return { body: streamFromBuffer(r.data), type: type || r.type, size: r.data.length };
  }

  events(types: string[], signal: AbortSignal): AsyncIterable<BackendEvent> {
    return this.push.events(types, signal);
  }

  async close(): Promise<void> {
    this.push.close();
    this.sieve?.close();
    this.carddav?.close();
    this.caldav?.close();
    await this.pool.close();
  }

  // ---------------------------------------------------------------- requêtes JMAP

  async api(req: JmapRequest): Promise<JmapResponse> {
    const responses: JmapInvocation[] = [];
    const createdIds: Record<string, string> = { ...(req.createdIds ?? {}) };
    const resolveId = (id: string): string => {
      if (typeof id === 'string' && id.startsWith('#')) return createdIds[id.slice(1)] ?? id;
      return id;
    };
    const onCreated = (cid: string, id: string) => {
      createdIds[cid] = id;
    };
    for (const call of req.methodCalls ?? []) {
      const [name, rawArgs, callId] = call;
      try {
        const args = this.resolveRefs(isObject(rawArgs) ? rawArgs : {}, responses);
        if (args.accountId !== undefined && args.accountId !== ACCOUNT_ID && name !== 'Core/echo') throw new MethodError('accountNotFound');
        const out = await this.call(name, args, resolveId, onCreated);
        for (const [n, body] of out) responses.push([n, body, callId]);
      } catch (e) {
        if (e instanceof BackendAuthError || e instanceof BackendUnavailableError) throw e;
        const body = e instanceof MethodError ? e.toJSON() : { type: 'serverFail', description: e instanceof Error ? e.message : String(e) };
        responses.push(['error', body, callId]);
      }
    }
    const res: JmapResponse = { methodResponses: responses, sessionState: (await this.session()).state };
    if (req.createdIds) res.createdIds = createdIds;
    return res;
  }

  /** Résout les arguments `#nom` (références arrière, RFC 8620 §3.7). */
  private resolveRefs(args: Record<string, unknown>, responses: JmapInvocation[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (!k.startsWith('#')) {
        out[k] = v;
        continue;
      }
      const plain = k.slice(1);
      if (plain in args) throw new MethodError('invalidArguments', `both ${plain} and #${plain} given`);
      if (!isObject(v) || typeof v.resultOf !== 'string' || typeof v.name !== 'string' || typeof v.path !== 'string')
        throw new MethodError('invalidResultReference', `bad reference for ${k}`);
      const target = responses.find(([n, , id]) => id === v.resultOf && n === v.name);
      if (!target) throw new MethodError('invalidResultReference', `no ${String(v.name)} response for ${String(v.resultOf)}`);
      out[plain] = evalPointer(target[1], v.path as string);
    }
    return out;
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    resolveId: (id: string) => string,
    onCreated: (cid: string, id: string) => void,
  ): Promise<Array<[string, Record<string, unknown>]>> {
    const withAccount = (r: Record<string, unknown>) => ({ accountId: ACCOUNT_ID, ...r });
    switch (name) {
      case 'Core/echo':
        return [[name, args]];
      case 'Mailbox/get':
        return [[name, withAccount(await this.folders.get(args))]];
      case 'Mailbox/query':
        return [[name, withAccount(await this.folders.query(args))]];
      case 'Mailbox/changes':
        return [[name, withAccount(await this.folders.changes(args))]];
      case 'Mailbox/set': {
        const r = await this.folders.set(args, resolveId, onCreated);
        if (r.created || r.updated || r.destroyed) {
          this.messages.invalidateQueries();
          this.push.notify();
        }
        return [[name, withAccount(r)]];
      }
      case 'Email/get':
        return [[name, withAccount(await this.messages.get(args))]];
      case 'Email/query':
        return [[name, withAccount(await this.messages.query(args))]];
      case 'Email/queryChanges':
        return [[name, withAccount(await this.messages.queryChanges(args))]];
      case 'Email/changes':
        return [[name, withAccount(await this.messages.changes(args))]];
      case 'Email/set':
        return [[name, withAccount(await this.messages.set(args, resolveId, onCreated))]];
      case 'Email/import':
        return [[name, withAccount(await this.messages.importEmails(args, onCreated, resolveId))]];
      case 'Thread/get':
        return [[name, withAccount(await this.messages.threads(args))]];
      case 'Thread/changes':
        return [[name, withAccount(await this.messages.threadChanges(args))]];
      case 'SearchSnippet/get':
        return [[name, withAccount(await this.messages.snippets(args))]];
      case 'Identity/get':
        return [[name, withAccount(this.identities.get(args))]];
      case 'Identity/set':
        return [[name, withAccount(this.identities.set(args, resolveId, onCreated))]];
      case 'Identity/changes':
        return [[name, withAccount(this.identities.changes(args))]];
      case 'EmailSubmission/get':
        return [[name, withAccount(this.submissions.get(args))]];
      case 'EmailSubmission/changes':
        throw new MethodError('cannotCalculateChanges');
      case 'EmailSubmission/set': {
        const r = await this.submissions.set(args, resolveId, onCreated);
        const out: Array<[string, Record<string, unknown>]> = [[name, withAccount(r.response)]];
        if (r.emailSet) {
          const emailSet = r.emailSet;
          out.push(['Email/set', withAccount(await this.messages.set(emailSet, resolveId, onCreated))]);
        } else {
          this.push.notify();
        }
        return out;
      }
      case 'SieveScript/get':
        return [[name, withAccount(await this.sieveOrFail().get(args))]];
      case 'SieveScript/query':
        return [[name, withAccount(await this.sieveOrFail().query(args))]];
      case 'SieveScript/validate':
        return [[name, withAccount(await this.sieveOrFail().validate(args))]];
      case 'SieveScript/set':
        return [[name, withAccount(await this.sieveOrFail().set(args, resolveId, onCreated))]];
      case 'SieveScript/changes':
        throw new MethodError('cannotCalculateChanges');
      case 'AddressBook/get':
        return [[name, withAccount(await this.davOrFail().addressBookGet(args))]];
      case 'AddressBook/changes':
        return [[name, withAccount(await this.davOrFail().addressBookChanges(args))]];
      case 'ContactCard/get':
        return [[name, withAccount(await this.davOrFail().get(args))]];
      case 'ContactCard/query':
        return [[name, withAccount(await this.davOrFail().query(args))]];
      case 'ContactCard/changes':
        return [[name, withAccount(await this.davOrFail().changes(args))]];
      case 'ContactCard/set':
        return [[name, withAccount(await this.davOrFail().set(args, resolveId, onCreated))]];
      case 'ContactCard/parse':
        return [[name, withAccount(await this.davOrFail().parse(args))]];
      case 'ContactCard/queryChanges':
        throw new MethodError('cannotCalculateChanges');
      case 'Calendar/get':
        return [[name, withAccount(await this.calOrFail().calendarGet(args))]];
      case 'Calendar/changes':
        return [[name, withAccount(await this.calOrFail().calendarChanges(args))]];
      case 'CalendarEvent/get':
        return [[name, withAccount(await this.calOrFail().get(args))]];
      case 'CalendarEvent/query':
        return [[name, withAccount(await this.calOrFail().query(args))]];
      case 'CalendarEvent/changes':
        return [[name, withAccount(await this.calOrFail().changes(args))]];
      case 'CalendarEvent/set':
        return [[name, withAccount(await this.calOrFail().set(args, resolveId, onCreated))]];
      case 'CalendarEvent/parse':
        return [[name, withAccount(await this.calOrFail().parse(args))]];
      case 'CalendarEvent/queryChanges':
        throw new MethodError('cannotCalculateChanges');
      case 'Quota/get':
        return [[name, withAccount(await this.quotaGet(args))]];
      case 'Quota/changes':
        throw new MethodError('cannotCalculateChanges');
      default:
        throw new MethodError('unknownMethod', `${name} is not supported for IMAP mailboxes`);
    }
  }

  private davOrFail(): CardDavFacade {
    if (!this.carddav || !this.carddav.available) throw new MethodError('unknownMethod', 'CardDAV is not available for this mailbox');
    return this.carddav;
  }

  private calOrFail(): CalDavFacade {
    if (!this.caldav || !this.caldav.available) throw new MethodError('unknownMethod', 'CalDAV is not available for this mailbox');
    return this.caldav;
  }

  private sieveOrFail(): SieveFacade {
    if (!this.sieve || !this.sieve.available) throw new MethodError('unknownMethod', 'ManageSieve is not available for this mailbox');
    return this.sieve;
  }

  /** QUOTA IMAP (RFC 9208) → `Quota/get` (RFC 9425) : `GETQUOTAROOT INBOX`, ressource STORAGE (Ko → octets). */
  private async quotaGet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.quotaAvailable) throw new MethodError('unknownMethod', 'QUOTA is not available for this mailbox');
    const q = await this.pool.use((c) => c.getQuota('INBOX'));
    const storage = q && typeof q === 'object' ? q.storage : undefined;
    const list =
      storage && typeof storage.limit === 'number' && storage.limit > 0
        ? [
            {
              id: QUOTA_ID,
              resourceType: 'octets',
              used: storage.usage ?? 0,
              hardLimit: storage.limit,
              scope: 'account',
              name: this.cfg.email,
              types: ['Email'],
              warnLimit: null,
              softLimit: null,
              description: null,
            },
          ]
        : [];
    const ids = Array.isArray(args.ids) ? (args.ids as string[]) : null;
    return {
      state: `q${hashOf(JSON.stringify(list.map((x) => [x.used, x.hardLimit])), 12)}`,
      list: ids ? list.filter((x) => ids.includes(x.id)) : list,
      notFound: ids ? ids.filter((id) => !list.some((x) => x.id === id)) : [],
    };
  }
}
