/**
 * Accusés de lecture. À la lecture d'un message qui porte `Disposition-Notification-To`,
 * l'accusé RFC 8098 est construit côté client (`buildMdn`, `@voxel/jmap`), téléversé, importé dans Brouillons
 * (`Email/import`) puis envoyé (`EmailSubmission/set`, copie supprimée après l'envoi). Le message lu reçoit
 * le mot-clé `$mdnsent` (RFC 3503) : la question n'est plus posée, sur aucun appareil.
 */
import { buildMdn, keywordPatch, type Email, type EmailAddress, type Identity } from '@voxel/jmap';
import { getMailboxData, roleId } from './mail';
import { jmap } from './jmap';
import { runCalls } from './outbox';
import { invalidateAccount } from './actions';
import { longDate } from './format';
import i18n from '@/i18n';

/** Propriété JMAP de l'en-tête de demande d'accusé. */
export const DNT_PROPERTY = 'header:Disposition-Notification-To:asAddresses';
export const MDN_SENT_KEYWORD = '$mdnsent';

/** Adresse à qui renvoyer l'accusé, si le message en demande un. */
export function receiptRequestedBy(e: Email): EmailAddress | null {
  const v = e[DNT_PROPERTY as `header:${string}`] as EmailAddress[] | null | undefined;
  const a = Array.isArray(v) ? v.find((x) => x?.email) : undefined;
  return a ?? null;
}

/** Déjà traité (accusé envoyé ou ignoré) ? Les mots-clés JMAP sont insensibles à la casse. */
export function receiptHandled(e: Email): boolean {
  return Object.keys(e.keywords ?? {}).some((k) => k.toLowerCase() === MDN_SENT_KEYWORD);
}

/** Identité destinataire du message (celle à qui il a été adressé), sinon la première. */
export function receivingIdentity(e: Email, identities: Identity[] | undefined): Identity | undefined {
  const addressed = [...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? [])].map((a) => a.email.toLowerCase());
  return identities?.find((i) => addressed.includes(i.email.toLowerCase())) ?? identities?.[0];
}

/** Marque la demande comme traitée sans envoyer d'accusé (« Ignorer »). */
export async function dismissReceipt(accountId: string, e: Email): Promise<void> {
  const data = await getMailboxData(accountId);
  await runCalls(accountId, [['Email/set', { accountId: data.jmapAccountId, update: { [e.id]: keywordPatch(MDN_SENT_KEYWORD, true) } }]], {
    kind: 'keywords',
    label: i18n.t('reader:receipt.outboxIgnore'),
  });
  invalidateAccount(accountId, 300);
}

/** Construit et envoie l'accusé de lecture d'un message. Nécessite le réseau (téléversement du message). */
export async function sendReceipt(accountId: string, e: Email, identity: Identity, mode: 'manual' | 'automatic'): Promise<void> {
  const to = receiptRequestedBy(e);
  if (!to) return;
  const data = await getMailboxData(accountId);
  const aid = data.jmapAccountId;
  const box = roleId(data, 'drafts') ?? roleId(data, 'sent');
  if (!box) throw new Error(i18n.t('compose:errors.noDrafts'));
  const subject = e.subject ?? '';
  const raw = buildMdn({
    from: { name: identity.name || null, email: identity.email },
    to,
    subject: i18n.t('reader:receipt.subject', { subject }),
    text: i18n.t('reader:receipt.body', { subject, date: longDate(e.sentAt ?? e.receivedAt), to: identity.email, read: longDate(new Date().toISOString()) }),
    originalMessageId: e.messageId?.[0] ?? null,
    finalRecipient: identity.email,
    mode,
    reportingUa: `${location.host}; Voxel`,
  });
  const c = jmap(accountId);
  const blob = await c.upload(aid, new Blob([raw], { type: 'message/rfc822' }), 'message/rfc822');
  await runCalls(
    accountId,
    [
      ['Email/import', { accountId: aid, emails: { mdn: { blobId: blob.blobId, mailboxIds: { [box]: true }, keywords: { $seen: true } } } }],
      [
        'EmailSubmission/set',
        {
          accountId: aid,
          create: {
            s: {
              identityId: identity.id,
              emailId: '#mdn',
              envelope: { mailFrom: { email: identity.email, parameters: null }, rcptTo: [{ email: to.email, parameters: null }] },
            },
          },
          // l'accusé n'est pas gardé dans la boîte (comme Roundcube)
          onSuccessDestroyEmail: ['#s'],
        },
      ],
      ['Email/set', { accountId: aid, update: { [e.id]: keywordPatch(MDN_SENT_KEYWORD, true) } }],
    ],
    { kind: 'send', label: i18n.t('reader:receipt.outboxSend', { subject }) },
  );
  invalidateAccount(accountId, 800);
}
