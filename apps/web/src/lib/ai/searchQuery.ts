/** Critères de l'outil `search_emails` → chips de la recherche classique (module léger, partagé par l'outil et l'UI). */
import type { SearchChip } from '@/store/ui';
import type { SearchEmailsInput } from './tools';

/** Décale une date AAAA-MM-JJ de `days` jours (date locale). */
export function shiftDay(day: string, days: number): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const FOLDER_ROLES = new Set(['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash']);

/** Critères de l'outil → chips de la recherche de la liste (`lib/search.ts`). */
export function chipsOf(input: SearchEmailsInput): SearchChip[] {
  const chips: SearchChip[] = [];
  if (input.from?.trim()) chips.push({ key: 'from', value: input.from.trim() });
  if (input.to?.trim()) chips.push({ key: 'to', value: input.to.trim() });
  if (input.subject?.trim()) chips.push({ key: 'subject', value: input.subject.trim() });
  // `after:` et `before:` excluent la journée donnée
  const after = input.since ? shiftDay(input.since, -1) : undefined;
  const before = input.until ? shiftDay(input.until, 1) : undefined;
  if (after) chips.push({ key: 'after', value: after });
  if (before) chips.push({ key: 'before', value: before });
  if (input.unread === true) chips.push({ key: 'is', value: 'unread' });
  if (input.unread === false) chips.push({ key: 'is', value: 'read' });
  if (input.flagged || input.folder === 'flagged') chips.push({ key: 'is', value: 'flagged' });
  if (input.hasAttachment) chips.push({ key: 'has', value: 'attachment' });
  if (input.folder && FOLDER_ROLES.has(input.folder)) chips.push({ key: 'in', value: input.folder });
  return chips;
}
