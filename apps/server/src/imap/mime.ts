/**
 * MIME : analyse des en-têtes bruts, décodage (mots encodés, transfert, jeux de caractères),
 * conversion BODYSTRUCTURE → parties JMAP (RFC 8621 §4.1.4), fabrication du MIME (MailComposer).
 */
import type { MessageStructureObject } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';

// ------------------------------------------------------------------ jeux de caractères

export function decodeCharset(buf: Buffer, charset: string | undefined): string {
  const cs = (charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  const label = cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs;
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

export function decodeQuotedPrintable(input: string | Buffer, header = false): Buffer {
  const s = typeof input === 'string' ? input : input.toString('latin1');
  const src = header ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '=' && i + 2 < src.length + 0 && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(src.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/** Décode le contenu d'une partie selon son Content-Transfer-Encoding. `partial` : contenu tronqué. */
export function decodeTransfer(raw: Buffer, encoding: string | undefined, partial = false): Buffer {
  const enc = (encoding || '7bit').toLowerCase();
  if (enc === 'base64') {
    let s = raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    if (partial) s = s.slice(0, s.length - (s.length % 4));
    return Buffer.from(s, 'base64');
  }
  if (enc === 'quoted-printable') {
    let s = raw.toString('latin1');
    if (partial) s = s.replace(/=[0-9A-Fa-f]?$/, '');
    return decodeQuotedPrintable(s);
  }
  return raw;
}

/** Décode les mots encodés RFC 2047 d'une valeur d'en-tête. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[QqBb]\?[^?]*\?=)\s+(?==\?[^?]+\?[QqBb]\?[^?]*\?=)/g, '$1')
    .replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
      const charset = cs.split('*')[0];
      const buf = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : decodeQuotedPrintable(text, true);
      return decodeCharset(buf, charset);
    });
}

// ------------------------------------------------------------------ en-têtes bruts

export interface RawHeader {
  name: string;
  value: string; // valeur brute, dépliée, sans le nom
}

/** Analyse un bloc d'en-têtes (renvoyé par FETCH BODY[HEADER.FIELDS]) en liste ordonnée. */
export function parseHeaderBlock(buf: Buffer | string | undefined): RawHeader[] {
  if (!buf) return [];
  const text = (typeof buf === 'string' ? buf : buf.toString('utf8')).replace(/\r\n/g, '\n');
  const out: RawHeader[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out;
}

export function headerValues(headers: RawHeader[], name: string): string[] {
  const low = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === low).map((h) => h.value);
}

export function parseMessageIds(value: string | undefined | null): string[] | null {
  if (!value) return null;
  const ids = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);
  if (ids.length) return ids;
  const bare = value.trim().split(/\s+/).filter((x) => x.includes('@'));
  return bare.length ? bare : null;
}

export function parseUrls(value: string): string[] | null {
  const urls = [...value.matchAll(/<([^<>]+)>/g)].map((m) => m[1]!.replace(/\s+/g, ''));
  return urls.length ? urls : null;
}

export interface JmapAddress {
  name: string | null;
  email: string;
}

/** Analyse simple d'une liste d'adresses (en-tête brut). */
export function parseAddresses(value: string): JmapAddress[] | null {
  const decoded = decodeWords(value);
  const parts = decoded.match(/("[^"]*"|<[^>]*>|[^,])+/g) ?? [];
  const out: JmapAddress[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const m = p.match(/^(.*?)<([^>]+)>\s*$/);
    if (m) out.push({ name: m[1]!.trim().replace(/^"|"$/g, '').trim() || null, email: m[2]!.trim() });
    else out.push({ name: null, email: p.replace(/^"|"$/g, '') });
  }
  return out.length ? out : null;
}

/** Valeur d'une propriété `header:Name[:asForm][:all]` à partir des en-têtes bruts. */
export function headerProperty(headers: RawHeader[], prop: string): unknown {
  const parts = prop.split(':');
  const name = parts[1] ?? '';
  let form = 'asRaw';
  let all = false;
  for (const p of parts.slice(2)) {
    if (p === 'all') all = true;
    else if (p) form = p;
  }
  const values = headerValues(headers, name);
  const conv = (v: string): unknown => {
    switch (form) {
      case 'asText':
        return decodeWords(v).replace(/\s+/g, ' ').trim();
      case 'asURLs':
        return parseUrls(v);
      case 'asAddresses':
        return parseAddresses(v);
      case 'asGroupedAddresses': {
        const a = parseAddresses(v);
        return a ? [{ name: null, addresses: a }] : null;
      }
      case 'asMessageIds':
        return parseMessageIds(v);
      case 'asDate': {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
      }
      default:
        return ` ${v}`;
    }
  };
  if (all) return values.map(conv);
  const last = values[values.length - 1];
  return last === undefined ? null : conv(last);
}

export function headerNameOf(prop: string): string | null {
  if (!prop.startsWith('header:')) return null;
  return prop.split(':')[1]?.toLowerCase() || null;
}

// ------------------------------------------------------------------ structure → parties JMAP

export interface BodyPart {
  partId: string | null;
  blobId: string | null;
  size: number;
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  encoding: string | null;
  subParts: BodyPart[] | null;
}

function decodedSize(n: MessageStructureObject): number {
  const size = n.size ?? 0;
  return (n.encoding ?? '').toLowerCase() === 'base64' ? Math.floor((size * 3) / 4) : size;
}

/** Convertit l'arbre BODYSTRUCTURE d'imapflow en arbre EmailBodyPart (blobId = `<emailId>.<partId>`). */
export function structureToPart(node: MessageStructureObject, emailId: string, isRoot = true): BodyPart {
  const type = (node.type || 'text/plain').toLowerCase();
  const multipart = type.startsWith('multipart/');
  const partId = multipart ? null : node.part || (isRoot ? '1' : null);
  const params = node.parameters ?? {};
  const dparams = node.dispositionParameters ?? {};
  const rawName = dparams.filename ?? params.name ?? null;
  const name = rawName ? decodeWords(rawName) : null;
  const charset = type.startsWith('text/') ? (params.charset ?? 'us-ascii') : (params.charset ?? null);
  return {
    partId,
    blobId: partId ? `${emailId}.${partId}` : null,
    size: multipart ? 0 : decodedSize(node),
    name,
    type,
    charset,
    disposition: node.disposition ? node.disposition.toLowerCase() : null,
    cid: node.id ? node.id.replace(/^<|>$/g, '') : null,
    language: node.language ?? null,
    location: node.location ?? null,
    encoding: node.encoding ?? null,
    subParts: multipart ? (node.childNodes ?? []).map((c) => structureToPart(c, emailId, false)) : null,
  };
}

const isInlineMedia = (t: string) => t.startsWith('image/') || t.startsWith('audio/') || t.startsWith('video/');

/** Algorithme RFC 8621 §4.1.4 : textBody, htmlBody, attachments. */
export function splitBody(root: BodyPart): { textBody: BodyPart[]; htmlBody: BodyPart[]; attachments: BodyPart[] } {
  const textBody: BodyPart[] = [];
  const htmlBody: BodyPart[] = [];
  const attachments: BodyPart[] = [];
  const parse = (parts: BodyPart[], multipartType: string, inAlternative: boolean, html: BodyPart[] | null, text: BodyPart[] | null) => {
    const textLength = text ? text.length : -1;
    const htmlLength = html ? html.length : -1;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isMultipart = part.type.startsWith('multipart/');
      const isInline =
        part.disposition !== 'attachment' &&
        (part.type === 'text/plain' || part.type === 'text/html' || isInlineMedia(part.type)) &&
        (i === 0 || (multipartType !== 'related' && (isInlineMedia(part.type) || !part.name)));
      if (isMultipart) {
        const sub = part.type.split('/')[1] ?? 'mixed';
        parse(part.subParts ?? [], sub, inAlternative || sub === 'alternative', html, text);
      } else if (isInline) {
        if (multipartType === 'alternative') {
          if (part.type === 'text/plain') text?.push(part);
          else if (part.type === 'text/html') html?.push(part);
          else attachments.push(part);
          continue;
        } else if (inAlternative) {
          if (part.type === 'text/plain') html = null;
          if (part.type === 'text/html') text = null;
        }
        if (text) text.push(part);
        if (html) html.push(part);
        if ((!text || !html) && isInlineMedia(part.type)) attachments.push(part);
      } else {
        attachments.push(part);
      }
    }
    if (multipartType === 'alternative' && text && html) {
      if (textLength === text.length && htmlLength !== html.length) for (let i = htmlLength; i < html.length; i++) text.push(html[i]!);
      if (htmlLength === html.length && textLength !== text.length) for (let i = textLength; i < text.length; i++) html.push(text[i]!);
    }
  };
  parse([root], 'mixed', false, htmlBody, textBody);
  return { textBody, htmlBody, attachments };
}

export function hasRealAttachment(attachments: BodyPart[]): boolean {
  return attachments.some((p) => p.disposition === 'attachment' || (!!p.name && !p.cid) || (!p.type.startsWith('image/') && !p.cid));
}

export function findPart(root: BodyPart, partId: string): BodyPart | undefined {
  if (root.partId === partId) return root;
  for (const s of root.subParts ?? []) {
    const f = findPart(s, partId);
    if (f) return f;
  }
  return undefined;
}

// ------------------------------------------------------------------ texte

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*$/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&');
}

export function makePreview(text: string, isHtml: boolean): string {
  const t = (isHtml ? htmlToText(text) : text).replace(/\s+/g, ' ').trim();
  return t.length > 256 ? `${t.slice(0, 255)}…` : t;
}

// ------------------------------------------------------------------ fabrication du MIME

export interface ComposeInput {
  from?: JmapAddress[] | null;
  to?: JmapAddress[] | null;
  cc?: JmapAddress[] | null;
  bcc?: JmapAddress[] | null;
  replyTo?: JmapAddress[] | null;
  sender?: JmapAddress[] | null;
  subject?: string | null;
  sentAt?: string | null;
  messageId?: string | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  text?: string | null;
  html?: string | null;
  attachments: Array<{ filename: string | null; content: Buffer; contentType: string; cid?: string | null; inline: boolean }>;
  headers: Record<string, string>;
}

const addr = (list: JmapAddress[] | null | undefined): Mail.Address[] | undefined =>
  list?.length ? list.map((a) => ({ name: a.name ?? '', address: a.email })) : undefined;

const msgIds = (ids: string[] | null | undefined): string | undefined => (ids?.length ? ids.map((i) => `<${i.replace(/^<|>$/g, '')}>`).join(' ') : undefined);

/** Construit la source RFC 5322 (Bcc conservé : c'est un brouillon ; il est retiré à l'envoi). */
export async function composeMime(input: ComposeInput): Promise<Buffer> {
  const mail: Mail.Options = {
    from: addr(input.from)?.[0],
    sender: addr(input.sender)?.[0],
    to: addr(input.to),
    cc: addr(input.cc),
    bcc: addr(input.bcc),
    replyTo: addr(input.replyTo),
    subject: input.subject ?? '',
    date: input.sentAt ? new Date(input.sentAt) : new Date(),
    inReplyTo: msgIds(input.inReplyTo),
    references: msgIds(input.references),
    headers: input.headers,
    attachments: input.attachments.map((a) => ({
      filename: a.filename ?? undefined,
      content: a.content,
      contentType: a.contentType,
      cid: a.cid ?? undefined,
      contentDisposition: a.inline ? 'inline' : 'attachment',
    })),
  };
  if (input.from && input.from.length > 1) mail.from = addr(input.from)!.map((a) => (typeof a === 'string' ? a : `${a.name} <${a.address}>`)).join(', ');
  if (input.messageId) mail.messageId = `<${input.messageId.replace(/^<|>$/g, '')}>`;
  if (input.text != null) mail.text = input.text;
  if (input.html != null) mail.html = input.html;
  const node = new MailComposer(mail).compile();
  (node as unknown as { keepBcc: boolean }).keepBcc = true;
  return node.build();
}

/** Retire les en-têtes Bcc d'une source RFC 5322 avant envoi SMTP. */
export function stripBcc(raw: Buffer): Buffer {
  const text = raw.toString('latin1');
  const m = /\r?\n\r?\n/.exec(text);
  const end = m ? m.index : text.length;
  const head = text.slice(0, end);
  const lines = head.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (/^[ \t]/.test(l)) {
      if (!skipping) kept.push(l);
      continue;
    }
    skipping = /^bcc\s*:/i.test(l);
    if (!skipping) kept.push(l);
  }
  return Buffer.concat([Buffer.from(kept.join('\r\n'), 'latin1'), Buffer.from(text.slice(end), 'latin1')]);
}
