/**
 * Script Sieve géré par le webmail : liste de blocage,
 * répondeur et filtres dans un seul script, car Stalwart n'accepte qu'un script actif par compte.
 *
 * Source de vérité : les lignes marqueurs en tête du script (JSON compact sur une ligne) :
 *   # voxel-blocklist v1 {...}   # voxel-vacation v1 {...}   # voxel-filters v1 {...}
 * Un script qui n'a que la ligne `voxel-blocklist` se relit tel quel : pas de répondeur, aucun filtre.
 * Le préfixe avant le tiret n'est pas comparé à la lecture : un script écrit par une version précédente se relit.
 *
 * Module pur et déterministe : aucune dépendance au navigateur, à React ni à i18n.
 */

export const MANAGED_SCRIPT_NAME = 'voxel';
/** Nom historique. */
export const BLOCKLIST_SCRIPT_NAME = MANAGED_SCRIPT_NAME;
/** Nom réservé par Stalwart au script du répondeur JMAP (`VacationResponse`). */
export const VACATION_SCRIPT_NAME = 'vacation';
export const BLOCKLIST_MAX_ENTRIES = 1000;
export const FILTERS_MAX = 200;

const MARK_BLOCK = '# voxel-blocklist v1 ';
const MARK_VACATION = '# voxel-vacation v1 ';
const MARK_FILTERS = '# voxel-filters v1 ';
/** Ligne marqueur, préfixe quelconque : `# <préfixe>-<type> v1 `. */
const MARKER_RE = /^# [a-z]+(-[a-z]+ v1 )/;

// ------------------------------------------------------------------ modèle

export interface Blocklist {
  addresses: string[];
  domains: string[];
}

export interface ManagedVacation {
  enabled: boolean;
  subject: string;
  text: string;
  /** Adresse d'expédition de la réponse (`:from`), facultative. */
  from?: string;
  /** Dates `AAAA-MM-JJ` (incluses) ; seulement si `date` et `relational` sont disponibles. */
  start?: string;
  end?: string;
  /** Délai minimal entre deux réponses au même expéditeur, en jours. */
  days: number;
}

export type FilterField = 'from' | 'to' | 'cc' | 'toOrCc' | 'subject' | 'header' | 'size';
export type FilterOp = 'contains' | 'notContains' | 'is' | 'startsWith' | 'endsWith' | 'matches' | 'over' | 'under';
export const FILTER_FIELDS: readonly FilterField[] = ['from', 'to', 'cc', 'toOrCc', 'subject', 'header', 'size'];
export const TEXT_OPS: readonly FilterOp[] = ['contains', 'notContains', 'is', 'startsWith', 'endsWith', 'matches'];
export const SIZE_OPS: readonly FilterOp[] = ['over', 'under'];

export interface FilterCondition {
  field: FilterField;
  op: FilterOp;
  /** Texte cherché ; pour `size` : nombre suivi de `K` ou `M` (« 500K », « 2M »). */
  value: string;
  /** Nom de l'en-tête quand `field` vaut `header`. */
  header?: string;
}

export type FilterAction =
  | { type: 'move'; mailboxId: string }
  | { type: 'copy'; mailboxId: string }
  | { type: 'markRead' }
  | { type: 'flag' }
  | { type: 'keyword'; keyword: string }
  | { type: 'forward'; to: string; keepCopy: boolean }
  | { type: 'discard' }
  | { type: 'stop' };
export type FilterActionType = FilterAction['type'];
export const FILTER_ACTIONS: readonly FilterActionType[] = ['move', 'copy', 'markRead', 'flag', 'keyword', 'forward', 'discard', 'stop'];

export interface SieveFilter {
  id: string;
  name: string;
  enabled: boolean;
  match: 'all' | 'any';
  conditions: FilterCondition[];
  actions: FilterAction[];
}

export interface ManagedSieve {
  blocklist: Blocklist;
  vacation: ManagedVacation | null;
  filters: SieveFilter[];
}

export const EMPTY_MANAGED: ManagedSieve = { blocklist: { addresses: [], domains: [] }, vacation: null, filters: [] };

export interface BuildOptions {
  /** `sieveExtensions` du compte. */
  extensions: string[];
  /** Dossier de rôle junk (obligatoire si la liste de blocage n'est pas vide). */
  junkName?: string;
  junkId?: string;
  /** id JMAP → nom (chemin complet) des dossiers, pour `move` et `copy`. */
  mailboxes?: Record<string, string>;
  /** Adresses de la boîte et de ses identités (`vacation :addresses`). */
  vacationAddresses?: string[];
  /** `maxSizeScript` du compte (octets) : le script doit être strictement plus petit. */
  maxSize?: number | null;
}

export type ManagedErrorCode =
  | 'too_many'
  | 'too_large'
  | 'no_junk'
  | 'too_many_filters'
  | 'missing_extension'
  | 'unknown_mailbox'
  | 'invalid_value'
  | 'no_action'
  /** Script modifié à la main (mode avancé) : on ne le régénère pas sans que l'utilisateur revienne au mode géré. */
  | 'manual_mode';

/** Erreur du générateur ; `code` est stable (traduit par l'interface), `detail` précise (extension, champ…). */
export class ManagedSieveError extends Error {
  code: ManagedErrorCode;
  detail: string | undefined;
  constructor(code: ManagedErrorCode, detail?: string) {
    super(`sieve: ${code}${detail ? ` (${detail})` : ''}`);
    this.code = code;
    this.detail = detail;
    this.name = 'ManagedSieveError';
  }
}
/** Nom historique. */
export const BlocklistError = ManagedSieveError;
export type BlocklistError = ManagedSieveError;

// ------------------------------------------------------------------ normalisation

const ADDRESS_RE = /^[^\s@"\\]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;

export function normalizeAddress(s: string): string | null {
  const v = s.trim().toLowerCase();
  return v.length <= 254 && ADDRESS_RE.test(v) ? v : null;
}

export function normalizeDomain(s: string): string | null {
  let v = s.trim().toLowerCase();
  if (v.startsWith('@')) v = v.slice(1);
  else if (v.startsWith('*.')) v = v.slice(2);
  return DOMAIN_RE.test(v) ? v : null;
}

const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com',
  'yahoo.com', 'yahoo.fr', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.fr', 'gmx.de',
  'proton.me', 'protonmail.com', 'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'neuf.fr', 'laposte.net', 'bbox.fr',
]);

export function isFreemailDomain(d: string): boolean {
  return FREEMAIL.has(d.trim().toLowerCase());
}

/** Listes triées, en minuscules, sans doublon (entrées invalides écartées). */
export function cleanBlocklist(list: Blocklist): Blocklist {
  const uniq = (a: (string | null)[]) => [...new Set(a.filter((x): x is string => !!x))].sort();
  return { addresses: uniq(list.addresses.map(normalizeAddress)), domains: uniq(list.domains.map(normalizeDomain)) };
}

// ------------------------------------------------------------------ chaînes Sieve

/** Chaîne Sieve entre guillemets : `\` → `\\`, `"` → `\"`. */
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const qList = (a: string[]) => `[${a.map(q).join(', ')}]`;
/** Texte littéral dans un motif `:matches` : `*`, `?` et `\` perdent leur sens de joker. */
const literalPattern = (s: string) => s.replace(/[\\*?]/g, (c) => `\\${c}`);

const HEADER_NAME_RE = /^[\x21-\x39\x3b-\x7e]{1,76}$/;
const KEYWORD_RE = /^[\x21-\x7e]{1,64}$/;
const KEYWORD_FORBIDDEN = /[()"{%*\]\\]/;
const SIZE_RE = /^(\d{1,7})([KM])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------ extensions requises

/** Extensions indispensables à une action (`mailboxid` est facultative : utilisée si présente). */
function actionExtensions(a: Pick<FilterAction, 'type'> & { keepCopy?: boolean }): string[] {
  switch (a.type) {
    case 'move':
      return ['fileinto'];
    case 'copy':
      return ['copy', 'fileinto'];
    case 'markRead':
    case 'flag':
    case 'keyword':
      return ['imap4flags'];
    case 'forward':
      return a.keepCopy ? ['copy'] : [];
    default:
      return [];
  }
}

/** Extensions indispensables à un filtre (les tests address / header / size sont du cœur du langage). */
export function requiredExtensions(f: Pick<SieveFilter, 'actions'>): string[] {
  const out = new Set<string>();
  for (const a of f.actions) for (const e of actionExtensions(a)) out.add(e);
  return [...out].sort();
}

/** Extensions requises par un filtre mais absentes du serveur : le filtre n'est pas enregistrable. */
export function missingExtensions(f: Pick<SieveFilter, 'actions'>, extensions: string[]): string[] {
  const have = new Set(extensions);
  return requiredExtensions(f).filter((e) => !have.has(e));
}

/** Une action de ce type est-elle possible avec ces extensions ? (case grisée dans l'éditeur) */
export function actionSupported(type: FilterActionType, extensions: string[], keepCopy = false): boolean {
  const have = new Set(extensions);
  return actionExtensions({ type, keepCopy }).every((e) => have.has(e));
}

/** Répondeur géré par Sieve possible (extension `vacation`) ? Les dates demandent `date` et `relational`. */
export function vacationSupport(extensions: string[]): { vacation: boolean; dates: boolean } {
  const e = new Set(extensions);
  return { vacation: e.has('vacation'), dates: e.has('vacation') && e.has('date') && e.has('relational') };
}

// ------------------------------------------------------------------ générateur

function conditionTest(c: FilterCondition): string {
  if (c.field === 'size') {
    const m = SIZE_RE.exec(c.value.trim().toUpperCase());
    if (!m || (c.op !== 'over' && c.op !== 'under')) throw new ManagedSieveError('invalid_value', 'size');
    return `size :${c.op} ${Number(m[1])}${m[2]}`;
  }
  const value = c.value;
  if (!value) throw new ManagedSieveError('invalid_value', 'empty');
  let match: string;
  let key: string;
  switch (c.op) {
    case 'contains':
    case 'notContains':
      match = ':contains';
      key = value;
      break;
    case 'is':
      match = ':is';
      key = value;
      break;
    case 'startsWith':
      match = ':matches';
      key = `${literalPattern(value)}*`;
      break;
    case 'endsWith':
      match = ':matches';
      key = `*${literalPattern(value)}`;
      break;
    case 'matches':
      match = ':matches';
      key = value;
      break;
    default:
      throw new ManagedSieveError('invalid_value', c.op);
  }
  let test: string;
  if (c.field === 'from' || c.field === 'to' || c.field === 'cc') test = `address :all ${match} ${q(c.field)} ${q(key)}`;
  else if (c.field === 'toOrCc') test = `address :all ${match} ${qList(['to', 'cc'])} ${q(key)}`;
  else if (c.field === 'subject') test = `header ${match} "subject" ${q(key)}`;
  else {
    const h = (c.header ?? '').trim();
    if (!HEADER_NAME_RE.test(h)) throw new ManagedSieveError('invalid_value', 'header');
    test = `header ${match} ${q(h)} ${q(key)}`;
  }
  return c.op === 'notContains' ? `not ${test}` : test;
}

function actionLine(a: FilterAction, ext: Set<string>, req: Set<string>, mailboxes: Record<string, string>): string {
  const target = (id: string) => {
    const name = mailboxes[id];
    if (name === undefined) throw new ManagedSieveError('unknown_mailbox', id);
    if (ext.has('mailboxid')) {
      req.add('mailboxid');
      return `:mailboxid ${q(id)} ${q(name)}`;
    }
    return q(name);
  };
  switch (a.type) {
    case 'move':
      req.add('fileinto');
      return `fileinto ${target(a.mailboxId)};`;
    case 'copy':
      req.add('fileinto').add('copy');
      return `fileinto :copy ${target(a.mailboxId)};`;
    case 'markRead':
      req.add('imap4flags');
      return `addflag ${q('\\Seen')};`;
    case 'flag':
      req.add('imap4flags');
      return `addflag ${q('\\Flagged')};`;
    case 'keyword': {
      const k = a.keyword.trim();
      if (!KEYWORD_RE.test(k) || KEYWORD_FORBIDDEN.test(k)) throw new ManagedSieveError('invalid_value', 'keyword');
      req.add('imap4flags');
      return `addflag ${q(k)};`;
    }
    case 'forward': {
      const to = normalizeAddress(a.to);
      if (!to) throw new ManagedSieveError('invalid_value', 'forward');
      if (a.keepCopy) {
        req.add('copy');
        return `redirect :copy ${q(to)};`;
      }
      return `redirect ${q(to)};`;
    }
    case 'discard':
      return 'discard;';
    case 'stop':
      return 'stop;';
  }
}

/** Filtre nettoyé pour le marqueur (champs connus seulement, ordre des clés stable). */
function cleanFilter(f: SieveFilter): SieveFilter {
  return {
    id: String(f.id),
    name: String(f.name ?? ''),
    enabled: !!f.enabled,
    match: f.match === 'any' ? 'any' : 'all',
    conditions: f.conditions.map((c) => ({ field: c.field, op: c.op, value: String(c.value ?? ''), ...(c.field === 'header' ? { header: String(c.header ?? '') } : {}) })),
    actions: f.actions.map((a): FilterAction => {
      switch (a.type) {
        case 'move':
        case 'copy':
          return { type: a.type, mailboxId: String(a.mailboxId) };
        case 'keyword':
          return { type: 'keyword', keyword: String(a.keyword) };
        case 'forward':
          return { type: 'forward', to: String(a.to), keepCopy: !!a.keepCopy };
        default:
          return { type: a.type };
      }
    }),
  };
}

function cleanVacation(v: ManagedVacation): ManagedVacation {
  const days = Math.min(Math.max(Math.round(Number(v.days) || 7), 1), 365);
  return {
    enabled: !!v.enabled,
    subject: String(v.subject ?? ''),
    text: String(v.text ?? ''),
    ...(v.from ? { from: String(v.from) } : {}),
    ...(v.start ? { start: String(v.start) } : {}),
    ...(v.end ? { end: String(v.end) } : {}),
    days,
  };
}

/** Script complet, déterministe. Lève ManagedSieveError si une règle n'est pas enregistrable. */
export function buildManagedScript(m: ManagedSieve, opts: BuildOptions): string {
  const ext = new Set(opts.extensions);
  const l = cleanBlocklist(m.blocklist);
  if (l.addresses.length + l.domains.length > BLOCKLIST_MAX_ENTRIES) throw new ManagedSieveError('too_many');
  if (m.filters.length > FILTERS_MAX) throw new ManagedSieveError('too_many_filters');
  const filters = m.filters.map(cleanFilter);
  const vacation = m.vacation ? cleanVacation(m.vacation) : null;

  const req = new Set<string>(['fileinto']);
  const body: string[] = [];

  // 1. liste de blocage (à l'identique)
  if (l.addresses.length || l.domains.length) {
    if (!opts.junkName) throw new ManagedSieveError('no_junk');
    let target = `fileinto ${q(opts.junkName)}`;
    if (ext.has('imap4flags')) req.add('imap4flags');
    if (ext.has('special-use')) {
      req.add('special-use');
      target = `fileinto :specialuse ${q('\\Junk')} ${q(opts.junkName)}`;
    } else if (ext.has('mailboxid') && opts.junkId) {
      req.add('mailboxid');
      target = `fileinto :mailboxid ${q(opts.junkId)} ${q(opts.junkName)}`;
    }
    const tests: string[] = [];
    if (l.addresses.length) tests.push(`address :is :all "from" ${qList(l.addresses)}`);
    if (l.domains.length) {
      tests.push(`address :is :domain "from" ${qList(l.domains)}`);
      tests.push(`address :matches :domain "from" ${qList(l.domains.map((d) => `*.${d}`))}`);
    }
    body.push(`if anyof (${tests.join(', ')}) {`);
    if (ext.has('imap4flags')) body.push('  addflag "$junk";');
    body.push(`  ${target};`, '  stop;', '}');
  }

  // 2. répondeur (sans stop : un filtre peut encore classer le message auquel il a répondu)
  if (vacation?.enabled) {
    const sup = vacationSupport(opts.extensions);
    if (!sup.vacation) throw new ManagedSieveError('missing_extension', 'vacation');
    req.add('vacation');
    const args: string[] = [`:days ${vacation.days}`];
    if (vacation.subject) args.push(`:subject ${q(vacation.subject)}`);
    if (vacation.from) {
      const from = normalizeAddress(vacation.from);
      if (!from) throw new ManagedSieveError('invalid_value', 'from');
      args.push(`:from ${q(from)}`);
    }
    const addrs = [...new Set((opts.vacationAddresses ?? []).map(normalizeAddress).filter((x): x is string => !!x))].sort();
    if (addrs.length) args.push(`:addresses ${qList(addrs)}`);
    const action = `vacation ${args.join(' ')} ${q(vacation.text)};`;
    const dates: string[] = [];
    for (const [k, rel] of [['start', 'ge'], ['end', 'le']] as const) {
      const d = vacation[k];
      if (!d) continue;
      if (!DATE_RE.test(d)) throw new ManagedSieveError('invalid_value', k);
      if (!sup.dates) throw new ManagedSieveError('missing_extension', ext.has('date') ? 'relational' : 'date');
      dates.push(`currentdate :value ${q(rel)} "date" ${q(d)}`);
    }
    if (dates.length) {
      req.add('date').add('relational');
      body.push(`if allof (${dates.join(', ')}) {`, `  ${action}`, '}');
    } else body.push(action);
  }

  // 3. filtres, dans l'ordre de l'utilisateur (désactivés : gardés dans le JSON, pas générés)
  const mailboxes = opts.mailboxes ?? {};
  for (const f of filters) {
    if (!f.enabled) continue;
    const missing = missingExtensions(f, opts.extensions);
    if (missing.length) throw new ManagedSieveError('missing_extension', missing[0]);
    if (!f.actions.length) throw new ManagedSieveError('no_action', f.name);
    const tests = f.conditions.map(conditionTest);
    const actions = f.actions.map((a) => `  ${actionLine(a, ext, req, mailboxes)}`);
    const cond = !tests.length ? 'true' : tests.length === 1 ? tests[0]! : `${f.match === 'any' ? 'anyof' : 'allof'} (${tests.join(', ')})`;
    body.push(`if ${cond} {`, ...actions, '}');
  }

  const lines = [
    `require ${qList([...req].sort())};`,
    // ligne figée : la changer ferait passer les scripts déjà en place pour modifiés à la main
    '# Voxel : liste de blocage geree par le webmail, ne pas modifier a la main.',
    MARK_BLOCK + JSON.stringify({ addresses: l.addresses, domains: l.domains }),
  ];
  if (vacation) lines.push(MARK_VACATION + JSON.stringify(vacation));
  if (filters.length) lines.push(MARK_FILTERS + JSON.stringify({ filters }));
  const script = [...lines, ...body].join('\n') + '\n';
  if (opts.maxSize && new TextEncoder().encode(script).length >= opts.maxSize) throw new ManagedSieveError('too_large');
  return script;
}

/** Liste de blocage seule : identique, au caractère près, à l'ancien générateur. */
export function buildBlocklistScript(list: Blocklist, opts: { junkName: string; junkId?: string; extensions: string[] }): string {
  return buildManagedScript({ ...EMPTY_MANAGED, blocklist: list }, opts);
}

// ------------------------------------------------------------------ lecture

/**
 * JSON de la première ligne marqueur de ce type, cherchée dans l'en-tête du script seulement (avant la
 * première règle) : un texte de répondeur sur plusieurs lignes ne peut pas imiter un marqueur.
 * `undefined` : absente ; `null` : JSON illisible.
 */
function markerJson(text: string, marker: string): unknown {
  const kind = marker.slice(marker.indexOf('-'));
  for (const line of text.split(/\r?\n/)) {
    const m = MARKER_RE.exec(line);
    if (m?.[1] === kind) {
      try {
        return JSON.parse(line.slice(m[0].length)) as unknown;
      } catch {
        return null;
      }
    }
    if (line.startsWith('if ') || line.startsWith('vacation ')) break;
  }
  return undefined;
}

/** Mêmes scripts au préfixe des marqueurs près (script écrit par une version précédente, sinon identique). */
export function sameManagedScript(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/^# [a-z]+(-[a-z]+ v1 )/gm, '#$1');
  return norm(a) === norm(b);
}

/** Le texte porte-t-il au moins une ligne marqueur du webmail ? */
export function hasManagedMarkers(text: string): boolean {
  return [MARK_BLOCK, MARK_VACATION, MARK_FILTERS].some((m) => markerJson(text, m) !== undefined);
}

export function parseBlocklistScript(text: string): Blocklist | null {
  const v = markerJson(text, MARK_BLOCK);
  if (!v || typeof v !== 'object') return null;
  const { addresses, domains } = v as Record<string, unknown>;
  const strs = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === 'string');
  if (!strs(addresses) || !strs(domains)) return null;
  return cleanBlocklist({ addresses: addresses as string[], domains: domains as string[] });
}

const isStr = (x: unknown): x is string => typeof x === 'string';

function parseVacation(v: unknown): ManagedVacation | null | false {
  if (v === undefined) return null;
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean' || !isStr(o.subject) || !isStr(o.text)) return false;
  return cleanVacation({
    enabled: o.enabled,
    subject: o.subject,
    text: o.text,
    ...(isStr(o.from) ? { from: o.from } : {}),
    ...(isStr(o.start) ? { start: o.start } : {}),
    ...(isStr(o.end) ? { end: o.end } : {}),
    days: typeof o.days === 'number' ? o.days : 7,
  });
}

function parseFilters(v: unknown): SieveFilter[] | false {
  if (v === undefined) return [];
  if (!v || typeof v !== 'object' || !Array.isArray((v as { filters?: unknown }).filters)) return false;
  const out: SieveFilter[] = [];
  const ops: readonly string[] = [...TEXT_OPS, ...SIZE_OPS];
  for (const raw of (v as { filters: unknown[] }).filters) {
    if (!raw || typeof raw !== 'object') return false;
    const f = raw as Record<string, unknown>;
    if (!isStr(f.id) || !Array.isArray(f.conditions) || !Array.isArray(f.actions)) return false;
    const conditions = (f.conditions as unknown[]).filter((c): c is FilterCondition => {
      const x = c as FilterCondition | null;
      return !!x && typeof x === 'object' && FILTER_FIELDS.includes(x.field) && ops.includes(x.op) && isStr(x.value);
    });
    const actions = (f.actions as unknown[]).filter((a): a is FilterAction => !!a && typeof a === 'object' && FILTER_ACTIONS.includes((a as FilterAction).type));
    out.push(cleanFilter({ id: f.id, name: isStr(f.name) ? f.name : '', enabled: f.enabled !== false, match: f.match === 'any' ? 'any' : 'all', conditions, actions }));
  }
  return out;
}

/**
 * État géré relu depuis les marqueurs. `null` : pas de marqueur `voxel-blocklist`, ou JSON illisible
 * (l'interface distingue « script étranger » et « illisible » avec `hasManagedMarkers`).
 */
export function parseManagedScript(text: string): ManagedSieve | null {
  const blocklist = parseBlocklistScript(text);
  if (!blocklist) return null;
  const vacation = parseVacation(markerJson(text, MARK_VACATION));
  const filters = parseFilters(markerJson(text, MARK_FILTERS));
  if (vacation === false || filters === false) return null;
  return { blocklist, vacation, filters };
}

// ------------------------------------------------------------------ activation

/**
 * Règle d'activation : on n'active notre script que si aucun AUTRE script n'est actif.
 * `vacationEnabled` : un script « vacation » resté actif alors que le répondeur JMAP est coupé ne bloque pas.
 */
export function blocklistActivation(
  scripts: Array<{ id: string; name: string | null; isActive: boolean }>,
  vacationEnabled?: boolean,
): { ours: string | null; active: boolean; activeOther: string | null; canActivate: boolean } {
  const ours = scripts.find((s) => s.name === MANAGED_SCRIPT_NAME) ?? null;
  const other = scripts.find((s) => s.isActive && s.name !== MANAGED_SCRIPT_NAME) ?? null;
  const activeOther = other ? other.name ?? '' : null;
  const blocked = other !== null && !(other.name === VACATION_SCRIPT_NAME && vacationEnabled === false);
  return { ours: ours?.id ?? null, active: !!ours?.isActive, activeOther, canActivate: !blocked };
}
