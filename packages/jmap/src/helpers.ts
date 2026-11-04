import type { EmailAddress, EmailCreate, Id, Mailbox, MailboxRole } from './types.ts';

/** Propriétés d'en-tête utiles pour une liste de messages. */
export const EMAIL_LIST_PROPERTIES = [
  'id',
  'threadId',
  'mailboxIds',
  'keywords',
  'size',
  'receivedAt',
  'from',
  'to',
  'cc',
  'subject',
  'sentAt',
  'hasAttachment',
  'preview',
  // priorité
  'header:X-Priority:asText',
  'header:Importance:asText',
  'header:Priority:asText',
] as const;

/** Propriétés pour l'affichage complet d'un message. */
export const EMAIL_FULL_PROPERTIES = [
  ...EMAIL_LIST_PROPERTIES,
  'blobId',
  'messageId',
  'inReplyTo',
  'references',
  'sender',
  'bcc',
  'replyTo',
  'bodyValues',
  'textBody',
  'htmlBody',
  'attachments',
  'header:List-Unsubscribe:asURLs',
  'header:List-Unsubscribe-Post:asText',
  // demande d'accusé de lecture
  'header:Disposition-Notification-To:asAddresses',
] as const;

export const ROLE_ORDER: MailboxRole[] = ['inbox', 'flagged', 'drafts', 'sent', 'scheduled', 'archive', 'junk', 'trash'];

export function findByRole(mailboxes: Mailbox[], role: MailboxRole): Mailbox | undefined {
  return mailboxes.find((m) => m.role === role);
}

export interface MailboxNode extends Mailbox {
  children: MailboxNode[];
  depth: number;
  path: string;
}

/** Construit l'arbre des dossiers (trié par sortOrder puis nom). */
export function mailboxTree(mailboxes: Mailbox[]): MailboxNode[] {
  const byId = new Map<Id, MailboxNode>();
  for (const m of mailboxes) byId.set(m.id, { ...m, children: [], depth: 0, path: m.name });
  const roots: MailboxNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: MailboxNode[], depth: number, prefix: string) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'fr'));
    for (const n of list) {
      n.depth = depth;
      n.path = prefix ? `${prefix}/${n.name}` : n.name;
      sort(n.children, depth + 1, n.path);
    }
  };
  sort(roots, 0, '');
  return roots;
}

/** Aplatit un arbre (parcours en profondeur). */
export function flattenTree(nodes: MailboxNode[]): MailboxNode[] {
  const out: MailboxNode[] = [];
  const walk = (list: MailboxNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Tous les descendants d'un dossier. */
export function descendantIds(mailboxes: Mailbox[], id: Id): Id[] {
  const out: Id[] = [];
  const walk = (pid: Id) => {
    for (const m of mailboxes) if (m.parentId === pid) {
      out.push(m.id);
      walk(m.id);
    }
  };
  walk(id);
  return out;
}

export function formatAddress(a: EmailAddress): string {
  if (!a.name || a.name === a.email) return a.email;
  const needsQuotes = /[",;<>@()[\]\\:]/.test(a.name);
  return needsQuotes ? `"${a.name.replace(/"/g, '\\"')}" <${a.email}>` : `${a.name} <${a.email}>`;
}

/** Analyse une liste d'adresses « Nom <a@b.c>, d@e.f ». */
export function parseAddressList(input: string): EmailAddress[] {
  const out: EmailAddress[] = [];
  const parts = input.match(/("[^"]*"|[^,;])+/g) ?? [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const m = p.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) out.push({ name: m[1]?.trim() || null, email: (m[2] ?? '').trim() });
    else out.push({ name: null, email: p });
  }
  return out;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);
}

const RE_PREFIX = /^\s*((re|r|aw|sv|antw|ré|tr|fw|fwd|wg)\s*(\[\d+\])?\s*:\s*)+/i;

export function stripSubjectPrefixes(subject: string | null | undefined): string {
  return (subject ?? '').replace(RE_PREFIX, '').trim();
}

export function replySubject(subject: string | null | undefined): string {
  const s = stripSubjectPrefixes(subject);
  return `Re: ${s}`;
}

export function forwardSubject(subject: string | null | undefined): string {
  const s = stripSubjectPrefixes(subject);
  return `Fwd: ${s}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Conversion HTML → texte brut minimaliste (isomorphe, sans DOM). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, txt: string) =>
      txt.replace(/<[^>]+>/g, '').trim() === href ? href : `${txt} <${href}>`,
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export interface ComposeAttachment {
  blobId: Id;
  name: string;
  type: string;
  size: number;
  cid?: string | null;
  disposition?: 'attachment' | 'inline';
}

export interface BuildEmailInput {
  mailboxIds: Record<Id, boolean>;
  keywords?: Record<string, boolean>;
  from: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[] | null;
  subject: string;
  html?: string;
  text?: string;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  attachments?: ComposeAttachment[];
  sentAt?: string;
  extraHeaders?: Record<string, string>;
}

/** Construit un objet de création Email (multipart/alternative texte + HTML, pièces jointes). */
export function buildEmail(input: BuildEmailInput): EmailCreate {
  const html = input.html ?? (input.text != null ? textToHtml(input.text) : '');
  const text = input.text ?? htmlToText(html);
  const email: EmailCreate = {
    mailboxIds: input.mailboxIds,
    keywords: input.keywords ?? {},
    subject: input.subject,
    sentAt: input.sentAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    bodyValues: {
      text: { value: text },
      html: { value: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>` },
    },
    textBody: [{ partId: 'text', type: 'text/plain' }],
    htmlBody: [{ partId: 'html', type: 'text/html' }],
  };
  // Certains serveurs (Stalwart) refusent `null` à la création : on omet les champs vides.
  if (input.from?.length) email.from = input.from;
  if (input.to?.length) email.to = input.to;
  if (input.cc?.length) email.cc = input.cc;
  if (input.bcc?.length) email.bcc = input.bcc;
  if (input.replyTo?.length) email.replyTo = input.replyTo;
  if (input.inReplyTo?.length) email.inReplyTo = input.inReplyTo;
  if (input.references?.length) email.references = input.references;
  if (input.attachments?.length) {
    email.attachments = input.attachments.map((a) => ({
      blobId: a.blobId,
      name: a.name,
      type: a.type || 'application/octet-stream',
      size: a.size,
      disposition: a.disposition ?? (a.cid ? 'inline' : 'attachment'),
      cid: a.cid ?? null,
    }));
  }
  if (input.extraHeaders) {
    for (const [k, v] of Object.entries(input.extraHeaders)) email[`header:${k}:asText`] = v;
  }
  return email;
}

/** Échappe un segment de chemin JSON Pointer (pour les patchs `mailboxIds/<id>`). */
export function pointerEscape(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Patch de déplacement d'un email d'un dossier à un autre. */
export function movePatch(from: Id | null, to: Id): Record<string, unknown> {
  const p: Record<string, unknown> = { [`mailboxIds/${pointerEscape(to)}`]: true };
  if (from && from !== to) p[`mailboxIds/${pointerEscape(from)}`] = null;
  return p;
}

export function keywordPatch(keyword: string, value: boolean): Record<string, unknown> {
  return { [`keywords/${pointerEscape(keyword)}`]: value ? true : null };
}
