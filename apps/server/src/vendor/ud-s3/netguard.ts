import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { S3Error } from './errors.js';

/**
 * Garde réseau anti-SSRF (Annexe B de 01).
 * Validation du point de terminaison à la création, puis contrôle de chaque adresse
 * résolue par la fonction `lookup` épinglée de l'agent HTTP.
 */

export type AddressVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'private_address' | 'metadata_address'; liftable: boolean };

/** Motifs de refus de netguard (01 Annexe C, `endpoint_not_allowed`). */
export type NetguardReason = 'instance' | 'insecure_scheme' | 'private_address' | 'metadata_address' | 'port';

export interface NetguardOptions {
  /** `UD_ALLOW_PRIVATE_ENDPOINTS` : lève le refus des plages privées, de bouclage, CGNAT et ULA. */
  allowPrivate?: boolean;
  /** `UD_ALLOWED_ENDPOINTS` : liste blanche `[http://|https://]hôte[:port]`, hôte éventuellement `*.suffixe`. */
  allowedEndpoints?: readonly string[];
}

export interface GuardedEndpoint {
  url: URL;
  protocol: 'http:' | 'https:';
  /** Hôte normalisé, sans crochets pour IPv6. */
  host: string;
  port: number;
  /** Adresses privées autorisées pour cet hôte (drapeau global ou entrée explicite). */
  privateAllowed: boolean;
  /** Origine normalisée `scheme://hôte[:port]`. */
  origin: string;
  /** `http:` autorisé par une entrée explicite de la liste blanche (confiance de l'administrateur). */
  explicitHttp: boolean;
}

/** Ports refusés (liste « bad ports » du standard Fetch, 01 Annexe B). */
export const BAD_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
  110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);

// --- IPv4 ---------------------------------------------------------------------------------------

function ipv4ToInt(address: string): number {
  const parts = address.split('.').map(Number);
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function inV4(value: number, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === (ipv4ToInt(base!) & mask) >>> 0;
}

const V4_METADATA = ['100.100.100.200/32', '168.63.129.16/32'];
const V4_NEVER = [
  '0.0.0.0/8',
  '169.254.0.0/16',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const V4_LIFTABLE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8'];

export function classifyIPv4(address: string): AddressVerdict {
  const value = ipv4ToInt(address);
  if (V4_METADATA.some((cidr) => inV4(value, cidr))) return { allowed: false, reason: 'metadata_address', liftable: false };
  // Le lien local porte IMDS et les identifiants des tâches : jamais autorisé.
  if (inV4(value, '169.254.0.0/16')) return { allowed: false, reason: 'metadata_address', liftable: false };
  if (V4_NEVER.some((cidr) => inV4(value, cidr))) return { allowed: false, reason: 'private_address', liftable: false };
  if (V4_LIFTABLE.some((cidr) => inV4(value, cidr))) return { allowed: false, reason: 'private_address', liftable: true };
  return { allowed: true };
}

// --- IPv6 ---------------------------------------------------------------------------------------

/** Développe une IPv6 en 8 groupes de 16 bits ; `null` si invalide. */
export function expandIPv6(address: string): number[] | null {
  let text = address;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (text.includes('%')) return null;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const lastPart = text.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    if (isIP(lastPart) !== 4) return null;
    const v = ipv4ToInt(lastPart);
    tail = [v >>> 16, v & 0xffff];
    text = `${text.slice(0, lastColon + 1)}${tail.length ? '0:0' : ''}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((group) => parseInt(group, 16)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const groups = halves.length === 2 ? [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest] : head;
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

function groupsToV4(high: number, low: number): string {
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function v6Matches(groups: number[], prefix: number[], bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i += 1) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((groups[i]! & mask) !== ((prefix[i] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

function v6(cidr: string): { prefix: number[]; bits: number } {
  const [base, bits] = cidr.split('/');
  return { prefix: expandIPv6(base!)!, bits: Number(bits) };
}

const V6_METADATA = ['fd00:ec2::254/128', 'fd00:ec2::23/128', 'fd20:ce::254/128', 'fd00:a9fe:a9fe::1/128'].map(v6);
const V6_NEVER = [
  '::/128',
  'fe80::/10',
  '2001:db8::/32',
  '3fff::/20',
  '2001::/23',
  '100::/64',
  'fec0::/10',
  'ff00::/8',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '5f00::/16',
].map(v6);
const V6_LIFTABLE = ['::1/128', 'fc00::/7'].map(v6);
const V6_GLOBAL = v6('2000::/3');

export function classifyIPv6(address: string): AddressVerdict {
  const groups = expandIPv6(address);
  if (!groups) return { allowed: false, reason: 'private_address', liftable: false };
  const all = (start: number, end: number, value: number): boolean => groups.slice(start, end).every((g) => g === value);
  // IPv4 incluse : mappée (::ffff:0:0/96), traduite (::ffff:0:0:0/96), compatible (::/96), 6to4 (2002::/16).
  if (all(0, 5, 0) && groups[5] === 0xffff) return classifyIPv4(groupsToV4(groups[6]!, groups[7]!));
  if (all(0, 4, 0) && groups[4] === 0xffff && groups[5] === 0) return classifyIPv4(groupsToV4(groups[6]!, groups[7]!));
  if (V6_METADATA.some(({ prefix, bits }) => v6Matches(groups, prefix, bits))) {
    return { allowed: false, reason: 'metadata_address', liftable: false };
  }
  if (v6Matches(groups, expandIPv6('fe80::')!, 10)) return { allowed: false, reason: 'metadata_address', liftable: false };
  if (V6_NEVER.some(({ prefix, bits }) => v6Matches(groups, prefix, bits))) {
    return { allowed: false, reason: 'private_address', liftable: false };
  }
  if (V6_LIFTABLE.some(({ prefix, bits }) => v6Matches(groups, prefix, bits))) {
    return { allowed: false, reason: 'private_address', liftable: true };
  }
  if (all(0, 6, 0)) return classifyIPv4(groupsToV4(groups[6]!, groups[7]!));
  if (groups[0] === 0x2002) return classifyIPv4(groupsToV4(groups[1]!, groups[2]!));
  if (!v6Matches(groups, V6_GLOBAL.prefix, V6_GLOBAL.bits)) return { allowed: false, reason: 'private_address', liftable: false };
  return { allowed: true };
}

/** Classe une adresse IP littérale (v4 ou v6). */
export function classifyAddress(address: string): AddressVerdict {
  const bare = address.startsWith('[') ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 4) return classifyIPv4(bare);
  if (family === 6) return classifyIPv6(bare);
  return { allowed: false, reason: 'private_address', liftable: false };
}

/** Verdict appliqué : une adresse « levable » passe si les adresses privées sont permises. */
export function isAddressAllowed(address: string, privateAllowed: boolean): AddressVerdict {
  const verdict = classifyAddress(address);
  if (verdict.allowed) return verdict;
  if (verdict.liftable && privateAllowed) return { allowed: true };
  return verdict;
}

/** Vrai pour une adresse privée ou de bouclage « levable » (sert au contrôle du `http:`). */
export function isPrivateAddress(address: string): boolean {
  const verdict = classifyAddress(address);
  return !verdict.allowed && verdict.liftable;
}

// --- Noms d'hôtes ---------------------------------------------------------------------------------

/** Nom local (01 Annexe B, ligne « Noms d'hôtes ») ; `metadata` pour les noms jamais permis. */
export function classifyHostname(host: string): 'public' | 'local' | 'metadata' {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTNAMES.has(name)) return 'metadata';
  if (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    name.endsWith('.internal') ||
    name.endsWith('.home.arpa') ||
    !name.includes('.')
  ) {
    return 'local';
  }
  return 'public';
}

// --- Liste blanche ------------------------------------------------------------------------------

interface AllowedEntry {
  scheme: 'http:' | 'https:' | null;
  host: string;
  wildcard: boolean;
  port: number | null;
}

function parseAllowedEntry(entry: string): AllowedEntry | null {
  const text = entry.trim().toLowerCase();
  if (!text) return null;
  const match = /^(?:(https?):\/\/)?(\*\.)?([^/:\s]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?\/?$/.exec(text);
  if (!match) return null;
  return {
    scheme: match[1] ? (`${match[1]}:` as 'http:' | 'https:') : null,
    wildcard: Boolean(match[2]),
    host: match[3]!.replace(/^\[|\]$/g, '').replace(/\.$/, ''),
    port: match[4] ? Number(match[4]) : null,
  };
}

/** Lit `UD_ALLOWED_ENDPOINTS` (liste séparée par des virgules). */
export function parseAllowedEndpoints(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchEntry(entry: AllowedEntry, protocol: string, host: string, port: number): boolean {
  if (entry.wildcard) {
    if (!host.endsWith(`.${entry.host}`)) return false;
  } else if (host !== entry.host) {
    return false;
  }
  if (entry.port !== null && entry.port !== port) return false;
  if (entry.scheme !== null && entry.scheme !== protocol) return false;
  return true;
}

// --- Point de terminaison ---------------------------------------------------------------------------

function refuse(reason: NetguardReason, message: string): S3Error {
  return new S3Error({ code: 'endpoint_not_allowed', reason, message });
}

function invalid(reason: string, message: string): S3Error {
  return new S3Error({ code: 'validation', reason, message, details: { field: 'endpoint' } });
}

/**
 * Valide un point de terminaison avant toute connexion.
 * Lève `S3Error` (`validation` pour une forme invalide, `endpoint_not_allowed` sinon).
 */
export function validateEndpoint(endpoint: string, options: NetguardOptions = {}): GuardedEndpoint {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid('endpoint_invalid', 'Endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw refuse('insecure_scheme', 'Endpoint scheme must be https');
  if (url.username || url.password) throw invalid('endpoint_credentials', 'Endpoint must not contain credentials');
  if (url.search || url.hash) throw invalid('endpoint_query', 'Endpoint must not contain a query or fragment');
  if (url.pathname !== '/' && url.pathname !== '') throw invalid('endpoint_path', 'Endpoint must not contain a path');
  if (endpoint.length > 2048) throw invalid('endpoint_invalid', 'Endpoint is too long');

  const protocol = url.protocol as 'http:' | 'https:';
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const port = url.port ? Number(url.port) : protocol === 'https:' ? 443 : 80;
  if (!host) throw invalid('endpoint_invalid', 'Endpoint host is empty');
  if (host.includes('%')) throw refuse('private_address', 'IPv6 zone identifiers are not allowed');
  if (BAD_PORTS.has(port)) throw refuse('port', `Port ${port} is not allowed`);

  // Liste blanche de l'instance.
  const entries = (options.allowedEndpoints ?? []).map(parseAllowedEntry).filter((e): e is AllowedEntry => e !== null);
  let explicit: AllowedEntry | undefined;
  if (entries.length > 0) {
    explicit = entries.find((entry) => matchEntry(entry, protocol, host, port));
    if (!explicit) {
      // Distinction utile : l'hôte est listé mais pas pour ce schéma.
      const hostOnly = entries.find((entry) => matchEntry({ ...entry, scheme: null }, protocol, host, port));
      if (hostOnly && protocol === 'http:') throw refuse('insecure_scheme', 'Plain http is not allowed for this endpoint');
      throw refuse('instance', 'Endpoint is not in the allowed list');
    }
  }
  const privateAllowed = Boolean(options.allowPrivate) || explicit !== undefined;

  // Hôte : IP littérale ou nom.
  const family = isIP(host);
  if (family) {
    const verdict = isAddressAllowed(host, privateAllowed);
    if (!verdict.allowed) throw refuse(verdict.reason, 'Endpoint address is not allowed');
  } else {
    const kind = classifyHostname(host);
    if (kind === 'metadata') throw refuse('metadata_address', 'Endpoint host is a metadata service');
    if (kind === 'local' && !privateAllowed) throw refuse('private_address', 'Endpoint host is a local name');
  }

  // `http:` : seulement avec le drapeau vers un hôte privé, ou une entrée explicite en http.
  const explicitHttp = protocol === 'http:' && explicit?.scheme === 'http:';
  if (protocol === 'http:') {
    if (!explicitHttp) {
      if (!options.allowPrivate) throw refuse('insecure_scheme', 'Plain http requires private endpoints to be allowed');
      // Un nom est contrôlé à la résolution : adresses privées exigées (`requirePrivate`).
      if (family && !isPrivateAddress(host)) throw refuse('insecure_scheme', 'Plain http is only allowed for private hosts');
    }
  }

  const defaultPort = protocol === 'https:' ? 443 : 80;
  const hostForUrl = family === 6 ? `[${host}]` : host;
  const origin = `${protocol}//${hostForUrl}${port === defaultPort ? '' : `:${port}`}`;
  return { url, protocol, host, port, privateAllowed, origin, explicitHttp };
}

// --- Résolution épinglée ------------------------------------------------------------------------

export type LookupFunction = (
  hostname: string,
  options: { family?: number | string; all?: boolean; hints?: number } | number,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

export interface PinnedLookupOptions {
  /** Point de terminaison validé ; seuls cet hôte et ses sous-domaines (`<bucket>.<hôte>`) sont résolus. */
  endpoint: GuardedEndpoint;
  /** Exige des adresses privées (transport `http:` sans entrée explicite). */
  requirePrivate?: boolean;
  /** Résolveur sous-jacent (injectable pour les tests). */
  resolve?: (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
}

function netguardError(reason: NetguardReason, message: string): NodeJS.ErrnoException {
  const error = refuse(reason, message) as S3Error & NodeJS.ErrnoException;
  return error;
}

/** Contrôle une adresse pour une connexion vers le point de terminaison donné. */
export function checkConnectAddress(address: string, options: Omit<PinnedLookupOptions, 'resolve'>): S3Error | null {
  const verdict = isAddressAllowed(address, options.endpoint.privateAllowed);
  if (!verdict.allowed) return refuse(verdict.reason, 'Resolved address is not allowed');
  if (options.requirePrivate && !isPrivateAddress(address)) {
    return refuse('insecure_scheme', 'Plain http is only allowed for private hosts');
  }
  return null;
}

/**
 * Fonction `lookup` épinglée : résout, contrôle **toutes** les adresses
 * et ne renvoie que des adresses validées, à chaque nouvelle connexion TCP.
 */
export function createPinnedLookup(options: PinnedLookupOptions): LookupFunction {
  const resolve =
    options.resolve ??
    ((hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) =>
      dnsLookup(hostname, { all: true, verbatim: true }, callback));
  const base = options.endpoint.host;
  return (hostname, lookupOptions, callback) => {
    const name = hostname.toLowerCase().replace(/\.$/, '');
    if (name !== base && !name.endsWith(`.${base}`)) {
      callback(netguardError('instance', 'Host does not belong to the endpoint'), '', 4);
      return;
    }
    const wantAll = typeof lookupOptions === 'object' && lookupOptions.all === true;
    const family = typeof lookupOptions === 'number' ? lookupOptions : Number(lookupOptions.family ?? 0) || 0;
    resolve(name, (error, addresses) => {
      if (error) {
        callback(error, wantAll ? [] : '', 4);
        return;
      }
      if (!addresses || addresses.length === 0) {
        const empty = Object.assign(new Error('DNS resolution returned no address'), { code: 'ENOTFOUND' });
        callback(empty, wantAll ? [] : '', 4);
        return;
      }
      for (const entry of addresses) {
        const refusal = checkConnectAddress(entry.address, options);
        if (refusal) {
          callback(refusal as S3Error & NodeJS.ErrnoException, wantAll ? [] : '', 4);
          return;
        }
      }
      const usable = family ? addresses.filter((entry) => entry.family === family) : addresses;
      if (usable.length === 0) {
        const none = Object.assign(new Error('No address of the requested family'), { code: 'ENOTFOUND' });
        callback(none, wantAll ? [] : '', 4);
        return;
      }
      if (wantAll) callback(null, usable);
      else callback(null, usable[0]!.address, usable[0]!.family);
    });
  };
}
