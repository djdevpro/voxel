/**
 * Priorité d'un message : en-têtes `X-Priority` (1 à 5) et `Importance` (high, normal, low),
 * plus `Priority` (urgent, non-urgent) en lecture. Module pur.
 */

export type Priority = 'high' | 'normal' | 'low';

/** Propriétés JMAP à demander pour lire la priorité d'un message. */
export const PRIORITY_PROPERTIES = ['header:X-Priority:asText', 'header:Importance:asText', 'header:Priority:asText'] as const;

/** En-têtes à ajouter à l'envoi ; aucun pour une priorité normale. */
export function priorityHeaders(p: Priority | undefined | null): Record<string, string> {
  if (p === 'high') return { 'X-Priority': '1 (Highest)', Importance: 'high' };
  if (p === 'low') return { 'X-Priority': '5 (Lowest)', Importance: 'low' };
  return {};
}

/** Priorité d'après les en-têtes reçus (`X-Priority` d'abord, puis `Importance`, puis `Priority`). */
export function parsePriority(xPriority: unknown, importance?: unknown, priority?: unknown): Priority {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const x = str(xPriority);
  const n = /^(\d)/.exec(x)?.[1];
  if (n) {
    if (n === '1' || n === '2') return 'high';
    if (n === '4' || n === '5') return 'low';
    return 'normal';
  }
  if (x.startsWith('high') || x.startsWith('urgent')) return 'high';
  if (x.startsWith('low')) return 'low';
  const i = str(importance);
  if (i === 'high') return 'high';
  if (i === 'low') return 'low';
  const p = str(priority);
  if (p === 'urgent') return 'high';
  if (p === 'non-urgent') return 'low';
  return 'normal';
}

/** Priorité d'un objet Email JMAP qui porte les propriétés de `PRIORITY_PROPERTIES`. */
export function priorityOf(e: Record<string, unknown> | null | undefined): Priority {
  if (!e) return 'normal';
  return parsePriority(e['header:X-Priority:asText'], e['header:Importance:asText'], e['header:Priority:asText']);
}
