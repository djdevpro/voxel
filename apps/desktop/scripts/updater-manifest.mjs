// Manifeste des mises à jour de Voxel Desktop (`latest.json`), écrit par le workflow de release après la signature
// des installeurs (`tauri signer sign`). Chaque signature est d'abord vérifiée avec la clé publique de
// `src-tauri/tauri.conf.json` : une release signée par une autre clé serait refusée par toutes les applis installées,
// alors le script échoue avant la publication.
//
//   node apps/desktop/scripts/updater-manifest.mjs <dossier des fichiers> <version> <URL de base des téléchargements>
//
// Le greffon updater cherche `<os>-<arch>-<installeur>` puis `<os>-<arch>` : Windows prend l'installeur NSIS, Linux
// l'AppImage, le .deb ou le .rpm selon le paquet installé (AppImage par défaut).
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, version, base] = process.argv.slice(2);
if (!dir || !version || !base) {
  console.error('usage: updater-manifest.mjs <assets dir> <version> <download base URL>');
  process.exit(2);
}

const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const pubkey = config.plugins?.updater?.pubkey;
if (!pubkey) throw new Error('tauri.conf.json has no plugins.updater.pubkey');

/** Fichiers de la release qu'une appli installée sait installer, et leurs clés dans le manifeste. */
const FILES = [
  { name: `voxel-${version}-windows-x64-setup.exe`, targets: ['windows-x86_64-nsis', 'windows-x86_64'] },
  { name: `voxel-${version}-linux-x86_64.AppImage`, targets: ['linux-x86_64-appimage', 'linux-x86_64'] },
  { name: `voxel-${version}-linux-amd64.deb`, targets: ['linux-x86_64-deb'] },
  { name: `voxel-${version}-linux-x86_64.rpm`, targets: ['linux-x86_64-rpm'] },
];

/** Deuxième ligne d'un fichier minisign encodé en base64 (clé ou signature), décodée. */
function minisignLines(b64) {
  return Buffer.from(b64.trim(), 'base64').toString('utf8').split('\n');
}

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const keyBytes = Buffer.from(minisignLines(pubkey)[1], 'base64');
if (keyBytes.length !== 42 || keyBytes.subarray(0, 2).toString() !== 'Ed') throw new Error('unexpected minisign public key');
const keyId = keyBytes.subarray(2, 10);
const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI, keyBytes.subarray(10)]), format: 'der', type: 'spki' });

/** Vérifie une signature minisign (`Ed` : le fichier, `ED` : son empreinte BLAKE2b-512) et son commentaire de confiance. */
function check(file, signatureB64) {
  const lines = minisignLines(signatureB64);
  const sig = Buffer.from(lines[1] ?? '', 'base64');
  const trusted = (lines[2] ?? '').replace(/^trusted comment: /, '');
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (sig.length !== 74) throw new Error(`${basename(file)}: malformed signature`);
  if (!sig.subarray(2, 10).equals(keyId)) throw new Error(`${basename(file)}: signed by another key than the one in tauri.conf.json`);
  const algorithm = sig.subarray(0, 2).toString();
  const data = readFileSync(file);
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, publicKey, sig.subarray(10))) throw new Error(`${basename(file)}: invalid signature`);
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), publicKey, global)) {
    throw new Error(`${basename(file)}: invalid trusted comment signature`);
  }
}

const platforms = {};
for (const { name, targets } of FILES) {
  const file = join(dir, name);
  const signature = readFileSync(`${file}.sig`, 'utf8').trim();
  check(file, signature);
  for (const target of targets) platforms[target] = { signature, url: `${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}` };
  console.log(`signed and verified: ${name}`);
}

const manifest = {
  version,
  notes: `Voxel Desktop ${version}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
};
writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json: ${Object.keys(platforms).join(', ')}`);
