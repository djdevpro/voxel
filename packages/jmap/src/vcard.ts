/**
 * Conversion vCard (3.0, 4.0) ↔ JSContact (RFC 9553) selon RFC 9555, analyse et écriture par `ical.js`.
 *
 * Utilisée par le webmail (export `.vcf`) et par la passerelle (façade CardDAV → JMAP Contacts). Les propriétés
 * vCard sans équivalent JSContact (X-…, IMPP, GENDER, GEO, RELATED…) sont gardées telles quelles, en jCard,
 * dans `vCard.properties` (comme le fait Stalwart) et réécrites à l'aller-retour ; la version d'origine aussi
 * (`["version", {}, "text", "3.0"]`), pour réécrire une vCard 3.0 dans sa version.
 *
 * Correspondances principales : FN → name.full ; N → name.components (surname, given, given2, title,
 * credential) ; NICKNAME → nicknames ; EMAIL / TEL / ADR / URL avec TYPE home → contexts.private,
 * work → contexts.work, PREF / TYPE=pref → pref ; TEL TYPE cell → features.mobile (voice, fax, pager, text,
 * video, textphone) ; ORG → organizations (name + units) ; TITLE / ROLE → titles ; BDAY / ANNIVERSARY
 * → anniversaries (PartialDate) ; NOTE → notes ; PHOTO / LOGO → media ; CATEGORIES → keywords ;
 * KIND / X-ADDRESSBOOKSERVER-KIND → kind ; MEMBER / X-ADDRESSBOOKSERVER-MEMBER → members ; UID, PRODID, REV.
 * Étiquettes Apple (`itemN.X-ABLabel`) → `label` de la propriété du même groupe.
 */
import ICAL from 'ical.js';
import { splitVcards, type CardAddress, type CardMedia, type ContactCard, type ContactCardCreate, type NameComponent, type PartialDate, type VCardProp } from './jscontact.ts';

type JProp = [string, Record<string, unknown>, string, ...unknown[]];

const N_KINDS = ['surname', 'given', 'given2', 'title', 'credential'] as const;
const ADR_KINDS = ['postOfficeBox', 'apartment', 'name', 'locality', 'region', 'postcode', 'country'] as const;
const TEL_FEATURES: Record<string, string> = { cell: 'mobile', voice: 'voice', fax: 'fax', pager: 'pager', text: 'text', video: 'video', textphone: 'textphone', 'main-number': 'main-number' };
const FEATURE_TYPES: Record<string, string> = Object.fromEntries(Object.entries(TEL_FEATURES).map(([k, v]) => [v, k]));
/** Propriétés traduites (le reste est conservé dans `vCard.properties`). */
const KNOWN = new Set([
  'version', 'uid', 'kind', 'x-addressbookserver-kind', 'member', 'x-addressbookserver-member', 'fn', 'n', 'nickname', 'email', 'tel',
  'adr', 'org', 'title', 'role', 'bday', 'anniversary', 'url', 'note', 'photo', 'logo', 'categories', 'prodid', 'rev',
]);

// ------------------------------------------------------------------ utilitaires

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? '')) : v === undefined || v === null ? [] : [String(v)]);

function typesOf(params: Record<string, unknown>): string[] {
  return asList(params.type)
    .flatMap((t) => t.split(','))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function contextsOf(types: string[]): Record<string, boolean> | undefined {
  const c: Record<string, boolean> = {};
  if (types.includes('home')) c.private = true;
  if (types.includes('work')) c.work = true;
  return Object.keys(c).length ? c : undefined;
}

function prefOf(params: Record<string, unknown>, types: string[]): number | undefined {
  const p = Number(asList(params.pref)[0]);
  if (Number.isInteger(p) && p >= 1 && p <= 100) return p;
  return types.includes('pref') ? 1 : undefined;
}

/** `_$!<Mobile>!$_` (étiquettes Apple prédéfinies) → `Mobile`. */
const cleanLabel = (s: string) => s.replace(/^_\$!<(.*)>!\$_$/, '$1').trim();

/** Date vCard (jCard : `1990-05-03`, `--05-03`, `1990`, `1990-05`, avec heure éventuelle) → PartialDate. */
export function parseVcardDate(value: string, omitYear?: string): PartialDate | null {
  const v = value.trim().replace(/T.*$/, '');
  let m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m) {
    const d: PartialDate = { '@type': 'PartialDate', month: Number(m[2]), day: Number(m[3]) };
    if (m[1] !== omitYear && m[1] !== '1604') d.year = Number(m[1]);
    return d;
  }
  m = v.match(/^--(\d{2})-?(\d{2})$/);
  if (m) return { '@type': 'PartialDate', month: Number(m[1]), day: Number(m[2]) };
  m = v.match(/^(\d{4})(?:-(\d{2}))?$/);
  if (m) return { '@type': 'PartialDate', year: Number(m[1]), ...(m[2] ? { month: Number(m[2]) } : {}) };
  m = v.match(/^---(\d{2})$/);
  if (m) return { '@type': 'PartialDate', day: Number(m[1]) };
  return null;
}

const pad = (n: number | undefined, len = 2) => String(n ?? 0).padStart(len, '0');

function dateValue(d: PartialDate, v3: boolean): { value: string; params: Record<string, unknown> } | null {
  if (!d.month && !d.year) return null;
  if (d.year && d.month && d.day) return { value: `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`, params: {} };
  if (!d.year && d.month && d.day) {
    // vCard 3.0 n'a pas de date sans année : convention Apple (année 1604 + X-APPLE-OMIT-YEAR)
    return v3 ? { value: `1604-${pad(d.month)}-${pad(d.day)}`, params: { 'x-apple-omit-year': '1604' } } : { value: `--${pad(d.month)}-${pad(d.day)}`, params: {} };
  }
  if (d.year && d.month) return v3 ? { value: `${pad(d.year, 4)}-${pad(d.month)}-01`, params: {} } : { value: `${pad(d.year, 4)}-${pad(d.month)}`, params: {} };
  if (d.year) return v3 ? null : { value: pad(d.year, 4), params: {} };
  return null;
}

const MIME_OF: Record<string, string> = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

function mediaOf(kind: 'photo' | 'logo', p: JProp): CardMedia | null {
  const [, params, type, value] = p;
  const text = String(value ?? '').trim();
  if (!text) return null;
  const enc = String(asList(params.encoding)[0] ?? '').toLowerCase();
  if (type === 'binary' || enc === 'b' || enc === 'base64') {
    const t = typesOf(params)[0] ?? 'jpeg';
    const mediaType = t.includes('/') ? t : (MIME_OF[t] ?? `image/${t}`);
    return { kind, uri: `data:${mediaType};base64,${text.replace(/\s+/g, '')}`, mediaType };
  }
  const mt = asList(params.mediatype)[0];
  return { kind, uri: text, ...(mt ? { mediaType: mt } : {}) };
}

// ------------------------------------------------------------------ vCard → JSContact

/** Une vCard (texte ou jCard) → fiche JSContact (sans `id`). Lève une erreur si le texte n'est pas une vCard. */
export function vcardToCard(input: string | unknown[]): ContactCardCreate {
  const jcard = (typeof input === 'string' ? ICAL.parse(input) : input) as unknown[];
  const root = (Array.isArray(jcard[0]) ? jcard[0] : jcard) as [string, JProp[], unknown[]];
  if (!Array.isArray(root) || String(root[0]).toLowerCase() !== 'vcard') throw new Error('not a vCard');
  const props = root[1] ?? [];
  const card: ContactCardCreate = { '@type': 'Card', version: '1.0' };
  const unknown: VCardProp[] = [];
  /** groupe vCard (`item1`) → objet JSContact qui recevra l'étiquette `X-ABLabel` */
  const grouped = new Map<string, { label?: string }>();
  const labels: Array<[string, JProp]> = [];
  const counters: Record<string, number> = {};
  const key = (prefix: string) => `${prefix}${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`;
  const put = <T extends object>(field: string, prefix: string, value: T, group: unknown): T => {
    const o = ((card as Record<string, unknown>)[field] ??= {}) as Record<string, T>;
    o[key(prefix)] = value;
    if (typeof group === 'string' && group) grouped.set(group.toLowerCase(), value as { label?: string });
    return value;
  };
  let version = '4.0';
  let fn = '';

  for (const p of props) {
    if (!Array.isArray(p)) continue;
    const [rawName, params = {}, type, ...values] = p as JProp;
    const name = String(rawName).toLowerCase();
    const value = values[0];
    const types = typesOf(params);
    const group = params.group;
    switch (name) {
      case 'version':
        version = String(value);
        break;
      case 'uid':
        card.uid = String(value);
        break;
      case 'kind':
      case 'x-addressbookserver-kind': {
        const k = String(value).toLowerCase();
        if (['individual', 'group', 'org', 'location', 'device', 'application'].includes(k)) card.kind = k as ContactCard['kind'];
        break;
      }
      case 'member':
      case 'x-addressbookserver-member':
        for (const v of values) if (v) (card.members ??= {})[String(v)] = true;
        break;
      case 'fn':
        fn = String(value ?? '').trim();
        break;
      case 'n': {
        const parts = Array.isArray(value) ? value : String(value ?? '').split(';');
        const components: NameComponent[] = [];
        parts.forEach((part, i) => {
          const kind = N_KINDS[i];
          if (!kind) return;
          for (const v of asList(part)) if (v.trim()) components.push({ kind, value: v.trim() });
        });
        if (components.length) (card.name ??= {}).components = components;
        break;
      }
      case 'nickname':
        for (const v of values.flatMap(asList)) if (v.trim()) put('nicknames', 'k', { name: v.trim() }, group);
        break;
      case 'email': {
        const address = String(value ?? '').trim();
        if (!address) break;
        const ctx = contextsOf(types);
        const pref = prefOf(params, types);
        put('emails', 'e', { address, ...(ctx ? { contexts: ctx } : {}), ...(pref ? { pref } : {}) }, group);
        break;
      }
      case 'tel': {
        const number = String(value ?? '').trim().replace(/^tel:/i, '');
        if (!number) break;
        const ctx = contextsOf(types);
        const pref = prefOf(params, types);
        const features: Record<string, boolean> = {};
        for (const t of types) if (TEL_FEATURES[t]) features[TEL_FEATURES[t]] = true;
        put('phones', 'p', { number, ...(Object.keys(features).length ? { features } : {}), ...(ctx ? { contexts: ctx } : {}), ...(pref ? { pref } : {}) }, group);
        break;
      }
      case 'adr': {
        const parts = Array.isArray(value) ? value : String(value ?? '').split(';');
        const components: CardAddress['components'] = [];
        parts.forEach((part, i) => {
          const kind = ADR_KINDS[i];
          if (!kind) return;
          for (const v of asList(part)) if (v.trim()) components.push({ kind, value: v.trim() });
        });
        const full = asList(params.label)[0];
        const cc = asList(params.cc)[0];
        if (!components.length && !full) break;
        const ctx = contextsOf(types);
        const pref = prefOf(params, types);
        put(
          'addresses',
          'a',
          {
            ...(components.length ? { components, isOrdered: true } : {}),
            ...(full ? { full } : {}),
            ...(cc ? { countryCode: cc } : {}),
            ...(ctx ? { contexts: ctx } : {}),
            ...(pref ? { pref } : {}),
          },
          group,
        );
        break;
      }
      case 'org': {
        const parts = (Array.isArray(value) ? value : String(value ?? '').split(';')).map((x) => asList(x).join(', ').trim());
        const [orgName, ...units] = parts;
        if (!orgName && !units.some(Boolean)) break;
        put('organizations', 'o', { ...(orgName ? { name: orgName } : {}), ...(units.some(Boolean) ? { units: units.filter(Boolean).map((u) => ({ name: u })) } : {}) }, group);
        break;
      }
      case 'title':
      case 'role': {
        const v = String(value ?? '').trim();
        if (v) put('titles', 't', { name: v, kind: name === 'role' ? 'role' : 'title' }, group);
        break;
      }
      case 'bday':
      case 'anniversary': {
        const d = parseVcardDate(String(value ?? ''), asList(params['x-apple-omit-year'])[0]);
        if (d) put('anniversaries', 'n', { kind: name === 'bday' ? 'birth' : 'wedding', date: d }, group);
        else unknown.push(p as VCardProp);
        break;
      }
      case 'url': {
        // Apple et Google échappent les deux-points des URL (`https\://`) en vCard 3.0
        const uri = String(value ?? '').trim().replace(/\\:/g, ':');
        if (!uri) break;
        const ctx = contextsOf(types);
        put('links', 'l', { uri, ...(ctx ? { contexts: ctx } : {}) }, group);
        break;
      }
      case 'note': {
        const note = String(value ?? '');
        if (note.trim()) put('notes', 'm', { note }, group);
        break;
      }
      case 'photo':
      case 'logo': {
        const m = mediaOf(name, p as JProp);
        if (m) put('media', name === 'photo' ? 'ph' : 'lg', m, group);
        break;
      }
      case 'categories':
        for (const v of values.flatMap(asList)) if (v.trim()) (card.keywords ??= {})[v.trim()] = true;
        break;
      case 'prodid':
        card.prodId = String(value ?? '');
        break;
      case 'rev': {
        const d = new Date(String(value ?? '').replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'));
        if (!Number.isNaN(d.getTime())) card.updated = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
        break;
      }
      default:
        if (name === 'x-ablabel' && typeof group === 'string') labels.push([group.toLowerCase(), p as JProp]);
        else if (!KNOWN.has(name)) unknown.push(p as VCardProp);
        // type jCard conservé tel quel (texte, uri, date…)
        void type;
    }
  }

  // étiquettes Apple : rattachées à la propriété du même groupe, sinon conservées
  for (const [g, p] of labels) {
    const target = grouped.get(g);
    const text = cleanLabel(String(p[3] ?? ''));
    if (target && text) target.label = text;
    else unknown.push(p as VCardProp);
  }

  if (fn) (card.name ??= {}).full = fn;
  if (version !== '4.0') unknown.unshift(['version', {}, 'text', version]);
  if (unknown.length) card.vCard = { properties: unknown };
  return card;
}

/** Fichier `.vcf` (une ou plusieurs vCard) → fiches ; les vCard illisibles sont comptées, pas levées. */
export function parseVcf(text: string): { cards: ContactCardCreate[]; invalid: number } {
  const cards: ContactCardCreate[] = [];
  let invalid = 0;
  for (const one of splitVcards(text)) {
    try {
      cards.push(vcardToCard(one));
    } catch {
      invalid++;
    }
  }
  return { cards, invalid };
}

// ------------------------------------------------------------------ JSContact → vCard

function typeParam(contexts: Record<string, boolean> | undefined, extra: string[] = []): string[] {
  const out = [...extra];
  if (contexts?.private) out.push('home');
  if (contexts?.work) out.push('work');
  return out;
}

function withTypes(params: Record<string, unknown>, types: string[], pref: number | undefined, v3: boolean): Record<string, unknown> {
  const t = [...types];
  if (pref && v3 && pref === 1) t.push('pref');
  if (pref && !v3) params.pref = String(pref);
  if (t.length) params.type = t.length === 1 ? (v3 ? t[0]!.toUpperCase() : t[0]) : v3 ? t.map((x) => x.toUpperCase()) : t;
  return params;
}

function sortedEntries<T extends { pref?: number }>(o: Record<string, T> | undefined): T[] {
  return Object.values(o ?? {}).sort((a, b) => (a.pref ?? 101) - (b.pref ?? 101));
}

/**
 * Fiche JSContact → vCard. Version : `opts.version`, sinon celle d'origine (gardée dans `vCard.properties`),
 * sinon 4.0. Les médias sans `uri` (photo stockée en blob côté serveur) sont omis.
 */
export function cardToVcard(card: Partial<ContactCard>, opts: { version?: '3.0' | '4.0'; displayName?: string } = {}): string {
  const kept = (card.vCard?.properties ?? []).filter((p) => Array.isArray(p) && typeof p[0] === 'string');
  const keptVersion = kept.find((p) => p[0].toLowerCase() === 'version')?.[3];
  const version = opts.version ?? (keptVersion === '3.0' ? '3.0' : '4.0');
  const v3 = version === '3.0';
  const props: JProp[] = [['version', {}, 'text', version]];
  // groupes déjà pris par les propriétés conservées (`item2.X-ABADR`…) : on ne les réutilise pas
  const usedGroups = new Set(kept.map((p) => String((p[1] as { group?: unknown })?.group ?? '').toLowerCase()).filter(Boolean));
  let item = 0;
  const labelled = (p: JProp, label: string | undefined) => {
    if (!label) {
      props.push(p);
      return;
    }
    let group = `item${++item}`;
    while (usedGroups.has(group)) group = `item${++item}`;
    p[1] = { ...p[1], group };
    props.push(p, ['x-ablabel', { group }, 'unknown', label]);
  };

  if (card.uid) props.push(['uid', {}, 'text', card.uid]);
  if (card.kind && card.kind !== 'individual') props.push([v3 ? 'x-addressbookserver-kind' : 'kind', {}, v3 ? 'unknown' : 'text', card.kind]);
  if (card.prodId) props.push(['prodid', {}, 'text', card.prodId]);

  const fn = card.name?.full?.trim() || opts.displayName || '';
  props.push(['fn', {}, 'text', fn]);
  const comps = card.name?.components ?? [];
  if (comps.length) {
    const n = N_KINDS.map((k) => {
      const vals = comps.filter((c) => c.kind === k || (k === 'surname' && c.kind === 'surname2') || (k === 'credential' && c.kind === 'generation')).map((c) => c.value);
      return vals.length > 1 ? vals : (vals[0] ?? '');
    });
    props.push(['n', {}, 'text', n]);
  } else if (v3) {
    props.push(['n', {}, 'text', ['', '', '', '', '']]);
  }
  for (const nk of Object.values(card.nicknames ?? {})) if (nk.name) props.push(['nickname', {}, 'text', nk.name]);

  for (const e of sortedEntries(card.emails)) {
    if (!e.address) continue;
    labelled(['email', withTypes({}, typeParam(e.contexts, v3 ? ['internet'] : []), e.pref, v3), 'text', e.address], e.label);
  }
  for (const ph of sortedEntries(card.phones)) {
    if (!ph.number) continue;
    const feats = Object.entries(ph.features ?? {})
      .filter(([, on]) => on)
      .map(([f]) => FEATURE_TYPES[f] ?? f);
    labelled(['tel', withTypes({}, typeParam(ph.contexts, feats), ph.pref, v3), v3 ? 'phone-number' : 'text', ph.number], ph.label);
  }
  for (const a of sortedEntries(card.addresses)) {
    const c = a.components ?? [];
    const pick = (...kinds: string[]) =>
      c
        .filter((x) => kinds.includes(x.kind))
        .map((x) => x.value)
        .join(' ');
    const value = [
      pick('postOfficeBox'),
      pick('apartment', 'room', 'floor', 'building'),
      pick('number', 'name', 'block', 'direction', 'landmark'),
      pick('locality', 'district', 'subdistrict'),
      pick('region'),
      pick('postcode'),
      pick('country'),
    ];
    if (!value.some(Boolean) && !a.full) continue;
    const params = withTypes({}, typeParam(a.contexts), a.pref, v3);
    if (a.full && !v3) params.label = a.full;
    if (a.countryCode && !v3) params.cc = a.countryCode;
    labelled(['adr', params, 'text', value.some(Boolean) ? value : ['', '', a.full ?? '', '', '', '', '']], a.label);
  }
  for (const o of Object.values(card.organizations ?? {})) {
    const units = (o.units ?? []).map((u) => u.name);
    if (o.name || units.length) props.push(['org', {}, 'text', units.length ? [o.name ?? '', ...units] : (o.name ?? '')]);
  }
  for (const t of Object.values(card.titles ?? {})) if (t.name) props.push([t.kind === 'role' ? 'role' : 'title', {}, 'text', t.name]);
  for (const an of Object.values(card.anniversaries ?? {})) {
    if (an.date && (an.date as { '@type'?: string })['@type'] === 'Timestamp') {
      const utc = (an.date as { utc: string }).utc;
      props.push([an.kind === 'birth' ? 'bday' : 'anniversary', {}, v3 ? 'date-time' : 'date-and-or-time', utc]);
      continue;
    }
    if (an.kind !== 'birth' && (v3 || an.kind !== 'wedding')) continue;
    const dv = dateValue(an.date as PartialDate, v3);
    if (dv) props.push([an.kind === 'birth' ? 'bday' : 'anniversary', dv.params, v3 ? 'date' : 'date-and-or-time', dv.value]);
  }
  for (const l of Object.values(card.links ?? {})) if (l.uri) labelled(['url', withTypes({}, typeParam(l.contexts), undefined, v3), 'uri', l.uri], l.label);
  for (const n of Object.values(card.notes ?? {})) if (n.note) props.push(['note', {}, 'text', n.note]);
  for (const m of sortedEntries(card.media)) {
    if (!m.uri || (m.kind !== 'photo' && m.kind !== 'logo')) continue;
    const data = m.uri.match(/^data:([^;,]+)?;base64,(.*)$/s);
    if (v3 && data) props.push([m.kind, { encoding: 'b', type: (data[1] ?? 'image/jpeg').split('/')[1]!.toUpperCase() }, 'binary', data[2]!]);
    else props.push([m.kind, m.mediaType && !data && !v3 ? { mediatype: m.mediaType } : {}, 'uri', m.uri]);
  }
  const kw = Object.entries(card.keywords ?? {})
    .filter(([, on]) => on)
    .map(([k]) => k);
  if (kw.length) props.push(['categories', {}, 'text', ...kw]);
  for (const uid of Object.entries(card.members ?? {})
    .filter(([, on]) => on)
    .map(([k]) => k)) {
    props.push(v3 ? ['x-addressbookserver-member', {}, 'unknown', uid.startsWith('urn:uuid:') ? uid : `urn:uuid:${uid}`] : ['member', {}, 'uri', uid]);
  }
  if (card.updated) props.push(['rev', {}, 'timestamp', card.updated.replace(/\.\d+Z$/, 'Z')]);
  // propriétés conservées (hors version, déjà écrite)
  for (const p of kept) if (p[0].toLowerCase() !== 'version') props.push(p.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? { ...x } : x)) as JProp);

  const text = new ICAL.Component(['vcard', props, []]).toString();
  return `${text.replace(/\r?\n/g, '\r\n').replace(/(\r\n)?$/, '')}\r\n`;
}

/** Plusieurs fiches → un fichier `.vcf`. */
export function cardsToVcf(cards: Array<Partial<ContactCard>>, opts: { version?: '3.0' | '4.0' } = {}): string {
  return cards.map((c) => cardToVcard(c, opts)).join('');
}
