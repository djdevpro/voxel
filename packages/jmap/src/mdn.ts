/**
 * Accusé de lecture (Message Disposition Notification, RFC 8098), construit côté client.
 * Le message produit est un `multipart/report; report-type=disposition-notification` complet (CRLF),
 * à téléverser puis importer (`Email/import`) et envoyer (`EmailSubmission/set`). Module pur.
 */
import { angle, encodeWord, headerAddress, rfc5322Date, utf8ToBase64, wrapBase64 } from './mime-util.ts';

export interface MdnInput {
  /** Expéditeur de l'accusé (l'identité qui a reçu le message). */
  from: { name?: string | null; email: string };
  /** Adresse de `Disposition-Notification-To` du message lu. */
  to: { name?: string | null; email: string };
  /** Objet de l'accusé (déjà traduit, ex. « Lu : <objet> »). */
  subject: string;
  /** Texte lisible (déjà traduit). */
  text: string;
  /** Message-ID du message lu (sans chevrons), s'il en a un. */
  originalMessageId?: string | null;
  /** Destinataire final (adresse de l'identité). */
  finalRecipient: string;
  /** `manual` : l'utilisateur a cliqué Envoyer ; `automatic` : réglage « toujours envoyer ». */
  mode: 'manual' | 'automatic';
  /** Nom de l'agent (Reporting-UA). */
  reportingUa?: string;
  date?: Date;
  /** Identifiant aléatoire (Message-ID et frontière). */
  uid?: string;
}

/** Champ `Disposition` (RFC 8098 §3.2.6). */
export function mdnDisposition(mode: 'manual' | 'automatic'): string {
  return mode === 'manual' ? 'manual-action/MDN-sent-manually; displayed' : 'automatic-action/MDN-sent-automatically; displayed';
}

function randomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** Message MDN brut (RFC 5322, lignes CRLF). */
export function buildMdn(m: MdnInput): string {
  const uid = m.uid ?? randomId();
  const domain = m.from.email.split('@')[1] || 'localhost';
  const boundary = `voxel-mdn-${uid}`;
  const date = m.date ?? new Date();
  const headers = [
    `From: ${headerAddress(m.from)}`,
    `To: ${headerAddress(m.to)}`,
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${rfc5322Date(date)}`,
    `Message-ID: <${uid}@${domain}>`,
    ...(m.originalMessageId ? [`In-Reply-To: ${angle(m.originalMessageId)}`, `References: ${angle(m.originalMessageId)}`] : []),
    // RFC 3834 : message généré, à ne pas faire suivre d'une réponse automatique
    `Auto-Submitted: ${m.mode === 'manual' ? 'auto-replied' : 'auto-generated'}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
  ];
  const report = [
    `Reporting-UA: ${m.reportingUa ?? 'Voxel'}`,
    `Final-Recipient: rfc822;${m.finalRecipient}`,
    ...(m.originalMessageId ? [`Original-Message-ID: ${angle(m.originalMessageId)}`] : []),
    `Disposition: ${mdnDisposition(m.mode)}`,
  ];
  return [
    ...headers,
    '',
    'This is a MIME-encapsulated message.',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(utf8ToBase64(m.text)),
    '',
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    '',
    ...report,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
