/**
 * Pièces jointes volumineuses : réglages lus dans l'environnement. Sans `VOXEL_S3_BUCKET`, la fonction est absente
 * et `/files/config` répond `{ enabled: false }`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config, repoRoot } from '../config.js';
import { detectProvider } from '../vendor/ud-s3/providers.js';
import type { Addressing } from '../vendor/ud-s3/types.js';

export interface FilesSettings {
  endpoint: string;
  region: string;
  bucket: string;
  addressing: Addressing;
  accessKeyId: string;
  secretAccessKey: string;
  /** Préfixe des objets dans le bucket (`voxel/`), suivi du compte de chaque expéditeur. */
  prefix: string;
  /** Espace de chaque compte, en octets (1 Go = 1024³, comme les tailles affichées par l’appli). */
  quota: number;
  /** Taille au-delà de laquelle une pièce jointe part par lien (1 Mo = 1024²). */
  threshold: number;
  /** Validité d'un lien, en jours ; le fichier est supprimé ensuite. */
  linkDays: number;
  /**
   * Point de terminaison sur une adresse privée, http compris (MinIO du réseau Docker, S3 local de développement) :
   * `VOXEL_S3_ALLOW_PRIVATE=1`, sans relâcher les règles réseau de la passerelle IMAP. Le navigateur ne joint pas
   * une telle adresse : les octets passent alors par le relais du serveur.
   */
  allowPrivate: boolean;
  /** `config.json` de l'appli : domaines → serveur JMAP qui vérifie l'expéditeur. */
  configFile: string;
  /** Base des URL de session relatives de `config.json` (développement). */
  publicUrl?: string;
}

/** Entier positif, sinon la valeur par défaut. */
function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function readFilesSettings(env: NodeJS.ProcessEnv = process.env): FilesSettings | null {
  const bucket = env.VOXEL_S3_BUCKET?.trim();
  if (!bucket) return null;
  const endpoint = env.VOXEL_S3_ENDPOINT?.trim().replace(/\/+$/, '');
  const accessKeyId = env.VOXEL_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.VOXEL_S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    console.warn('[voxel] pièces jointes volumineuses désactivées : VOXEL_S3_ENDPOINT, VOXEL_S3_ACCESS_KEY_ID et VOXEL_S3_SECRET_ACCESS_KEY sont requis');
    return null;
  }
  const preset = detectProvider(endpoint);
  const addressing = env.VOXEL_S3_ADDRESSING === 'path' || env.VOXEL_S3_ADDRESSING === 'virtual' ? env.VOXEL_S3_ADDRESSING : preset.defaultAddressing;
  const rawPrefix = (env.VOXEL_S3_PREFIX ?? 'voxel/').trim().replace(/^\/+/, '');
  const prefix = rawPrefix && !rawPrefix.endsWith('/') ? `${rawPrefix}/` : rawPrefix;
  const webConfig = join(config.webDist, 'config.json');
  const devConfig = join(repoRoot, 'apps', 'web', 'public', 'config.json');
  const publicUrl = env.VOXEL_PUBLIC_URL?.trim().replace(/\/+$/, '');
  return {
    endpoint,
    region: env.VOXEL_S3_REGION?.trim() || preset.defaultRegion || 'us-east-1',
    bucket,
    addressing,
    accessKeyId,
    secretAccessKey,
    prefix,
    quota: positive(env.VOXEL_S3_QUOTA_BYTES, 1024 ** 3),
    threshold: positive(env.VOXEL_S3_THRESHOLD_BYTES, 1024 ** 2),
    linkDays: Math.min(positive(env.VOXEL_S3_LINK_DAYS, 30), 3650),
    allowPrivate: env.VOXEL_S3_ALLOW_PRIVATE === '1' || config.allowPrivateHosts,
    configFile: env.VOXEL_CONFIG_FILE?.trim() || (existsSync(webConfig) ? webConfig : devConfig),
    ...(publicUrl ? { publicUrl } : {}),
  };
}

// ---------------------------------------------------------------- serveurs JMAP de confiance

let cached: { file: string; mtime: number; map: Record<string, string> } | undefined;

/**
 * Serveurs JMAP de `config.json` (domaine → URL de session), relus quand le fichier change. Les URL relatives ne
 * servent qu'avec `VOXEL_PUBLIC_URL` (développement) ; `http:` seulement avec `VOXEL_ALLOW_PRIVATE_HOSTS`.
 */
export function trustedSessionUrls(s: FilesSettings): Record<string, string> {
  let mtime = 0;
  try {
    mtime = statSync(s.configFile).mtimeMs;
  } catch {
    return {};
  }
  if (cached && cached.file === s.configFile && cached.mtime === mtime) return cached.map;
  const map: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(s.configFile, 'utf8')) as { jmap?: unknown };
    if (raw.jmap && typeof raw.jmap === 'object') {
      for (const [domain, value] of Object.entries(raw.jmap as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        let url: URL;
        try {
          url = value.startsWith('/') && !value.startsWith('//') && s.publicUrl ? new URL(value, s.publicUrl) : new URL(value);
        } catch {
          continue;
        }
        if (url.protocol === 'https:' || (url.protocol === 'http:' && config.allowPrivateHosts)) map[domain.trim().toLowerCase()] = url.href;
      }
    }
  } catch {
    console.warn(`[voxel] pièces jointes volumineuses : ${s.configFile} illisible`);
  }
  cached = { file: s.configFile, mtime, map };
  return map;
}

/** URL de session JMAP de confiance pour une adresse (son domaine, sinon `*`). */
export function trustedSessionUrl(s: FilesSettings, email: string): string | undefined {
  const map = trustedSessionUrls(s);
  const domain = email.split('@')[1]?.trim().toLowerCase() ?? '';
  return map[domain] ?? map['*'];
}
