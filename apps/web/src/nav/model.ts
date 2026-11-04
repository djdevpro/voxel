/**
 * Modèle d'URL : conversions pures entre les paramètres d'URL et l'état de navigation.
 * Aucune dépendance au routeur : utilisable partout (actions, raccourcis, tests).
 */
import type { MailboxSel, QuickFilters, SearchChip, SystemRole } from '@/store/ui';
import { parseQuery } from '@/lib/search';

export const FOLDER_ROLES: readonly SystemRole[] = ['inbox', 'flagged', 'drafts', 'sent', 'scheduled', 'archive', 'junk', 'trash'];

export const SETTINGS_TABS = ['accounts', 'identities', 'vacation', 'blocked', 'filters', 'folders', 'templates', 'ai', 'appearance', 'reading', 'shortcuts'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function isSettingsTab(v: unknown): v is SettingsTab {
  return typeof v === 'string' && (SETTINGS_TABS as readonly string[]).includes(v);
}

/** Onglet de paramètres d'une URL ; l'ancien onglet `mcp` (supprimé en v3) ouvre « Apparence ». */
export function parseSettingsTab(v: unknown): SettingsTab | undefined {
  if (v === 'mcp') return 'appearance';
  return isSettingsTab(v) ? v : undefined;
}

// ------------------------------------------------------------------ dossiers

/** `:folder` = rôle (`inbox`…) ou dossier perso `f-<id JMAP>`. */
export function folderParam(sel: MailboxSel): string {
  return sel.kind === 'role' ? sel.role : `f-${sel.id}`;
}

export function parseFolder(p: string | undefined): MailboxSel | null {
  if (!p) return null;
  if ((FOLDER_ROLES as readonly string[]).includes(p)) return { kind: 'role', role: p as SystemRole };
  if (p.startsWith('f-') && p.length > 2) return { kind: 'id', id: p.slice(2) };
  return null;
}

// ------------------------------------------------------------------ filtres rapides

const FILTERS = ['unread', 'flagged', 'attachments'] as const;
type FilterName = (typeof FILTERS)[number];

export const NO_QUICK: QuickFilters = { unread: false, flagged: false, attachment: false };

/** `?filter=unread` (plusieurs valeurs séparées par des virgules acceptées : `unread,flagged`). */
export function quickFromFilter(f: string | undefined): QuickFilters {
  if (!f) return NO_QUICK;
  const set = new Set(f.split(',').map((x) => x.trim()));
  return { unread: set.has('unread'), flagged: set.has('flagged'), attachment: set.has('attachments') };
}

export function filterFromQuick(q: QuickFilters): string | undefined {
  const out: FilterName[] = [];
  if (q.unread) out.push('unread');
  if (q.flagged) out.push('flagged');
  if (q.attachment) out.push('attachments');
  return out.length ? out.join(',') : undefined;
}

export function normalizeFilter(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return filterFromQuick(quickFromFilter(v));
}

// ------------------------------------------------------------------ recherche

/** Chips + texte → `?q=` (clés canoniques anglaises : l'URL est la même dans toutes les langues). */
export function queryFromSearch(s: { chips: SearchChip[]; text: string }): string {
  const parts = s.chips.map((c) => `${c.key}:${/[\s"]/.test(c.value) ? `"${c.value.replace(/"/g, '')}"` : c.value}`);
  if (s.text.trim()) parts.push(s.text.trim());
  return parts.join(' ');
}

const searchCache = new Map<string, { chips: SearchChip[]; text: string }>();

/** `?q=` → chips + texte (résultat mémorisé : même référence pour une même requête). */
export function searchFromQuery(q: string | undefined): { chips: SearchChip[]; text: string } {
  const key = q?.trim() ?? '';
  let hit = searchCache.get(key);
  if (!hit) {
    hit = key ? parseQuery(key) : { chips: [], text: '' };
    if (searchCache.size > 200) searchCache.clear();
    searchCache.set(key, hit);
  }
  return hit;
}

// ------------------------------------------------------------------ validation

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length ? v : undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** `redirect` limité aux chemins internes (commence par « / », jamais « // » ni « /\ »). */
export function safeRedirect(v: unknown): string | undefined {
  const s = str(v);
  if (!s || !s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\')) return undefined;
  if (/[\u0000-\u001f]/.test(s)) return undefined;
  if (s === '/login' || s.startsWith('/login?') || s.startsWith('/login/')) return undefined;
  return s;
}

// ------------------------------------------------------------------ mailto

export interface MailtoFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

function splitAddrs(v: string | null | undefined): string[] {
  return (v ?? '')
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function decode(v: string): string {
  try {
    return decodeURIComponent(v.replace(/\+/g, '%20'));
  } catch {
    return v;
  }
}

/** Analyse une URI `mailto:` (RFC 6068) : destinataires, cc, bcc, objet, corps. */
export function parseMailto(uri: string): MailtoFields {
  const out: MailtoFields = { to: [], cc: [], bcc: [], subject: '', body: '' };
  let s = uri.trim();
  if (/^mailto:/i.test(s)) s = s.slice(7);
  const q = s.indexOf('?');
  const path = q >= 0 ? s.slice(0, q) : s;
  const query = q >= 0 ? s.slice(q + 1) : '';
  out.to.push(...splitAddrs(decode(path)));
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decode(eq >= 0 ? pair.slice(0, eq) : pair).toLowerCase();
    const v = eq >= 0 ? decode(pair.slice(eq + 1)) : '';
    if (k === 'to') out.to.push(...splitAddrs(v));
    else if (k === 'cc') out.cc.push(...splitAddrs(v));
    else if (k === 'bcc') out.bcc.push(...splitAddrs(v));
    else if (k === 'subject') out.subject = v;
    else if (k === 'body') out.body = v;
  }
  return out;
}
