/** Configuration de la passerelle IMAP, lue dans l'environnement. */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repoRoot, resolveDataDir } from './paths.js';

export { repoRoot };

// Charge un éventuel fichier .env à la racine (développement).
const rootEnv = join(repoRoot, '.env');
if (existsSync(rootEnv)) {
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    /* fichier illisible : ignoré */
  }
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: resolveDataDir(),
  webDist: resolve(process.env.VOXEL_WEB_DIST ?? join(repoRoot, 'apps', 'web', 'dist')),
  /** "off" désactive l'en-tête CSP ; toute autre valeur la remplace. */
  csp: process.env.VOXEL_CSP,
  /** Faire confiance à X-Forwarded-For (derrière Traefik uniquement). */
  trustProxy: process.env.VOXEL_TRUST_PROXY === '1',
  /** Nombre de proxys de confiance qui ajoutent une entrée à X-Forwarded-For (Traefik seul : 1). */
  trustProxyHops: Math.max(1, Math.min(10, Number(process.env.VOXEL_TRUST_PROXY_HOPS) || 1)),
  /** Domaines autorisés sur la passerelle (vide = tous). */
  allowedEmailDomains: parseList(process.env.VOXEL_ALLOWED_EMAIL_DOMAINS),
  /** Autorise les IP privées et tous les ports (réseau local, tests). */
  allowPrivateHosts: process.env.VOXEL_ALLOW_PRIVATE_HOSTS === '1',
};

mkdirSync(config.dataDir, { recursive: true });
