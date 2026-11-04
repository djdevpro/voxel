/**
 * Façade ManageSieve → JMAP for Sieve (RFC 9661) pour les boîtes IMAP de la passerelle.
 *
 * - `SieveScript/get|query|set|validate` ; `VacationResponse` n'est pas annoncé (répondeur par le script géré).
 * - Identifiants dérivés du nom (`s` + empreinte), blobs dérivés du contenu (`Z` + empreinte hexadécimale) :
 *   rien n'est écrit côté serveur ; un blob inconnu est retrouvé en relisant les scripts.
 * - État (`state`) : empreinte de la liste (noms, script actif, contenus).
 * - Connexion ManageSieve mutualisée (une par façade), fermée après une minute d'inactivité.
 */
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { hashOf, isObject, MethodError, SetError } from '../imap/util.js';
import { ManageSieveClient, SieveAuthError, SieveResponseError, type SieveCapabilities } from './client.js';

export const CAP_SIEVE = 'urn:ietf:params:jmap:sieve';
const IDLE_MS = 60_000;
const PROBE_MS = 5_000;
const MAX_SCRIPT = 1024 * 1024;
const VACATION_NAME = 'vacation';

export interface SieveFacadeOptions {
  transport: () => { connect: () => Promise<Duplex>; upgrade?: (s: Duplex) => Promise<Duplex> };
  username: string;
  password: string;
  /** Contenu d'un blob téléversé (BlobStore de la façade IMAP). */
  loadUpload: (blobId: string) => Promise<Buffer | null>;
}

interface Listed {
  id: string;
  name: string;
  isActive: boolean;
  blobId: string;
  content: string;
}

const scriptId = (name: string) => `s${hashOf(`sieve:${name}`, 16)}`;
const blobIdOf = (content: string) => `Z${createHash('sha256').update(content).digest('hex').slice(0, 40)}`;

export class SieveFacade {
  private client: ManageSieveClient | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private blobs = new Map<string, string>();
  /** Résultat de la vérification faite au premier `/imap/session` (null : pas encore vérifié). */
  available: boolean | null = null;
  caps: SieveCapabilities | null = null;

  constructor(private readonly opts: SieveFacadeOptions) {}

  static isScriptBlob(blobId: string): boolean {
    return /^Z[0-9a-f]{40}$/.test(blobId);
  }

  /** Vérification (connexion + authentification), 5 s au plus ; échec silencieux = capacité absente. */
  async probe(): Promise<boolean> {
    if (this.available !== null) return this.available;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.use(async () => undefined),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_MS))),
      ]);
      this.available = true;
    } catch {
      this.available = false;
      this.close();
    } finally {
      clearTimeout(timer);
    }
    return this.available;
  }

  /** Capacités JMAP à annoncer (session), si la vérification a réussi. */
  sessionCapability(): { core: Record<string, unknown>; account: Record<string, unknown> } | null {
    if (!this.available || !this.caps) return null;
    return {
      core: {},
      account: {
        maxSizeScriptName: 512,
        maxSizeScript: this.caps.maxScriptSize ?? null,
        maxNumberScripts: null,
        maxNumberRedirects: this.caps.maxRedirects ?? null,
        sieveExtensions: [...this.caps.sieve].sort(),
        notificationMethods: null,
        externalLists: null,
      },
    };
  }

  private async use<T>(fn: (c: ManageSieveClient) => Promise<T>): Promise<T> {
    clearTimeout(this.idle);
    for (let attempt = 0; ; attempt++) {
      if (!this.client || !this.client.connected) {
        const t = this.opts.transport();
        this.client = new ManageSieveClient({ ...t, username: this.opts.username, password: this.opts.password });
        try {
          this.caps = await this.client.connect();
        } catch (e) {
          this.client.destroy();
          this.client = null;
          throw e;
        }
      }
      try {
        return await fn(this.client);
      } catch (e) {
        // connexion tombée entre deux requêtes : une seule reconnexion
        if (attempt === 0 && !(e instanceof SieveResponseError) && !(e instanceof SieveAuthError) && !this.client?.connected) continue;
        throw e;
      } finally {
        this.idle = setTimeout(() => this.close(), IDLE_MS);
        this.idle.unref?.();
      }
    }
  }

  close(): void {
    clearTimeout(this.idle);
    const c = this.client;
    this.client = null;
    if (c) void c.logout().catch(() => undefined);
  }

  private remember(content: string): string {
    const id = blobIdOf(content);
    if (this.blobs.size > 64) this.blobs.delete(this.blobs.keys().next().value!);
    this.blobs.set(id, content);
    return id;
  }

  private async list(): Promise<Listed[]> {
    return this.use(async (c) => {
      const scripts = await c.listScripts();
      const out: Listed[] = [];
      for (const s of scripts) {
        const content = await c.getScript(s.name);
        out.push({ id: scriptId(s.name), name: s.name, isActive: s.active, blobId: this.remember(content), content });
      }
      return out;
    });
  }

  private static stateOf(list: Listed[]): string {
    return `v${hashOf(JSON.stringify(list.map((s) => [s.name, s.isActive, s.blobId]).sort()), 16)}`;
  }

  /** Contenu d'un blob de script (cache, sinon relecture des scripts). */
  async scriptContent(blobId: string): Promise<string | null> {
    const cached = this.blobs.get(blobId);
    if (cached !== undefined) return cached;
    if (!SieveFacade.isScriptBlob(blobId)) return null;
    const found = (await this.list()).find((s) => s.blobId === blobId);
    return found ? found.content : null;
  }

  /** Texte d'un blob : script existant ou fichier téléversé. */
  private async blobText(blobId: unknown): Promise<string> {
    if (typeof blobId !== 'string') throw new SetError('invalidProperties', 'blobId required', ['blobId']);
    const script = SieveFacade.isScriptBlob(blobId) ? await this.scriptContent(blobId) : null;
    if (script !== null) return script;
    const up = await this.opts.loadUpload(blobId);
    if (!up) throw new SetError('blobNotFound', `blob ${blobId} not found`, ['blobId']);
    if (up.length > MAX_SCRIPT) throw new SetError('tooLarge', 'script too large', ['blobId']);
    return up.toString('utf8');
  }

  // ---------------------------------------------------------------- méthodes JMAP

  async get(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.list();
    const ids = Array.isArray(args.ids) ? (args.ids as string[]) : null;
    const props = Array.isArray(args.properties) ? new Set(['id', ...(args.properties as string[])]) : null;
    const pick = (s: Listed) => {
      const full: Record<string, unknown> = { id: s.id, name: s.name, blobId: s.blobId, isActive: s.isActive };
      return props ? Object.fromEntries(Object.entries(full).filter(([k]) => props.has(k))) : full;
    };
    const found = ids ? list.filter((s) => ids.includes(s.id)) : list;
    return {
      state: SieveFacade.stateOf(list),
      list: found.map(pick),
      notFound: ids ? ids.filter((id) => !list.some((s) => s.id === id)) : [],
    };
  }

  async query(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.list();
    const f = isObject(args.filter) ? args.filter : {};
    let out = list;
    if (typeof f.name === 'string') out = out.filter((s) => s.name.toLowerCase().includes((f.name as string).toLowerCase()));
    if (typeof f.isActive === 'boolean') out = out.filter((s) => s.isActive === f.isActive);
    out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    const position = typeof args.position === 'number' ? Math.max(0, args.position) : 0;
    const limit = typeof args.limit === 'number' ? Math.max(0, args.limit) : out.length;
    return { queryState: SieveFacade.stateOf(list), canCalculateChanges: false, position, ids: out.slice(position, position + limit).map((s) => s.id), total: out.length };
  }

  async validate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await this.blobText(args.blobId);
    } catch (e) {
      if (e instanceof SetError) throw new MethodError('invalidArguments', e.message);
      throw e;
    }
    const err = await this.use((c) => c.checkScript(text));
    return { error: err === null ? null : { type: 'invalidScript', description: err } };
  }

  async set(args: Record<string, unknown>, resolveId: (id: string) => string, onCreated: (cid: string, id: string) => void): Promise<Record<string, unknown>> {
    const before = await this.list();
    if (typeof args.ifInState === 'string' && args.ifInState !== SieveFacade.stateOf(before)) throw new MethodError('stateMismatch');
    const byId = new Map(before.map((s) => [s.id, s]));
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    const updated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};
    const createdIds = new Map<string, string>();
    const toSetErr = (e: unknown) => {
      if (e instanceof SetError) return e.toJSON();
      if (e instanceof SieveResponseError) {
        const type = e.code?.toUpperCase().startsWith('QUOTA') ? 'overQuota' : e.code?.toUpperCase() === 'ALREADYEXISTS' ? 'alreadyExists' : 'invalidScript';
        return { type, description: e.message };
      }
      throw e;
    };
    const checkName = (name: unknown): string => {
      if (typeof name !== 'string' || !name.trim() || name.length > 512 || /[\0\r\n]/.test(name)) throw new SetError('invalidProperties', 'invalid name', ['name']);
      if (name === VACATION_NAME) throw new SetError('forbidden', 'reserved name', ['name']);
      return name;
    };

    for (const [cid, raw] of Object.entries(isObject(args.create) ? args.create : {})) {
      try {
        if (!isObject(raw)) throw new SetError('invalidProperties');
        const name = checkName(raw.name);
        if ([...byId.values()].some((s) => s.name === name)) throw new SetError('alreadyExists', 'a script with this name exists', ['name']);
        const text = await this.blobText(raw.blobId);
        await this.use((c) => c.putScript(name, text));
        const id = scriptId(name);
        byId.set(id, { id, name, isActive: false, blobId: this.remember(text), content: text });
        createdIds.set(cid, id);
        onCreated(cid, id);
        created[cid] = { id, blobId: blobIdOf(text), isActive: false };
      } catch (e) {
        notCreated[cid] = toSetErr(e);
      }
    }

    for (const [rawId, patch] of Object.entries(isObject(args.update) ? args.update : {})) {
      const id = resolveId(rawId);
      const cur = byId.get(id);
      try {
        if (!cur) throw new SetError('notFound');
        if (!isObject(patch)) throw new SetError('invalidPatch');
        if (cur.name === VACATION_NAME) throw new SetError('forbidden', 'reserved script');
        if (patch.blobId !== undefined) {
          const text = await this.blobText(patch.blobId);
          await this.use((c) => c.putScript(cur.name, text));
          cur.content = text;
          cur.blobId = this.remember(text);
        }
        let out: Record<string, unknown> | null = null;
        if (patch.name !== undefined && patch.name !== cur.name) {
          const name = checkName(patch.name);
          await this.use((c) => c.renameScript(cur.name, name));
          byId.delete(id);
          const nid = scriptId(name);
          byId.set(nid, { ...cur, id: nid, name });
          out = { id: nid };
        }
        updated[id] = patch.blobId !== undefined ? { ...(out ?? {}), blobId: cur.blobId } : out;
      } catch (e) {
        notUpdated[id] = toSetErr(e);
      }
    }

    for (const rawId of Array.isArray(args.destroy) ? (args.destroy as string[]) : []) {
      const id = resolveId(rawId);
      const cur = byId.get(id);
      try {
        if (!cur) throw new SetError('notFound');
        if (cur.isActive) throw new SetError('scriptIsActive', 'an active script cannot be destroyed');
        await this.use((c) => c.deleteScript(cur.name));
        byId.delete(id);
        destroyed.push(id);
      } catch (e) {
        notDestroyed[id] = toSetErr(e);
      }
    }

    // activation après les écritures (RFC 9661 §2.2)
    const anySuccess = Object.keys(created).length + Object.keys(updated).length + destroyed.length > 0 || (!args.create && !args.update && !args.destroy);
    if (anySuccess) {
      const act = args.onSuccessActivateScript;
      if (typeof act === 'string') {
        const id = act.startsWith('#') ? (createdIds.get(act.slice(1)) ?? resolveId(act)) : act;
        const target = byId.get(id);
        if (target) {
          await this.use((c) => c.setActive(target.name));
          const cidOf = new Map([...createdIds].map(([cid, sid]) => [sid, cid]));
          for (const s of byId.values()) {
            const was = s.isActive;
            s.isActive = s.id === target.id;
            if (was === s.isActive) continue;
            const cid = cidOf.get(s.id);
            if (cid) created[cid] = { ...(created[cid] as object), isActive: s.isActive };
            else updated[s.id] = { ...((updated[s.id] as object) ?? {}), isActive: s.isActive };
          }
        }
      } else if (args.onSuccessDeactivateScript === true) {
        await this.use((c) => c.setActive(''));
        for (const s of byId.values()) {
          if (s.isActive) updated[s.id] = { ...((updated[s.id] as object) ?? {}), isActive: false };
          s.isActive = false;
        }
      }
    }

    const after = [...byId.values()];
    const res: Record<string, unknown> = { oldState: SieveFacade.stateOf(before), newState: SieveFacade.stateOf(after) };
    res.created = Object.keys(created).length ? created : null;
    res.updated = Object.keys(updated).length ? updated : null;
    res.destroyed = destroyed.length ? destroyed : null;
    res.notCreated = Object.keys(notCreated).length ? notCreated : null;
    res.notUpdated = Object.keys(notUpdated).length ? notUpdated : null;
    res.notDestroyed = Object.keys(notDestroyed).length ? notDestroyed : null;
    return res;
  }
}
