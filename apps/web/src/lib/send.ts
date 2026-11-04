import { buildEmail, pointerEscape, priorityHeaders, type ComposeAttachment, type EmailAddress, type Identity, type Priority } from '@voxel/jmap';
import { getMailboxData, roleId } from './mail';
import { runCalls, type Call } from './outbox';
import { jmap } from './jmap';
import { rememberContacts } from './db';
import { invalidateAccount } from './actions';
import i18n from '@/i18n';

export interface OutgoingMessage {
  accountId: string;
  identity: Identity;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  html: string;
  attachments: ComposeAttachment[];
  inReplyTo?: string[] | null;
  references?: string[] | null;
  /** brouillon existant à supprimer après envoi */
  draftEmailId?: string;
  /** envoi programmé (ISO) */
  sendAt?: string;
  /** priorité */
  priority?: Priority;
  /** accusé de lecture demandé */
  requestReceipt?: boolean;
}

/** En-têtes optionnels : priorité et demande d'accusé de lecture (adressée à l'identité d'envoi). */
export function optionalHeaders(identity: Identity | undefined, o: { priority?: Priority; requestReceipt?: boolean }): Record<string, string> | undefined {
  const h: Record<string, string> = { ...priorityHeaders(o.priority) };
  if (o.requestReceipt && identity) h['Disposition-Notification-To'] = identity.email;
  return Object.keys(h).length ? h : undefined;
}

function fromOf(identity: Identity): EmailAddress[] {
  return [{ name: identity.name || null, email: identity.email }];
}

/** Envoie (ou met en file hors ligne) un message. */
export async function submitMessage(m: OutgoingMessage): Promise<{ queued: boolean }> {
  const data = await getMailboxData(m.accountId);
  const aid = data.jmapAccountId;
  const drafts = roleId(data, 'drafts');
  const sent = roleId(data, 'sent');
  if (!drafts) throw new Error(i18n.t('compose:errors.noDrafts'));
  const email = buildEmail({
    mailboxIds: { [drafts]: true },
    keywords: { $draft: true, $seen: true },
    from: fromOf(m.identity),
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    replyTo: m.identity.replyTo,
    subject: m.subject,
    html: m.html,
    attachments: m.attachments,
    inReplyTo: m.inReplyTo ?? null,
    references: m.references ?? null,
    extraHeaders: optionalHeaders(m.identity, m),
  });
  const rcpt = [...m.to, ...m.cc, ...m.bcc, ...(m.identity.bcc ?? [])].map((a) => ({ email: a.email }));
  const onSuccess: Record<string, unknown> = { 'keywords/$draft': null };
  if (sent && sent !== drafts) {
    onSuccess[`mailboxIds/${pointerEscape(drafts)}`] = null;
    onSuccess[`mailboxIds/${pointerEscape(sent)}`] = true;
  }
  const calls: Call[] = [
    ['Email/set', { accountId: aid, create: { msg: email }, ...(m.draftEmailId ? { destroy: [m.draftEmailId] } : {}) }],
    [
      'EmailSubmission/set',
      {
        accountId: aid,
        create: {
          sub: {
            identityId: m.identity.id,
            emailId: '#msg',
            envelope: {
              mailFrom: { email: m.identity.email, parameters: m.sendAt ? { HOLDUNTIL: m.sendAt.replace(/\.\d{3}Z$/, 'Z') } : null },
              rcptTo: rcpt,
            },
          },
        },
        onSuccessUpdateEmail: { '#sub': onSuccess },
      },
    ],
  ];
  const r = await runCalls(m.accountId, calls, { kind: 'send', label: i18n.t('compose:outbox.send', { subject: m.subject || i18n.t('mail:noSubject') }) });
  void rememberContacts([...m.to, ...m.cc, ...m.bcc].map((a) => ({ email: a.email, name: a.name })), 3);
  invalidateAccount(m.accountId, 800);
  return { queued: r.queued };
}

export interface DraftInput {
  accountId: string;
  identity: Identity | undefined;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  html: string;
  attachments: ComposeAttachment[];
  inReplyTo?: string[] | null;
  references?: string[] | null;
  previousDraftId?: string;
  priority?: Priority;
  requestReceipt?: boolean;
}

/** Enregistre un brouillon dans le dossier Brouillons (remplace le précédent). */
export async function saveDraft(d: DraftInput): Promise<string | undefined> {
  const data = await getMailboxData(d.accountId);
  const drafts = roleId(data, 'drafts');
  if (!drafts) return undefined;
  const email = buildEmail({
    mailboxIds: { [drafts]: true },
    keywords: { $draft: true, $seen: true },
    from: d.identity ? fromOf(d.identity) : [],
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    html: d.html,
    attachments: d.attachments,
    inReplyTo: d.inReplyTo ?? null,
    references: d.references ?? null,
    extraHeaders: optionalHeaders(d.identity, d),
  });
  const r = await runCalls(
    d.accountId,
    [['Email/set', { accountId: data.jmapAccountId, create: { d: email }, ...(d.previousDraftId ? { destroy: [d.previousDraftId] } : {}) }]],
    { kind: 'other', label: i18n.t('compose:outbox.draft') },
  );
  if (r.queued || !r.responses) return d.previousDraftId;
  const body = r.responses[0]?.[1] as { created?: Record<string, { id: string }> } | undefined;
  invalidateAccount(d.accountId, 1500);
  return body?.created?.d?.id;
}

export async function destroyDraft(accountId: string, emailId: string) {
  const data = await getMailboxData(accountId);
  await runCalls(accountId, [['Email/set', { accountId: data.jmapAccountId, destroy: [emailId] }]], { kind: 'delete', label: i18n.t('compose:outbox.draftDeleted') });
  invalidateAccount(accountId, 500);
}

export async function uploadAttachment(accountId: string, file: File): Promise<ComposeAttachment> {
  const data = await getMailboxData(accountId);
  const r = await jmap(accountId).upload(data.jmapAccountId, file, file.type || 'application/octet-stream');
  return { blobId: r.blobId, name: file.name, type: r.type || file.type, size: r.size ?? file.size };
}
