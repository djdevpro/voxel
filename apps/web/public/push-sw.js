/*
 * Notifications push du service worker, chargé par le service worker de Workbox
 * (`importScripts`, voir vite.config.ts).
 * - `PushVerification` (RFC 8620 §7.2.2) : le code est rangé dans IndexedDB (`voxel-push`) pour la page, qui le
 *   renvoie au serveur ; rien n'est affiché.
 * - `StateChange` avec `EmailDelivery` : notification générique « Nouveau message » + nom de la boîte (texte
 *   traduit rangé par la page), sans identifiant de message ni contenu, et +1 sur la pastille de l'icône
 *   (Badging API ; nombre rangé par la page, clé `badge`). Rien si l'appli est visible (elle affiche ses propres
 *   notifications et tient la pastille à jour).
 * Les secrets ne sont jamais ici : le service worker ne parle pas au serveur de messagerie.
 */
/* eslint-disable no-restricted-globals */
(() => {
  const DB = 'voxel-push';
  const STORE = 'kv';

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function op(mode, fn) {
    const d = await idb();
    try {
      return await new Promise((resolve, reject) => {
        const r = fn(d.transaction(STORE, mode).objectStore(STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      d.close();
    }
  }

  const get = (k) => op('readonly', (s) => s.get(k));
  const put = (k, v) => op('readwrite', (s) => s.put(v, k));

  async function handle(data) {
    if (!data || typeof data !== 'object') return;
    if (data['@type'] === 'PushVerification' && typeof data.pushSubscriptionId === 'string' && typeof data.verificationCode === 'string') {
      await put(`verify:${data.pushSubscriptionId}`, data.verificationCode);
      return;
    }
    if (data['@type'] !== 'StateChange' || !data.changed || typeof data.changed !== 'object') return;
    const accounts = Object.keys(data.changed).filter((a) => data.changed[a] && typeof data.changed[a] === 'object' && 'EmailDelivery' in data.changed[a]);
    if (!accounts.length) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((w) => w.visibilityState === 'visible')) return;
    // +1 sur l'icône par boîte qui reçoit : la page remet le nombre exact de non-lus à sa prochaine ouverture
    const badge = (Number(await get('badge').catch(() => 0)) || 0) + accounts.length;
    await put('badge', badge).catch(() => undefined);
    if (self.navigator.setAppBadge) await self.navigator.setAppBadge(badge).catch(() => undefined);
    const labels = (await get('labels').catch(() => null)) || {};
    const strings = (await get('strings').catch(() => null)) || {};
    const names = [...new Set(accounts.map((a) => labels[a]).filter(Boolean))];
    await self.registration.showNotification(strings.title || 'Voxel', {
      body: names.join(', '),
      tag: 'voxel-new-mail',
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    });
  }

  self.addEventListener('push', (event) => {
    let data = null;
    try {
      data = event.data ? event.data.json() : null;
    } catch {
      data = null;
    }
    event.waitUntil(handle(data).catch(() => undefined));
  });

  self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
      (async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const w = windows.find((c) => new URL(c.url).origin === self.location.origin);
        if (w) return w.focus();
        return self.clients.openWindow('/');
      })(),
    );
  });
})();
