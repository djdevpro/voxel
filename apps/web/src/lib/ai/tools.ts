/**
 * Outils de l'assistant : recherche (celle de la liste, via des chips), lecture d'un fil en Markdown, contacts,
 * ouverture d'un brouillon (un par réponse), carte d'une conversation. Aucun outil n'envoie de message ni
 * n'ouvre un e-mail à la place de l'utilisateur.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { cardDisplayName, isValidEmail, type EmailAddress } from '@voxel/jmap';
import type { Account } from '@/lib/api';
import { db } from '@/lib/db';
import { accountsQuery, fetchUnifiedPage, threadQuery, type ListSpec } from '@/lib/mail';
import { queryClient } from '@/lib/queryClient';
import { NO_QUICK } from '@/nav/model';
import { getNav } from '@/nav/nav';
import { ALL } from '@/store/ui';
import { startCompose } from '@/components/compose/startCompose';
import { emailToMarkdown, formatAddress, localDateTime, truncateText } from './markdown';
import { refFor, resolveRef } from './refs';
import { markdownToHtml } from './render';
import { chipsOf } from './searchQuery';

export const searchEmailsInput = z.object({
  text: z.string().optional().describe('Words to find anywhere: subject, body, names, addresses.'),
  from: z.string().optional().describe('Sender name or address, can be partial, e.g. "max" or "durand".'),
  to: z.string().optional().describe('Recipient name or address, can be partial.'),
  subject: z.string().optional().describe('Words in the subject.'),
  since: z.string().optional().describe('First day included, YYYY-MM-DD.'),
  until: z.string().optional().describe('Last day included, YYYY-MM-DD.'),
  folder: z.enum(['any', 'inbox', 'sent', 'drafts', 'archive', 'junk', 'trash', 'flagged']).optional().describe('Default "any": every folder except spam and trash.'),
  unread: z.boolean().optional(),
  flagged: z.boolean().optional(),
  hasAttachment: z.boolean().optional(),
  mailbox: z.string().optional().describe("Address of one of the user's mailboxes. Default: all mailboxes."),
  limit: z.number().int().min(1).max(25).optional().describe('Default 10.'),
});
export type SearchEmailsInput = z.infer<typeof searchEmailsInput>;

export interface EmailHit {
  ref: string;
  accountId: string;
  accountEmail: string;
  threadId: string;
  emailId: string;
  from: { name: string | null; email: string } | null;
  subject: string;
  preview: string;
  receivedAt: string;
  unread: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  count: number;
}
export interface EmailsResult {
  input: SearchEmailsInput;
  total: number;
  items: EmailHit[];
}
export interface ContactHit {
  name: string | null;
  email: string;
  source: 'contacts' | 'history';
  count: number;
}
export interface ContactsResult {
  query: string;
  items: ContactHit[];
}
export interface ReadResult {
  ref: string;
  subject: string;
  messages: Array<{ from: string; to: string; date: string; markdown: string }>;
}
export interface ComposeResult {
  to: string[];
  subject: string;
}
export type OpenResult = EmailHit;

/** Derniers résultats de recherche par référence, pour `open_email`. */
const hits = new Map<string, EmailHit>();

/** Brouillons ouverts pendant la réponse en cours (un seul autorisé). */
let draftsOpened = 0;

/** Nouvelle réponse de l'assistant : remet à zéro le compteur de brouillons. */
export function resetDraftCount(): void {
  draftsOpened = 0;
}

const accounts = (): Account[] => queryClient.getQueryData<Account[]>(accountsQuery.queryKey) ?? [];

/** Compte dont l'adresse est `email` (insensible à la casse). */
function accountByAddress(email: string | undefined): Account | undefined {
  const low = email?.trim().toLowerCase();
  return low ? accounts().find((a) => a.email.toLowerCase() === low) : undefined;
}

export async function searchEmails(input: SearchEmailsInput): Promise<EmailsResult> {
  const all = accounts();
  const target = input.mailbox ? accountByAddress(input.mailbox) : undefined;
  const list = target ? [target] : all;
  const ids = list.map((a) => a.id);
  if (!ids.length) return { input, total: 0, items: [] };
  const spec: ListSpec = { mailbox: { kind: 'role', role: 'inbox' }, chips: chipsOf(input), text: input.text ?? '', quick: NO_QUICK, sortAsc: false };
  const page = await fetchUnifiedPage(ids, spec, Object.fromEntries(ids.map((a) => [a, 0])));
  const emailOf = new Map(list.map((a) => [a.id, a.email]));
  // brouillons exclus, sauf recherche dans les brouillons
  const items = page.items
    .filter((t) => !t.draft || input.folder === 'drafts')
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, input.limit ?? 10)
    .map((t): EmailHit => {
      const from = t.from ? { name: t.from.name ?? null, email: t.from.email } : null;
      const subject = t.subject;
      const ref = refFor({ accountId: t.accountId, threadId: t.threadId, emailId: t.emailId, subject, from: from ? formatAddress(from) : '', receivedAt: t.receivedAt });
      return {
        ref,
        accountId: t.accountId,
        accountEmail: emailOf.get(t.accountId) ?? '',
        threadId: t.threadId,
        emailId: t.emailId,
        from,
        subject,
        preview: t.preview,
        receivedAt: t.receivedAt,
        unread: t.unread,
        flagged: t.flagged,
        hasAttachment: t.hasAttachment,
        count: t.count,
      };
    });
  for (const h of items) hits.set(h.ref, h);
  const total = Object.values(page.totals).reduce((n, x) => n + x, 0);
  return { input, total, items };
}

/** Minuscules, sans accents. */
function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** 2 : un mot du nom ou la partie locale commence par la requête ; 1 : la contient ; 0 : exclu. */
function score(q: string, name: string | null, email: string): number {
  const n = normalize(name ?? '');
  const local = normalize(email.split('@')[0] ?? '');
  const words = n.split(/[\s.,'’-]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q)) || local.startsWith(q) || n.startsWith(q)) return 2;
  if (n.includes(q) || normalize(email).includes(q)) return 1;
  return 0;
}

const ADDRESS = /[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+/;
const QUOTES_BRACKETS = /[<>"']/g;

export async function findContacts(query: string, limit = 8): Promise<ContactsResult> {
  const address = ADDRESS.exec(query)?.[0].toLowerCase();
  const q = normalize(query.replace(QUOTES_BRACKETS, ' '));
  if (!q && !address) return { query, items: [] };
  const own = new Set(accounts().map((a) => a.email.toLowerCase()));
  const [history, cards] = await Promise.all([db.contacts.toArray(), db.cards.toArray()]);
  const counts = new Map(history.map((c) => [c.email.toLowerCase(), c.count]));
  // « Nom <adresse> » : on cherche l'adresse exacte ; inconnue, elle est renvoyée telle quelle
  if (address) {
    for (const row of cards) {
      if (row.emails.some((e) => e.toLowerCase() === address)) {
        return { query, items: [{ name: cardDisplayName(row.card) || null, email: address, source: 'contacts', count: counts.get(address) ?? 0 }] };
      }
    }
    const known = history.find((c) => c.email.toLowerCase() === address);
    if (known) return { query, items: [{ name: known.name, email: address, source: 'history', count: known.count }] };
    const name = query.replace(ADDRESS, '').replace(QUOTES_BRACKETS, '').replace(/\s+/g, ' ').trim() || null;
    return { query, items: [{ name, email: address, source: 'history', count: 0 }] };
  }
  const found = new Map<string, ContactHit & { score: number }>();
  // carnets d'abord : à adresse égale, la fiche de contact l'emporte sur l'historique
  for (const row of cards) {
    const name = cardDisplayName(row.card) || null;
    for (const raw of row.emails) {
      const email = raw.toLowerCase();
      if (own.has(email) || found.has(email)) continue;
      const s = score(q, name, email);
      if (s) found.set(email, { name, email, source: 'contacts', count: counts.get(email) ?? 0, score: s });
    }
  }
  for (const c of history) {
    const email = c.email.toLowerCase();
    if (own.has(email) || found.has(email)) continue;
    const s = score(q, c.name, email);
    if (s) found.set(email, { name: c.name, email, source: 'history', count: c.count, score: s });
  }
  const items = [...found.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, limit)
    .map(({ score: _s, ...hit }) => hit);
  return { query, items };
}

const READ_MESSAGES = 6;
const READ_TOTAL = 14_000;

export async function readThread(ref: string): Promise<ReadResult> {
  const hit = resolveRef(ref);
  if (!hit) throw new Error(`Unknown reference ${ref}: use a reference returned by search_emails.`);
  const data = await queryClient.fetchQuery(threadQuery(hit.accountId, hit.threadId));
  const emails = data.emails.slice(-READ_MESSAGES);
  const messages = emails.map((e) => ({
    from: (e.from ?? []).map(formatAddress).join(', '),
    to: [...(e.to ?? []), ...(e.cc ?? [])].map(formatAddress).join(', '),
    date: localDateTime(e.receivedAt),
    markdown: emailToMarkdown(e, { maxChars: 4000, headers: false }),
  }));
  // borne totale : on raccourcit d'abord les plus anciens
  let excess = messages.reduce((n, m) => n + m.markdown.length, 0) - READ_TOTAL;
  for (const m of messages) {
    if (excess <= 0) break;
    const keep = Math.max(200, m.markdown.length - excess);
    if (keep < m.markdown.length) {
      excess -= m.markdown.length - keep;
      m.markdown = truncateText(m.markdown, keep);
    }
  }
  return { ref: hit.ref, subject: emails[emails.length - 1]?.subject ?? hit.subject, messages };
}

const addressInput = z.object({ email: z.string(), name: z.string().optional() });

function toAddresses(list: Array<z.infer<typeof addressInput>> | undefined): EmailAddress[] {
  return (list ?? []).map((a) => {
    const email = a.email.trim();
    if (!isValidEmail(email)) throw new Error(`Invalid email address: ${a.email}`);
    return { email, name: a.name?.trim() || null };
  });
}

export function createChatTools() {
  return {
    search_emails: tool({
      description: "Search the user's emails. Returns the matching conversations, newest first, with a reference for each.",
      inputSchema: searchEmailsInput,
      execute: (input) => searchEmails(input),
      toModelOutput: ({ output }) => ({
        type: 'json' as const,
        value: {
          total: output.total,
          emails: output.items.map((i) => ({
            ref: i.ref,
            from: i.from ? formatAddress(i.from) : '',
            subject: i.subject,
            date: localDateTime(i.receivedAt),
            preview: i.preview.slice(0, 160),
            unread: i.unread,
            flagged: i.flagged,
            attachments: i.hasAttachment,
            messages: i.count,
            mailbox: i.accountEmail,
          })),
        },
      }),
    }),
    read_email: tool({
      description: 'Read the full content of a conversation, as Markdown. Use a reference returned by search_emails.',
      inputSchema: z.object({ ref: z.string() }),
      execute: ({ ref }) => readThread(ref),
      toModelOutput: ({ output }) => ({
        type: 'json' as const,
        value: { ref: output.ref, subject: output.subject, messages: output.messages.map((m) => ({ ...m })) },
      }),
    }),
    find_contacts: tool({
      description: 'Find people in the user\'s contacts and in the addresses they exchanged email with.',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
      execute: ({ query, limit }) => findContacts(query, limit),
      toModelOutput: ({ output }) => ({ type: 'json' as const, value: output.items.map((c) => ({ ...c })) }),
    }),
    compose_email: tool({
      description: 'Open a new email draft for the user to review. Never sends anything.',
      inputSchema: z.object({
        to: z.array(addressInput).min(1),
        cc: z.array(addressInput).optional(),
        subject: z.string().optional(),
        body: z.string().optional().describe('Markdown, without signature.'),
        mailbox: z.string().optional(),
      }),
      execute: async (input): Promise<ComposeResult> => {
        if (draftsOpened >= 1) throw new Error('Only one draft can be opened per request.');
        const to = toAddresses(input.to);
        const cc = toAddresses(input.cc);
        const view = getNav().view.accountId;
        const accountId = accountByAddress(input.mailbox)?.id ?? (view !== ALL ? view : undefined) ?? accounts()[0]?.id;
        const subject = input.subject ?? '';
        draftsOpened++;
        startCompose({ accountId, to, cc, subject, html: input.body ? markdownToHtml(input.body) : '' });
        return { to: to.map((a) => a.email), subject };
      },
      toModelOutput: ({ output }) => ({ type: 'text' as const, value: `Draft opened for ${output.to.join(', ')}. The user will review and send it.` }),
    }),
    open_email: tool({
      description: 'Show a conversation to the user as a card they can open.',
      inputSchema: z.object({ ref: z.string() }),
      // pas de navigation : ouvrir marque comme lu et peut envoyer un accusé de lecture ; l'utilisateur clique
      execute: async ({ ref }): Promise<OpenResult> => {
        const hit = resolveRef(ref);
        if (!hit) throw new Error(`Unknown reference ${ref}: use a reference returned by search_emails.`);
        const known = hits.get(hit.ref);
        if (known) return known;
        const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(hit.from);
        return {
          ref: hit.ref,
          accountId: hit.accountId,
          accountEmail: accounts().find((a) => a.id === hit.accountId)?.email ?? '',
          threadId: hit.threadId,
          emailId: hit.emailId,
          from: hit.from ? (m ? { name: m[1]?.trim() || null, email: m[2] ?? '' } : { name: null, email: hit.from }) : null,
          subject: hit.subject,
          preview: '',
          receivedAt: hit.receivedAt,
          unread: false,
          flagged: false,
          hasAttachment: false,
          count: 1,
        };
      },
      toModelOutput: () => ({ type: 'text' as const, value: 'Shown to the user as a card.' }),
    }),
  };
}
