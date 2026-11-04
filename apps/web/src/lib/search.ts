import type { EmailFilterCondition } from '@voxel/jmap';
import type { QuickFilters, SearchChip, SystemRole } from '@/store/ui';
import i18n from '@/i18n';

/**
 * Opérateurs reconnus. Les clés anglaises (`from:`, `is:unread`…) marchent dans toutes les langues ;
 * chaque langue ajoute ses alias (`mail:search.aliases.*`, listes séparées par des virgules).
 */
export const OPERATORS: Array<{ key: string; hint: string; values?: string[] }> = [
  { key: 'from', hint: 'from:paul@example.com' },
  { key: 'to', hint: 'to:marie' },
  { key: 'subject', hint: 'subject:invoice' },
  { key: 'has', hint: 'has:attachment', values: ['attachment'] },
  { key: 'is', hint: 'is:unread', values: ['unread', 'read', 'flagged'] },
  { key: 'before', hint: 'before:2026-01-31' },
  { key: 'after', hint: 'after:2026-01-01' },
  { key: 'in', hint: 'in:sent', values: ['inbox', 'sent', 'drafts', 'archive', 'trash', 'junk'] },
];

/** Libellé traduit d'un opérateur (suggestions). */
export function operatorLabel(key: string): string {
  return i18n.t(`mail:search.operators.${key}`);
}

/** Alias traduits (minuscules) d'une clé `mail:search.aliases.<key>`. */
function aliases(key: string): string[] {
  const raw = i18n.t(`mail:search.aliases.${key}`, { defaultValue: '' });
  return raw
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

export function canonicalKey(k: string): string | null {
  const low = k.toLowerCase();
  for (const op of OPERATORS) if (op.key === low || aliases(op.key).includes(low)) return op.key;
  return null;
}

/** Valeur canonique de `is:` / `has:` / `in:` (accepte les alias traduits). */
function canonicalValue(key: 'is' | 'has' | 'in', v: string): string | undefined {
  const low = v.toLowerCase();
  const op = OPERATORS.find((o) => o.key === key);
  for (const val of op?.values ?? []) {
    if (low === val || aliases(`${key}_${val}`).includes(low)) return val;
  }
  if (key === 'is' && low === 'starred') return 'flagged';
  return undefined;
}

export function chipLabel(c: SearchChip): string {
  if (c.key === 'has' && canonicalValue('has', c.value) === 'attachment') return i18n.t('mail:search.chips.attachment');
  if (c.key === 'is') {
    const v = canonicalValue('is', c.value);
    if (v) return i18n.t(`mail:search.chips.${v}`);
  }
  if (c.key === 'in') {
    const v = canonicalValue('in', c.value);
    if (v) return i18n.t('mail:search.chips.keyValue', { key: operatorLabel('in'), value: i18n.t(`mail:roles.${v}`) });
  }
  const label = OPERATORS.some((o) => o.key === c.key) ? operatorLabel(c.key) : c.key;
  return i18n.t('mail:search.chips.keyValue', { key: label, value: c.value });
}

/** Découpe un texte libre en chips reconnues + reste. */
export function parseQuery(input: string): { chips: SearchChip[]; text: string } {
  const chips: SearchChip[] = [];
  const rest: string[] = [];
  const re = /(\S+?):("([^"]*)"|\S+)|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m[1]) {
      const key = canonicalKey(m[1]);
      const value = m[3] ?? m[2] ?? '';
      if (key && value) chips.push({ key, value });
      else rest.push(m[0]);
    } else if (m[4]) rest.push(m[4]);
  }
  return { chips, text: rest.join(' ') };
}

function toDate(v: string, endOfDay: boolean): string | undefined {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${endOfDay ? '23:59:59' : '00:00:00'}`) : /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v) ? (() => {
    const [dd, mm, yy] = v.split('/');
    return new Date(Number(yy), Number(mm) - 1, Number(dd), endOfDay ? 23 : 0, endOfDay ? 59 : 0);
  })() : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface FilterContext {
  roleId: (role: SystemRole) => string | undefined;
}

/** Conditions JMAP issues des chips, du texte et des filtres rapides. */
export function searchConditions(
  chips: SearchChip[],
  text: string,
  quick: QuickFilters,
  ctx: FilterContext,
): { conditions: EmailFilterCondition[]; inRole?: SystemRole } {
  const conds: EmailFilterCondition[] = [];
  let inRole: SystemRole | undefined;
  for (const c of chips) {
    const v = c.value;
    switch (c.key) {
      case 'from':
        conds.push({ from: v });
        break;
      case 'to':
        conds.push({ to: v });
        break;
      case 'subject':
        conds.push({ subject: v });
        break;
      case 'has':
        conds.push({ hasAttachment: true });
        break;
      case 'is':
      {
        const iv = canonicalValue('is', v);
        if (iv === 'unread') conds.push({ notKeyword: '$seen' });
        else if (iv === 'read') conds.push({ hasKeyword: '$seen' });
        else if (iv === 'flagged') conds.push({ hasKeyword: '$flagged' });
        break;
      }
      case 'before': {
        const d = toDate(v, false);
        if (d) conds.push({ before: d });
        break;
      }
      case 'after': {
        const d = toDate(v, true);
        if (d) conds.push({ after: d });
        break;
      }
      case 'in': {
        inRole = canonicalValue('in', v) as SystemRole | undefined;
        break;
      }
    }
  }
  if (text.trim()) conds.push({ text: text.trim() });
  if (quick.unread) conds.push({ notKeyword: '$seen' });
  if (quick.flagged) conds.push({ hasKeyword: '$flagged' });
  if (quick.attachment) conds.push({ hasAttachment: true });
  void ctx;
  return { conditions: conds, inRole };
}
