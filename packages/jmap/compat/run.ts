/**
 * Banc de compatibilité JMAP (`npm run compat:jmap`) : démarre les serveurs en Docker, les provisionne, joue le même
 * scénario sur chacun et sur la boîte de test, affiche un tableau, puis supprime ses conteneurs.
 *
 * Règles de sécurité du banc :
 * - il ne crée, ne lit, n'arrête ou ne supprime que des conteneurs du projet compose `voxel-compat`
 *   (et le conteneur jetable `voxel-compat-keytool`) ;
 * - il ne publie que des ports de 127.0.0.1 entre 18400 et 18799 ;
 * - il ne lance jamais `docker system prune`, `docker volume prune` ni de commande globale ;
 * - il n'affiche jamais les identifiants de `.env.test.local`.
 *
 * Options : `--keep` (laisser les serveurs démarrés et afficher URL de session et identifiants de test du banc),
 * `--only <nom>` (un seul serveur, ou `test-box`).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVERS, type CompatServer } from './servers.ts';
import { SKIPPED, runScenario, type StepResult } from './scenario.ts';

/** Nom du projet compose : la seule portée des commandes Docker du banc. */
const PROJECT = 'voxel-compat';
/** Image de James, aussi utilisée pour générer son magasin de clés. */
const JAMES_IMAGE = 'apache/james:memory-3.9.1@sha256:093b35e8e11ab63b379799d42cf4a1b095ba43f49da28de5c729c9e848b52e8e';
/** Attente maximale de chaque URL « prêt ». */
const READY_TIMEOUT_MS = 120_000;
/** Colonnes du tableau, dans l'ordre du scénario. */
const STEPS = ['session', 'wrong-password', 'capabilities', 'mailboxes', 'upload', 'send', 'push', 'receive', 'read', 'download', 'limits', 'contacts', 'calendar', 'sieve', 'vacation', 'cleanup'];

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const composeFile = fileURLToPath(new URL('./compose.yaml', import.meta.url));

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;
if (onlyIdx >= 0 && !only) throw new Error('--only attend un nom de serveur ou « test-box »');
if (only && only !== 'test-box' && !SERVERS.some((s) => s.name === only)) throw new Error(`serveur inconnu : ${only}`);

function docker(args: string[], env?: NodeJS.ProcessEnv, quiet = false): void {
  const r = spawnSync('docker', args, { stdio: quiet ? 'pipe' : 'inherit', env: { ...process.env, ...env }, cwd: repoRoot });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 4).join(' ')} … : code ${r.status}${quiet ? ` ${String(r.stderr).slice(0, 300)}` : ''}`);
}

async function waitReady(s: CompatServer): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < READY_TIMEOUT_MS) {
    try {
      const r = await fetch(s.ready, { signal: AbortSignal.timeout(5000) });
      await r.arrayBuffer();
      if (r.status === 200) return;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${s.name} pas prêt après ${READY_TIMEOUT_MS / 1000} s`);
}

/** Lit `.env.test.local` ligne à ligne, sans jamais en afficher le contenu. */
function testBox(): { sessionUrl: string; login: string; password: string } | undefined {
  const file = join(repoRoot, '.env.test.local');
  if (!existsSync(file)) return undefined;
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  const { VOXEL_TEST_JMAP_URL: sessionUrl, VOXEL_TEST_USER: login, VOXEL_TEST_PASSWORD: password } = env;
  return sessionUrl && login && password ? { sessionUrl, login, password } : undefined;
}

/** URL de session d'un serveur, trouvée comme le ferait un client (redirection suivie). */
async function sessionUrlOf(s: CompatServer): Promise<string> {
  const u = s.users[0]!;
  const r = await fetch(s.wellKnown, { headers: { Authorization: 'Basic ' + Buffer.from(`${u.login}:${u.password}`).toString('base64') } });
  await r.arrayBuffer();
  return r.url;
}

/** Identifiant et mot de passe de la boîte de test, masqués dans tout texte affiché (C15). */
const testSecrets: { login?: string; password?: string } = {};

/** Remplace l'identifiant (casse ignorée) et le mot de passe, bruts ou échappés en JSON, par `<test-user>` et `<secret>`. */
export function maskSecrets(text: string, secrets: { login?: string; password?: string }): string {
  let out = text;
  const swap = (value: string | undefined, by: string, flags: string) => {
    if (!value) return;
    for (const v of new Set([value, JSON.stringify(value).slice(1, -1)])) out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags), by);
  };
  swap(secrets.password, '<secret>', 'g');
  swap(secrets.login, '<test-user>', 'gi');
  return out;
}

// Test du masque, joué à chaque lancement avant tout affichage.
{
  const s = { login: 'Box.User@example.org', password: 'p"a$s.1' };
  assert.equal(
    maskSecrets('expéditeur [{"email":"box.user@example.org"}] notCreated {"description":"p\\"a$s.1 BOX.USER@EXAMPLE.ORG"} p"a$s.1', s),
    'expéditeur [{"email":"<test-user>"}] notCreated {"description":"<secret> <test-user>"} <secret>',
  );
  assert.equal(maskSecrets('boxXuser@example.org pXa$s.1', s), 'boxXuser@example.org pXa$s.1');
  assert.equal(maskSecrets('rien', {}), 'rien');
}
const mask = (text: string) => maskSecrets(text, testSecrets);

const servers = only === 'test-box' ? [] : SERVERS.filter((s) => !only || s.name === only);
const rows: Array<{ label: string; results: StepResult[]; limits: string; cors: string }> = [];
let started = false;
let failure: unknown;

try {
  if (servers.length) {
    docker(['version', '--format', '{{.Server.Version}}'], undefined, true);
    const tmp = realpathSync.native(tmpdir());
    const state = join(tmp, 'voxel-compat');
    mkdirSync(state, { recursive: true });
    if (!existsSync(join(state, 'keystore'))) {
      docker(['run', '--rm', '--name', 'voxel-compat-keytool', '-v', `${state}:/out`, '--entrypoint', 'keytool', JAMES_IMAGE,
        '-genkeypair', '-alias', 'james', '-keyalg', 'RSA', '-keysize', '2048', '-storetype', 'PKCS12', '-keystore', '/out/keystore',
        '-storepass', 'james72laBalle', '-keypass', 'james72laBalle', '-dname', 'CN=localhost', '-validity', '3650']);
    }
    started = true;
    docker(['compose', '-p', PROJECT, '-f', composeFile, 'up', '-d', ...servers.map((s) => s.name)], { VOXEL_COMPAT_STATE: state });
    await Promise.all(servers.map(waitReady));
    for (const s of servers) {
      console.log(`provisionnement : ${s.name}`);
      await s.provision();
    }
  }

  for (const s of servers) {
    const u = s.users[0]!;
    console.log(`scénario : ${s.name}`);
    const results = await runScenario({ label: s.name, wellKnown: s.wellKnown, login: u.login, password: u.password, push: s.push, absent: s.absent, checkWrongPassword: s.name !== 'cyrus' });
    rows.push({ label: s.name, results, ...(await describe(s.wellKnown, u.login, u.password, results)) });
  }

  if (!only || only === 'test-box') {
    const box = testBox();
    if (!box) console.log('test box skipped');
    else {
      Object.assign(testSecrets, { login: box.login, password: box.password });
      console.log('scénario : test-box');
      const results = await runScenario({ label: 'test-box', sessionUrl: box.sessionUrl, login: box.login, password: box.password, push: true, absent: [], checkWrongPassword: true });
      rows.push({ label: 'test-box', results: results.map((r) => ({ ...r, detail: mask(r.detail) })), ...(await describe(box.sessionUrl, box.login, box.password, results)) });
    }
  }
} catch (e) {
  failure = e;
}

/** Limites annoncées par la session et valeur CORS relevée à l'étape `session`. */
async function describe(url: string, login: string, password: string, results: StepResult[]): Promise<{ limits: string; cors: string }> {
  const cors = /^cors: (.*)$/.exec(results.find((r) => r.name === 'session')?.detail ?? '')?.[1] ?? '?';
  try {
    const r = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64') } });
    const core = ((await r.json()) as { capabilities: Record<string, Record<string, number>> }).capabilities['urn:ietf:params:jmap:core']!;
    return { cors, limits: `req ${core.maxConcurrentRequests} · calls ${core.maxCallsInRequest} · get ${core.maxObjectsInGet} · set ${core.maxObjectsInSet} · size ${core.maxSizeRequest} · up ${core.maxConcurrentUpload}/${core.maxSizeUpload}` };
  } catch {
    return { cors, limits: '?' };
  }
}

// Tableau : une ligne par cible, une colonne par étape.
const cell = (r: StepResult | undefined) => (!r ? SKIPPED : r.detail === SKIPPED ? SKIPPED : r.ok ? 'ok' : 'FAIL');
const header = ['cible', ...STEPS, 'résultat', 'cors', 'limites'];
const table = rows.map((row) => {
  const pass = row.results.every((r) => r.ok);
  return [row.label, ...STEPS.map((n) => cell(row.results.find((r) => r.name === n))), pass ? 'PASS' : 'FAIL', row.cors, row.limits];
});
const widths = header.map((h, i) => Math.max(h.length, ...table.map((t) => t[i]!.length)));
const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join(' | ');
console.log('');
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join('-|-'));
for (const t of table) console.log(line(t));
for (const row of rows) {
  for (const r of row.results.filter((x) => !x.ok)) console.log(`${row.label} / ${r.name} : ${mask(r.detail)}`);
}
if (failure) console.error(`banc interrompu : ${mask(failure instanceof Error ? failure.message : String(failure))}`);

if (started) {
  if (keep) {
    console.log('');
    console.log('Serveurs gardés (identifiants de test locaux du banc) :');
    for (const s of servers) {
      const url = await sessionUrlOf(s).catch(() => s.wellKnown);
      for (const u of s.users) console.log(`${s.name} : session ${url} · ${u.login} / ${u.password}`);
    }
  } else {
    docker(['compose', '-p', PROJECT, '-f', composeFile, 'down', '-v'], { VOXEL_COMPAT_STATE: join(realpathSync.native(tmpdir()), 'voxel-compat') });
  }
}

const allPass = !failure && rows.length > 0 && rows.every((row) => row.results.every((r) => r.ok));
process.exit(allPass ? 0 : 1);
