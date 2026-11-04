/**
 * Identités d'envoi émulées dans le KvStore (IMAP n'en a pas) : Identity/get|set|changes.
 * Une identité par défaut est créée depuis l'adresse de la boîte.
 */
import type { KvStore } from '../backend/types.js';
import { hashOf, isObject, MethodError, randomBase36, SetError, setErrorOf } from './util.js';

export interface Identity {
  id: string;
  name: string;
  email: string;
  replyTo: Array<{ name: string | null; email: string }> | null;
  bcc: Array<{ name: string | null; email: string }> | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

const KEY = 'identities';
const MUTABLE = ['name', 'replyTo', 'bcc', 'textSignature', 'htmlSignature'] as const;

export class Identities {
  constructor(
    private readonly kv: KvStore,
    private readonly email: string,
  ) {}

  all(): Identity[] {
    const raw = this.kv.get(KEY);
    if (raw) {
      try {
        const list = JSON.parse(raw) as Identity[];
        if (Array.isArray(list) && list.length) return list;
      } catch {
        /* recréée ci-dessous */
      }
    }
    const def: Identity = { id: 'i0', name: '', email: this.email, replyTo: null, bcc: null, textSignature: '', htmlSignature: '', mayDelete: false };
    this.save([def]);
    return [def];
  }

  private save(list: Identity[]) {
    this.kv.set(KEY, JSON.stringify(list));
  }

  state(): string {
    return `i${hashOf(JSON.stringify(this.all()), 12)}`;
  }

  find(id: string): Identity | undefined {
    return this.all().find((i) => i.id === id);
  }

  get(args: Record<string, unknown>): Record<string, unknown> {
    const all = this.all();
    const props = Array.isArray(args.properties) ? (args.properties as string[]) : null;
    const pick = (i: Identity) => {
      if (!props) return i;
      const o: Record<string, unknown> = { id: i.id };
      for (const p of props) if (p in i) o[p] = (i as unknown as Record<string, unknown>)[p];
      return o;
    };
    if (args.ids === null || args.ids === undefined) return { state: this.state(), list: all.map(pick), notFound: [] };
    if (!Array.isArray(args.ids)) throw new MethodError('invalidArguments', 'ids must be an array or null');
    const list: unknown[] = [];
    const notFound: string[] = [];
    for (const id of args.ids as string[]) {
      const i = all.find((x) => x.id === id);
      if (i) list.push(pick(i));
      else notFound.push(id);
    }
    return { state: this.state(), list, notFound };
  }

  changes(args: Record<string, unknown>): Record<string, unknown> {
    const state = this.state();
    if (args.sinceState === state) return { oldState: state, newState: state, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
    throw new MethodError('cannotCalculateChanges');
  }

  set(args: Record<string, unknown>, resolveId: (id: string) => string, onCreated: (cid: string, id: string) => void): Record<string, unknown> {
    const oldState = this.state();
    if (typeof args.ifInState === 'string' && args.ifInState !== oldState) throw new MethodError('stateMismatch');
    let list = this.all();
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    const updated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};

    for (const [cid, obj] of isObject(args.create) ? Object.entries(args.create) : []) {
      try {
        if (!isObject(obj)) throw new SetError('invalidProperties');
        const email = typeof obj.email === 'string' ? obj.email.trim() : '';
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new SetError('invalidProperties', 'valid email required', ['email']);
        let id = '';
        do id = `i${randomBase36(6)}`;
        while (list.some((x) => x.id === id));
        const ident: Identity = { id, name: '', email, replyTo: null, bcc: null, textSignature: '', htmlSignature: '', mayDelete: true };
        applyPatch(ident, obj, true);
        list = [...list, ident];
        onCreated(cid, id);
        created[cid] = { id, mayDelete: true };
      } catch (e) {
        notCreated[cid] = setErrorOf(e);
      }
    }
    for (const [raw, patch] of isObject(args.update) ? Object.entries(args.update) : []) {
      const id = resolveId(raw);
      try {
        const cur = list.find((x) => x.id === id);
        if (!cur) throw new SetError('notFound');
        if (!isObject(patch)) throw new SetError('invalidPatch');
        const next = { ...cur };
        applyPatch(next, patch, false);
        list = list.map((x) => (x.id === id ? next : x));
        updated[raw] = null;
      } catch (e) {
        notUpdated[raw] = setErrorOf(e);
      }
    }
    for (const raw of Array.isArray(args.destroy) ? (args.destroy as string[]) : []) {
      const id = resolveId(raw);
      const cur = list.find((x) => x.id === id);
      if (!cur) notDestroyed[raw] = { type: 'notFound' };
      else if (!cur.mayDelete) notDestroyed[raw] = { type: 'forbidden', description: 'the default identity cannot be deleted' };
      else {
        list = list.filter((x) => x.id !== id);
        destroyed.push(raw);
      }
    }
    this.save(list);
    return {
      oldState,
      newState: this.state(),
      created: Object.keys(created).length ? created : null,
      updated: Object.keys(updated).length ? updated : null,
      destroyed: destroyed.length ? destroyed : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
      notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
    };
  }
}

function applyPatch(target: Identity, patch: Record<string, unknown>, creating: boolean) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || k === 'mayDelete') {
      if (!creating && v !== (target as unknown as Record<string, unknown>)[k]) throw new SetError('invalidProperties', `${k} is immutable`, [k]);
      continue;
    }
    if (k === 'email') {
      if (!creating && v !== target.email) throw new SetError('invalidProperties', 'email is immutable', ['email']);
      continue;
    }
    if (!(MUTABLE as readonly string[]).includes(k)) throw new SetError('invalidProperties', `unknown property ${k}`, [k]);
    if (k === 'replyTo' || k === 'bcc') {
      if (v !== null && !Array.isArray(v)) throw new SetError('invalidProperties', `${k} must be an array or null`, [k]);
      const list = v === null ? null : (v as Array<{ name?: string | null; email?: string }>).filter((a) => a && typeof a.email === 'string').map((a) => ({ name: a.name ?? null, email: a.email! }));
      target[k] = list && list.length ? list : null;
    } else {
      if (typeof v !== 'string') throw new SetError('invalidProperties', `${k} must be a string`, [k]);
      target[k as 'name' | 'textSignature' | 'htmlSignature'] = v;
    }
  }
}
