/**
 * Réponses types, rangées dans les réglages synchronisés de la boîte (clé `templates`).
 * Module pur : lecture tolérante et tri.
 */

export interface MailTemplate {
  id: string;
  name: string;
  /** Objet proposé si celui du message est vide. */
  subject?: string;
  /** Corps riche (HTML produit par l'éditeur). */
  html: string;
}

/** Lecture tolérante de la valeur synchronisée : entrées invalides ignorées, tri par nom. */
export function parseTemplates(v: unknown, locale = 'en'): MailTemplate[] {
  if (!Array.isArray(v)) return [];
  const out: MailTemplate[] = [];
  const seen = new Set<string>();
  for (const t of v) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id || seen.has(o.id) || typeof o.name !== 'string' || typeof o.html !== 'string') continue;
    seen.add(o.id);
    out.push({ id: o.id, name: o.name, html: o.html, ...(typeof o.subject === 'string' && o.subject ? { subject: o.subject } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, locale));
}
