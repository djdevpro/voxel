/**
 * Notifications push, onglet fermé, pour les boîtes JMAP qui annoncent
 * `urn:ietf:params:jmap:webpush-vapid`.
 *
 * 1. Abonnement Web Push du navigateur avec la clé VAPID de la session (`applicationServerKey`).
 * 2. `PushSubscription/set` (RFC 8620 §7.2) : point de terminaison et clés du navigateur, types `EmailDelivery`.
 * 3. Le serveur envoie une `PushVerification` : le service worker (`public/push-sw.js`) range le code dans
 *    IndexedDB (`voxel-push`), la page le relit et le renvoie (`verificationCode`).
 * 4. À chaque `StateChange` avec `EmailDelivery`, le service worker affiche « Nouveau message » et la boîte,
 *    sans identifiant de message ni contenu ; tout s'affiche à l'ouverture de l'appli.
 *
 * Réglage par boîte (Dexie `kv`, clé `push:<id>`). Les boîtes IMAP n'ont que les notifications appli ouverte
 * (`useSync`) : la passerelle ne garde rien et ne peut pas veiller seule.
 * Stalwart v1.0.1 (vérifié le 2026-11-03) : expiration fixée à 7 jours, prolongeable par `expires`.
 */
import { CAP, type WebPushVapidCapability } from '@voxel/jmap';
import { db } from './db';
import { jmap } from './jmap';
import i18n from '@/i18n';
import { isDesktop } from './platform';

// ------------------------------------------------------------------ IndexedDB partagée avec le service worker

const IDB_NAME = 'voxel-push';
const IDB_STORE = 'kv';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbOp<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await idb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(d.transaction(IDB_STORE, mode).objectStore(IDB_STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}

const idbGet = <T>(k: string) => idbOp<T | undefined>('readonly', (s) => s.get(k) as IDBRequest<T | undefined>);
const idbPut = (k: string, v: unknown) => idbOp('readwrite', (s) => s.put(v, k));
const idbDel = (k: string) => idbOp('readwrite', (s) => s.delete(k));

// ------------------------------------------------------------------ état local

interface PushState {
  /** Identifiant JMAP de l'abonnement. */
  subscriptionId: string;
  /** Compte JMAP (clé de `StateChange.changed`). */
  jmapAccountId: string;
  expires?: string | null;
}

export function pushSupported(): boolean {
  if (isDesktop) return false;
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function pushState(accountId: string): Promise<PushState | null> {
  return ((await db.kv.get(`push:${accountId}`))?.value as PushState | undefined) ?? null;
}

/** Identifiant stable de l'appareil (`deviceClientId`), sans lien avec l'utilisateur. */
async function deviceClientId(): Promise<string> {
  const row = await db.kv.get('push:device');
  if (typeof row?.value === 'string') return row.value;
  const id = `voxel-${crypto.randomUUID()}`;
  await db.kv.put({ key: 'push:device', value: id });
  return id;
}

function b64url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Libellés lus par le service worker : texte traduit et nom de chaque boîte, par compte JMAP. */
export async function writePushLabels(): Promise<void> {
  if (!pushSupported()) return;
  const rows = await db.kv.where('key').startsWith('push:').toArray();
  const accounts = await db.accounts.toArray();
  const labels: Record<string, string> = {};
  for (const r of rows) {
    if (r.key === 'push:device') continue;
    const st = r.value as PushState;
    const acc = accounts.find((a) => `push:${a.id}` === r.key);
    if (acc && st?.jmapAccountId) labels[st.jmapAccountId] = acc.displayName || acc.email;
  }
  await idbPut('labels', labels);
  await idbPut('strings', { title: i18n.t('accounts:notification.newMessage') });
}

// ------------------------------------------------------------------ activation

export type PushError = 'unsupported' | 'denied' | 'capability' | 'conflict' | 'verification' | 'server';

export class PushSetupError extends Error {
  constructor(public code: PushError, message?: string) {
    super(message ?? code);
  }
}

/** Abonnement du navigateur pour une clé VAPID donnée (réutilisé s'il existe avec la même clé). */
async function browserSubscription(key: string): Promise<PushSubscription> {
  // pas de service worker (mode développement, navigation privée…) : `ready` ne se résoudrait jamais
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg?.active) throw new PushSetupError('unsupported');
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    const cur = existing.options.applicationServerKey ? b64url(existing.options.applicationServerKey) : '';
    if (cur === key.replace(/=+$/, '')) return existing;
    // autre serveur (autre clé VAPID) déjà abonné sur cet appareil : un seul abonnement par service worker
    const others = (await db.kv.where('key').startsWith('push:').toArray()).filter((r) => r.key !== 'push:device');
    if (others.length) throw new PushSetupError('conflict');
    await existing.unsubscribe();
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(key) });
}

/** Attend le code de vérification rangé par le service worker (30 s au plus). */
async function waitVerification(subscriptionId: string, timeoutMs = 30_000): Promise<string | null> {
  const key = `verify:${subscriptionId}`;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const code = await idbGet<string>(key);
    if (code) {
      await idbDel(key);
      return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** Active les notifications push d'une boîte JMAP. */
export async function enablePush(accountId: string): Promise<void> {
  if (!pushSupported()) throw new PushSetupError('unsupported');
  const c = jmap(accountId);
  const session = await c.getSession();
  const cap = session.capabilities[CAP.webpush] as WebPushVapidCapability | undefined;
  if (!cap?.applicationServerKey) throw new PushSetupError('capability');
  if (!(await navigator.serviceWorker.getRegistration())?.active) throw new PushSetupError('unsupported');
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') throw new PushSetupError('denied');
  const sub = await browserSubscription(cap.applicationServerKey);
  const json = sub.toJSON();
  const device = await deviceClientId();
  // anciens abonnements de cet appareil pour ce compte : remplacés
  const prev = await c.call('PushSubscription/get', { ids: null });
  const stale = prev.list.filter((s) => s.deviceClientId === device).map((s) => s.id);
  const r = await c.call('PushSubscription/set', {
    ...(stale.length ? { destroy: stale } : {}),
    create: {
      p: {
        deviceClientId: device,
        url: sub.endpoint,
        keys: json.keys?.p256dh && json.keys?.auth ? { p256dh: json.keys.p256dh, auth: json.keys.auth } : null,
        types: ['EmailDelivery'],
      },
    },
  });
  const created = r.created?.p;
  if (!created?.id) throw new PushSetupError('server', r.notCreated?.p?.description ?? r.notCreated?.p?.type);
  const code = await waitVerification(created.id);
  if (!code) {
    await c.call('PushSubscription/set', { destroy: [created.id] }).catch(() => undefined);
    throw new PushSetupError('verification');
  }
  const v = await c.call('PushSubscription/set', { update: { [created.id]: { verificationCode: code } } });
  if (v.notUpdated?.[created.id]) throw new PushSetupError('verification', v.notUpdated[created.id]!.description);
  const state: PushState = { subscriptionId: created.id, jmapAccountId: await c.accountId(), expires: created.expires ?? null };
  await db.kv.put({ key: `push:${accountId}`, value: state });
  await writePushLabels();
}

/** Désactive les notifications push d'une boîte (et l'abonnement du navigateur s'il ne sert plus). */
export async function disablePush(accountId: string, opts: { remote?: boolean } = {}): Promise<void> {
  const st = await pushState(accountId);
  await db.kv.delete(`push:${accountId}`);
  if (st && opts.remote !== false) await jmap(accountId).call('PushSubscription/set', { destroy: [st.subscriptionId] }).catch(() => undefined);
  await writePushLabels().catch(() => undefined);
  const left = (await db.kv.where('key').startsWith('push:').toArray()).filter((r) => r.key !== 'push:device');
  if (!left.length && pushSupported()) {
    const reg = await navigator.serviceWorker.getRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => undefined);
  }
}

/** Désactive toutes les boîtes (« Tout déconnecter »). */
export async function disableAllPush(): Promise<void> {
  const rows = (await db.kv.where('key').startsWith('push:').toArray()).filter((r) => r.key !== 'push:device');
  for (const r of rows) await disablePush(r.key.slice('push:'.length)).catch(() => undefined);
}

/**
 * Au démarrage : prolonge les abonnements proches de l'expiration et recrée ceux que le serveur a oubliés.
 * Erreurs avalées (nouvel essai au prochain démarrage).
 */
export async function renewPushSubscriptions(accountIds: string[]): Promise<void> {
  if (!pushSupported()) return;
  for (const id of accountIds) {
    const st = await pushState(id).catch(() => null);
    if (!st) continue;
    try {
      const c = jmap(id);
      const g = await c.call('PushSubscription/get', { ids: [st.subscriptionId] });
      const cur = g.list[0];
      if (!cur) {
        await enablePush(id);
        continue;
      }
      const left = cur.expires ? Date.parse(cur.expires) - Date.now() : Infinity;
      if (left < 3 * 86400_000) {
        const expires = new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        await c.call('PushSubscription/set', { update: { [st.subscriptionId]: { expires } } });
        await db.kv.put({ key: `push:${id}`, value: { ...st, expires } });
      }
    } catch (e) {
      console.warn('push: renew failed', e);
    }
  }
  await writePushLabels().catch(() => undefined);
}

// texte de la notification dans la langue courante
i18n.on('languageChanged', () => {
  void db.kv
    .where('key')
    .startsWith('push:')
    .count()
    .then((n) => (n > 1 ? writePushLabels() : undefined))
    .catch(() => undefined);
});
