import { escapeHtml, forwardSubject, formatAddress, replySubject, type Email, type EmailAddress, type Identity } from '@voxel/jmap';
import { queryClient } from '@/lib/queryClient';
import { accountsQuery, bodyHtml, bodyText, type ThreadItem } from '@/lib/mail';
import { ALL, useUi } from '@/store/ui';
import { getNav } from '@/nav/nav';
import { parseMailto } from '@/nav/model';
import { longDate, displayName } from '@/lib/format';
import { sanitizeForQuote, plainToHtml } from '@/lib/sanitize';
import type { Account } from '@/lib/api';
import { db } from '@/lib/db';
import i18n from '@/i18n';

function defaultAccountId(): string | undefined {
  const view = getNav().view;
  const accounts = queryClient.getQueryData<Account[]>(accountsQuery.queryKey);
  if (view.accountId !== ALL && accounts?.some((a) => a.id === view.accountId)) return view.accountId;
  return accounts?.[0]?.id;
}

export function startCompose(init: { accountId?: string; to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[]; subject?: string; html?: string } = {}) {
  const accountId = init.accountId ?? defaultAccountId();
  if (!accountId) return;
  useUi.getState().openComposer({
    accountId,
    mode: 'new',
    to: init.to ?? [],
    cc: init.cc ?? [],
    bcc: init.bcc ?? [],
    subject: init.subject ?? '',
    html: init.html ?? '',
    attachments: [],
  });
}

/** Ouvre une adresse mailto: dans une nouvelle fenêtre de rédaction. */
export function startMailto(href: string, accountId?: string) {
  const m = parseMailto(href);
  const addr = (email: string) => ({ name: null, email });
  startCompose({ accountId, to: m.to.map(addr), cc: m.cc.map(addr), bcc: m.bcc.map(addr), subject: m.subject, html: m.body ? plainToHtml(m.body) : '' });
}

function quoteBlock(e: Email): string {
  const html = bodyHtml(e);
  const content = html ? sanitizeForQuote(html) : `<div style="white-space:pre-wrap">${plainToHtml(bodyText(e))}</div>`;
  const who = e.from?.[0] ? formatAddress(e.from[0]) : i18n.t('compose:quote.unknownSender');
  const intro = i18n.t('compose:quote.wrote', { date: longDate(e.sentAt ?? e.receivedAt, false), who });
  return `<p>${escapeHtml(intro)}</p><blockquote type="cite">${content}</blockquote>`;
}

function forwardBlock(e: Email): string {
  const html = bodyHtml(e);
  const content = html ? sanitizeForQuote(html) : `<div style="white-space:pre-wrap">${plainToHtml(bodyText(e))}</div>`;
  const label = (k: string) => escapeHtml(i18n.t(`compose:forwarded.${k}`));
  const line = (k: string, v: string) => (v ? `<b>${label(k)}</b> ${escapeHtml(v)}<br>` : '');
  const list = (a: EmailAddress[] | null) => (a ?? []).map(formatAddress).join(', ');
  return `<p>---------- ${label('header')} ----------<br>${line('from', list(e.from))}${line('date', longDate(e.sentAt ?? e.receivedAt))}${line('subject', e.subject ?? '')}${line('to', list(e.to))}${line('cc', list(e.cc))}</p>${content}`;
}

const lower = (s: string) => s.toLowerCase();

export function startReply(
  e: Email,
  accountId: string,
  mode: 'reply' | 'replyAll' | 'forward',
  opts: { inline?: string; identities?: Identity[]; accountEmail?: string } = {},
) {
  const mine = new Set([...(opts.identities ?? []).map((i) => lower(i.email)), lower(opts.accountEmail ?? '')].filter(Boolean));
  const fromMe = e.from?.some((a) => mine.has(lower(a.email)));
  let to: EmailAddress[] = [];
  let cc: EmailAddress[] = [];
  if (mode !== 'forward') {
    // Répondre à un message envoyé par moi : on reprend ses destinataires
    to = fromMe ? [...(e.to ?? [])] : [...(e.replyTo?.length ? e.replyTo : (e.from ?? []))];
    if (mode === 'replyAll') {
      const all = [...(e.to ?? []), ...(e.cc ?? [])];
      const seen = new Set(to.map((a) => lower(a.email)));
      for (const a of all) {
        const k = lower(a.email);
        if (seen.has(k) || mine.has(k)) continue;
        seen.add(k);
        cc.push(a);
      }
    }
    to = to.filter((a, i, arr) => arr.findIndex((b) => lower(b.email) === lower(a.email)) === i);
    if (!fromMe) to = to.filter((a) => !mine.has(lower(a.email))).length ? to.filter((a) => !mine.has(lower(a.email))) : to;
  }
  // Identité : celle à qui le message a été adressé, si elle existe
  const addressed = [...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? [])].map((a) => lower(a.email));
  const identityId = opts.identities?.find((i) => addressed.includes(lower(i.email)))?.id;
  const refs = [...(e.references ?? []), ...(e.messageId ?? [])];
  useUi.getState().openComposer({
    accountId,
    identityId,
    mode,
    to,
    cc,
    bcc: [],
    subject: mode === 'forward' ? forwardSubject(e.subject) : replySubject(e.subject),
    html: '',
    quoteHtml: mode === 'forward' ? forwardBlock(e) : quoteBlock(e),
    inReplyTo: mode === 'forward' ? null : (e.messageId ?? null),
    references: mode === 'forward' ? null : refs.length ? refs : null,
    replyToEmailId: e.id,
    attachments:
      mode === 'forward'
        ? (e.attachments ?? []).filter((a) => a.blobId).map((a) => ({ blobId: a.blobId!, name: a.name ?? i18n.t('reader:attachments.file'), type: a.type, size: a.size, cid: a.cid, disposition: a.cid ? 'inline' : 'attachment' }))
        : [],
    inline: opts.inline ? { threadKey: opts.inline } : undefined,
  });
}

/**
 * Transfert en pièce jointe : le message entier (`message/rfc822`, son `blobId`) est joint
 * à un nouveau message, sans citation.
 */
export function startForwardAsAttachment(e: Email, accountId: string, opts: { identities?: Identity[] } = {}) {
  const addressed = [...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? [])].map((a) => lower(a.email));
  const identityId = opts.identities?.find((i) => addressed.includes(lower(i.email)))?.id;
  // nom de fichier sûr d'après l'objet
  const base = (e.subject ?? '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').slice(0, 80) || i18n.t('compose:forwarded.fileName');
  useUi.getState().openComposer({
    accountId,
    identityId,
    mode: 'forward',
    to: [],
    cc: [],
    bcc: [],
    subject: forwardSubject(e.subject),
    html: '',
    inReplyTo: null,
    references: null,
    replyToEmailId: e.id,
    attachments: [{ blobId: e.blobId, name: `${base}.eml`, type: 'message/rfc822', size: e.size, disposition: 'attachment' }],
  });
}

/** Rouvre un brouillon existant. */
export function openDraft(e: Email, accountId: string, identities?: Identity[]) {
  const html = bodyHtml(e) ?? plainToHtml(bodyText(e));
  const body = html.replace(/^[\s\S]*<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
  const identityId = identities?.find((i) => e.from?.some((f) => lower(f.email) === lower(i.email)))?.id;
  useUi.getState().openComposer({
    accountId,
    identityId,
    mode: 'draft',
    to: e.to ?? [],
    cc: e.cc ?? [],
    bcc: e.bcc ?? [],
    subject: e.subject ?? '',
    html: sanitizeForQuote(body),
    inReplyTo: e.inReplyTo,
    references: e.references,
    attachments: (e.attachments ?? []).filter((a) => a.blobId).map((a) => ({ blobId: a.blobId!, name: a.name ?? i18n.t('reader:attachments.file'), type: a.type, size: a.size, cid: a.cid })),
    draftEmailId: e.id,
    signature: false,
  });
}

export function isDraftThread(t: ThreadItem) {
  return t.draft && t.count === 1;
}

/** Restaure les fenêtres de rédaction non envoyées (après rechargement ou plantage). */
export async function restoreComposers() {
  try {
    const rows = await db.drafts.toArray();
    const ui = useUi.getState();
    for (const r of rows) {
      const d = r.data as Parameters<typeof ui.openComposer>[0] & { id: string };
      if (!d || ui.composers.some((c) => c.id === r.id)) continue;
      ui.openComposer({ ...d, id: r.id, inline: undefined });
      ui.updateComposer(r.id, { minimized: true });
    }
  } catch {
    /* ignore */
  }
}

export { displayName };
