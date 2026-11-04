/**
 * Configuration d'exécution : `/config.json`, lu avant le premier rendu.
 * Sans fichier valide : aucun domaine connu, chaque adresse passe par la découverte de la passerelle.
 */

export interface AppConfig {
  /** Domaine → URL de session JMAP ; la clé `*` vaut pour tous les domaines (mode développement). */
  jmap: Record<string, string>;
  /** Domaine → portail du serveur de messagerie (« Gérer mon compte ») ; absent : pas de lien. */
  accountPortal: Record<string, string>;
}

const DEFAULT_CONFIG: AppConfig = {
  jmap: {},
  accountPortal: {},
};

let config: AppConfig = DEFAULT_CONFIG;

/** `https://` seulement ; `http://` accepté pour `localhost` et les chemins relatifs (développement). */
export function isAllowedSessionUrl(url: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

function parse(raw: unknown): AppConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG;
  const o = raw as Record<string, unknown>;
  if (!o.jmap || typeof o.jmap !== 'object') return DEFAULT_CONFIG;
  const jmap: Record<string, string> = {};
  for (const [d, url] of Object.entries(o.jmap as Record<string, unknown>)) {
    if (typeof url === 'string' && isAllowedSessionUrl(url)) jmap[d.toLowerCase()] = url;
  }
  // portail de compte : `https://` seulement (lien ouvert dans un nouvel onglet)
  const accountPortal: Record<string, string> = {};
  if (o.accountPortal && typeof o.accountPortal === 'object') {
    for (const [d, url] of Object.entries(o.accountPortal as Record<string, unknown>)) {
      if (typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url)) accountPortal[d.toLowerCase()] = url;
    }
  }
  return { jmap, accountPortal };
}

/** Charge `/config.json` (sans cache HTTP) ; ne lève jamais. */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch('/config.json', { cache: 'no-cache' });
    if (res.ok) config = parse(await res.json());
  } catch {
    /* hors ligne ou fichier absent : valeurs par défaut (ou celles du cache du service worker) */
  }
  return config;
}

export function getConfig(): AppConfig {
  return config;
}

/** URL de session JMAP configurée pour une adresse (domaine, sinon `*`) ; `undefined` → découverte par la passerelle. */
export function sessionUrlFor(email: string): string | undefined {
  const domain = email.split('@')[1]?.trim().toLowerCase() ?? '';
  return config.jmap[domain] ?? config.jmap['*'];
}

/** Hôte affiché d'une URL de session (« mail.example.com »), y compris pour un chemin relatif. */
export function sessionHost(url: string): string {
  try {
    return new URL(url, window.location.href).host;
  } catch {
    return url;
  }
}

/** Portail de gestion du compte (mot de passe, double authentification) pour une adresse, s'il est configuré. */
export function accountPortalFor(email: string): string | undefined {
  const domain = email.split('@')[1]?.trim().toLowerCase() ?? '';
  return config.accountPortal[domain] ?? config.accountPortal['*'];
}
