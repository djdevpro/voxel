// Licences de toutes les dépendances Rust de Voxel Desktop (CA9) : liste triée dans target/licenses.txt et sur la
// sortie, échec si une licence manque ou n'est pas dans la liste permise. Node seul, sans dépendance.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = join(here, '..', 'Cargo.toml');
const out = join(here, '..', 'target', 'licenses.txt');

// Licences permissives acceptées (identifiants SPDX).
const allowed = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'ISC',
  'Zlib',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'CDLA-Permissive-2.0',
  'MPL-2.0',
]);

// Une expression passe si l'une de ses alternatives (OR, /) n'a que des termes AND permis.
function permitted(expression) {
  return expression
    .split(/\s+OR\s+|\//)
    .some((alternative) =>
      alternative
        .replace(/[()]/g, '')
        .split(/\s+AND\s+/)
        .every((term) => allowed.has(term.trim())),
    );
}

const metadata = JSON.parse(
  execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--manifest-path', manifest, '--filter-platform', 'x86_64-pc-windows-msvc'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  ),
);

// Seulement les paquets du graphe résolu, pas tout ce que le verrou connaît.
const resolved = new Set(metadata.resolve.nodes.map((node) => node.id));
const packages = metadata.packages
  .filter((pkg) => resolved.has(pkg.id))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const lines = [];
const refused = [];
for (const pkg of packages) {
  const license = pkg.license ?? '';
  lines.push(`${pkg.name} ${pkg.version} ${license || '(aucune)'}`);
  if (!license || !permitted(license)) refused.push(`${pkg.name} ${pkg.version} ${license || '(aucune)'}`);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
console.log(`\n${packages.length} paquets, liste dans ${out}`);
if (refused.length) {
  console.error(`\nLicences absentes ou non permises :\n${refused.join('\n')}`);
  process.exit(1);
}
