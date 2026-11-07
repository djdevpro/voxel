/** Application de bureau (Tauri) : détection et ponts vers le cœur Rust. Sur le web, rien de ce module ne s'exécute, et @tauri-apps/api n'est jamais chargé (imports dynamiques). */

type NetTarget = { kind: 'gateway'; path: string } | { kind: 'http'; url: string };
interface NetHead {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}
type NetEnd = { end: true } | { error: string };

export const isDesktop: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let corePromise: Promise<typeof import('@tauri-apps/api/core')> | undefined;
const core = () => (corePromise ??= import('@tauri-apps/api/core'));

/** Compteur des requêtes `net_fetch` de la page. */
let nextId = 0;

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** Cible du cœur pour une URL : `null` pour les fichiers de l'appli (même origine, hors `/imap/`). */
function targetOf(input: RequestInfo | URL): { url: URL; target: NetTarget | null } {
  const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  const url = new URL(raw, location.href);
  // schéma et hôte plutôt que l'origine : celle de `tauri://localhost` (WebKitGTK) peut être opaque
  if (url.protocol === location.protocol && url.host === location.host) {
    if (!url.pathname.startsWith('/imap/')) return { url, target: null };
    return { url, target: { kind: 'gateway', path: url.pathname + url.search } };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return { url, target: { kind: 'http', url: url.href } };
  throw new TypeError('Failed to fetch');
}

async function bodyBytes(body: BodyInit | null | undefined, headers: Headers): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  if (typeof body === 'string') {
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/plain;charset=UTF-8');
    return new TextEncoder().encode(body);
  }
  if (body instanceof Blob) {
    if (!headers.has('Content-Type') && body.type) headers.set('Content-Type', body.type);
    return new Uint8Array(await body.arrayBuffer());
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) {
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
    return new TextEncoder().encode(body.toString());
  }
  throw new TypeError('unsupported body');
}

/** `fetch` du bureau : les requêtes réseau passent par la commande Rust `net_fetch`, le corps revient en flux. */
export async function desktopFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, target } = targetOf(input);
  if (!target) return globalThis.fetch(url.href, init);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) throw abortError();
  const id = ++nextId;
  const cancel = () => void core().then(({ invoke }) => invoke('net_cancel', { id })).catch(() => {});
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const guard = (f: () => void) => {
    try {
      f();
    } catch {
      // flux déjà fermé
    }
  };
  // écouteur posé avant la première attente : une annulation reçue avant la tête n'est jamais perdue
  let aborted = false;
  signal?.addEventListener('abort', () => {
    aborted = true;
    cancel();
    if (controller) guard(() => controller!.error(abortError()));
  });
  const stopIfAborted = () => {
    if (!aborted && !signal?.aborted) return;
    cancel();
    throw abortError();
  };
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = await bodyBytes(init?.body, headers);
  stopIfAborted();
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const { invoke, Channel } = await core();
  stopIfAborted();

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  const channel = new Channel<ArrayBuffer | NetEnd>((m) => {
    if (m instanceof ArrayBuffer) guard(() => controller!.enqueue(new Uint8Array(m)));
    else if ('end' in m) guard(() => controller!.close());
    else guard(() => controller!.error(new TypeError(m.error)));
  });

  let head: NetHead;
  try {
    head = await invoke<NetHead>('net_fetch', body, {
      headers: { 'x-voxel-net': encodeURIComponent(JSON.stringify({ id, target, method, headers: [...headers], channel })) },
    });
  } catch (cause) {
    stopIfAborted();
    throw new TypeError('Failed to fetch', { cause });
  }
  stopIfAborted();
  const empty = [101, 103, 204, 205, 304].includes(head.status);
  return new Response(empty ? null : stream, { status: head.status, statusText: head.statusText, headers: head.headers });
}

export const platformFetch: typeof fetch = isDesktop ? desktopFetch : (i, init) => globalThis.fetch(i, init);

/** « Enregistrer sous » du système puis écriture du fichier ; `false` si l'utilisateur annule. */
export async function saveFile(name: string, blob: Blob): Promise<boolean> {
  const { invoke } = await core();
  const r = await invoke<{ saved: boolean }>('file_save', new Uint8Array(await blob.arrayBuffer()), {
    headers: { 'x-voxel-file': encodeURIComponent(JSON.stringify({ name })) },
  });
  return r.saved;
}

/** « Enregistrer sous » puis téléchargement par le cœur directement dans le fichier. */
export async function downloadToFile(name: string, url: string, headers: Record<string, string>): Promise<boolean> {
  const { target } = targetOf(url);
  const { invoke } = await core();
  const r = await invoke<{ saved: boolean }>('file_download', {
    name,
    target: target ?? { kind: 'http', url: new URL(url, location.href).href },
    headers: Object.entries(headers),
  });
  return r.saved;
}

/** Ouvre un lien hors de l'appli : navigateur du système sur le bureau, nouvel onglet sur le web. */
export function openExternal(url: string): void {
  if (!isDesktop) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  void core().then(({ invoke }) => invoke('open_external', { url }));
}

/** Clé d'appareil gardée dans le coffre du système (jamais dans IndexedDB). */
export async function desktopDeviceKey(): Promise<CryptoKey> {
  const { invoke } = await core();
  const b64 = await invoke<string>('device_key');
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Remplace `Notification` par les notifications natives du système (permission toujours accordée). */
export function installDesktopNotifications(): void {
  class DesktopNotification {
    static readonly permission: NotificationPermission = 'granted';
    static requestPermission(): Promise<NotificationPermission> {
      return Promise.resolve('granted');
    }
    /** Jamais appelé : limite de Windows acceptée. */
    onclick: ((this: DesktopNotification, ev: Event) => unknown) | null = null;
    constructor(title: string, options?: NotificationOptions) {
      void core()
        .then(({ invoke }) => invoke('notify', { title, body: options?.body ?? '' }))
        .catch(() => {});
    }
    close(): void {}
  }
  Object.defineProperty(window, 'Notification', { value: DesktopNotification, configurable: true, writable: true });
}

export async function desktopInfo(): Promise<{ version: string; selftest: boolean }> {
  const { invoke } = await core();
  return invoke('desktop_info');
}

/** Pastille des non-lus : bouton de la barre des tâches et icône de la zone de notification, avec son info-bulle. */
export async function desktopSetBadge(count: number, tooltip: string): Promise<void> {
  const { invoke } = await core();
  await invoke('set_badge', { count, tooltip });
}

/** Libellés du menu de l'icône de la zone de notification, dans la langue de l'interface. */
export async function desktopTrayLabels(open: string, quit: string): Promise<void> {
  const { invoke } = await core();
  await invoke('set_tray_labels', { open, quit });
}

/** Lancement de Voxel, en arrière-plan, à l'ouverture de la session. */
export async function desktopAutostart(): Promise<boolean> {
  const { invoke } = await core();
  return invoke<boolean>('autostart_get');
}

export async function setDesktopAutostart(enabled: boolean): Promise<void> {
  const { invoke } = await core();
  await invoke('autostart_set', { enabled });
}

export interface DesktopUpdate {
  version: string;
  currentVersion: string;
  notes?: string | null;
}

/** Version plus récente publiée sur GitHub, signée par la clé de Voxel ; `null` si l'appli est à jour. */
export async function desktopUpdateCheck(): Promise<DesktopUpdate | null> {
  const { invoke } = await core();
  return invoke<DesktopUpdate | null>('update_check');
}

/** Télécharge et installe la version trouvée, puis relance Voxel ; `onProgress` reçoit la part téléchargée (0 à 1, ou `null`). */
export async function desktopUpdateInstall(onProgress: (ratio: number | null) => void): Promise<void> {
  const [{ invoke }, { listen }] = await Promise.all([core(), import('@tauri-apps/api/event')]);
  const stop = await listen<{ downloaded: number; total: number | null }>('voxel:update-progress', (e) =>
    onProgress(e.payload.total ? Math.min(1, e.payload.downloaded / e.payload.total) : null),
  );
  try {
    await invoke('update_install');
  } finally {
    stop();
  }
}
