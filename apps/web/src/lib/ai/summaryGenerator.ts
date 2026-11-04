/**
 * Génération d'un résumé quotidien (module lourd, chargé à la demande par `summaries.ts`) : collecte des e-mails
 * reçus un jour donné (toutes les boîtes non exclues, hors spam, corbeille, envoyés, brouillons), rédaction par
 * le modèle, enregistrement dans Dexie (`aiSummaries`).
 */
import { streamText } from 'ai';
import { EMAIL_FULL_PROPERTIES, type Email, type EmailFilterCondition } from '@voxel/jmap';
import i18n from '@/i18n';
import type { Account } from '@/lib/api';
import { db } from '@/lib/db';
import { jmap } from '@/lib/jmap';
import { accountsQuery, getMailboxData, roleId } from '@/lib/mail';
import { queryClient } from '@/lib/queryClient';
import type { SystemRole } from '@/store/ui';
import { emailToMarkdown, formatAddress } from './markdown';
import { resolveModel } from './models';
import { buildInstructions } from './prompts';
import { useAiSettings } from './store';
import type { SummaryProgress } from './summaries';
import type { AiSummary, SummarySource } from './types';

const EXCLUDED_ROLES: SystemRole[] = ['trash', 'junk', 'sent', 'drafts', 'scheduled'];

interface Collected {
  email: Email;
  accountId: string;
  accountEmail: string;
}

/** Bornes locales d'une journée AAAA-MM-JJ, en ISO UTC (format JMAP). */
function dayBounds(date: string): { start: string; end: string } {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y!, m! - 1, d!);
  const end = new Date(y!, m! - 1, d! + 1);
  const iso = (x: Date) => x.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { start: iso(start), end: iso(end) };
}

async function collectAccount(account: Account, date: string, maxEmails: number, includeRead: boolean): Promise<Collected[]> {
  const data = await getMailboxData(account.id);
  const excluded = [...EXCLUDED_ROLES.map((r) => roleId(data, r)), data.hiddenId].filter((x): x is string => !!x);
  const { start, end } = dayBounds(date);
  const conditions: EmailFilterCondition[] = [
    ...(excluded.length ? [{ inMailboxOtherThan: excluded }] : []),
    { after: start },
    { before: end },
    ...(includeRead ? [] : [{ notKeyword: '$seen' }]),
  ];
  const aid = data.jmapAccountId;
  const b = jmap(account.id).batch();
  const q = b.call('Email/query', {
    accountId: aid,
    filter: { operator: 'AND', conditions },
    sort: [{ property: 'receivedAt', isAscending: false }],
    collapseThreads: true,
    limit: maxEmails,
  });
  const g = b.call('Email/get', {
    accountId: aid,
    '#ids': q.ref('/ids'),
    properties: [...EMAIL_FULL_PROPERTIES],
    fetchHTMLBodyValues: true,
    fetchTextBodyValues: true,
    maxBodyValueBytes: 300_000,
  });
  await b.send();
  return g.result.list.filter((e) => !e.keywords.$draft).map((email) => ({ email, accountId: account.id, accountEmail: account.email }));
}

async function collect(date: string): Promise<Collected[]> {
  const { summary } = useAiSettings.getState();
  const accounts = (queryClient.getQueryData<Account[]>(accountsQuery.queryKey) ?? []).filter((a) => !summary.excludedAccounts.includes(a.id));
  // une boîte en erreur n'annule pas le résumé ; toutes en erreur → première erreur
  const settled = await Promise.allSettled(accounts.map((a) => collectAccount(a, date, summary.maxEmails, summary.includeRead)));
  const lists = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed && !lists.length) throw failed.reason;
  return lists
    .flat()
    .sort((a, b) => b.email.receivedAt.localeCompare(a.email.receivedAt))
    .slice(0, summary.maxEmails);
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function buildPrompt(date: string, items: Collected[], maxChars: number): { prompt: string; sources: SummarySource[] } {
  const sources: SummarySource[] = [];
  const blocks = items.map((it, i) => {
    const e = it.email;
    const ref = `C${i + 1}`;
    const from = (e.from ?? []).map(formatAddress).join(', ');
    const subject = e.subject ?? '';
    sources.push({ ref, accountId: it.accountId, threadId: e.threadId, emailId: e.id, subject, from, receivedAt: e.receivedAt });
    return `[${ref}] Mailbox: ${it.accountEmail} · From: ${from} · ${hhmm(e.receivedAt)} · Subject: ${subject}\n${emailToMarkdown(e, { maxChars, headers: false })}`;
  });
  return { prompt: `Conversations received on ${date}:\n\n${blocks.join('\n\n---\n\n')}`, sources };
}

/** Titre = première ligne `# `, le reste = texte. */
function splitTitle(markdown: string): { title: string | null; body: string } {
  const text = markdown.trim();
  const m = /^#\s+(.+)\n?/.exec(text);
  return m ? { title: m[1]!.trim(), body: text.slice(m[0].length).trim() } : { title: null, body: text };
}

/** Génère (ou régénère) le résumé d'une journée locale AAAA-MM-JJ et l'enregistre. */
export async function generateSummary(date: string, opts?: { signal?: AbortSignal; onProgress?: (p: SummaryProgress) => void }): Promise<AiSummary> {
  const { summary } = useAiSettings.getState();
  // modèle résolu d'abord : pas de collecte inutile si l'IA n'est pas configurée
  const { model, ref } = await resolveModel('summary');
  opts?.onProgress?.({ stage: 'collect' });
  const items = await collect(date);
  opts?.signal?.throwIfAborted();
  opts?.onProgress?.({ stage: 'collect', emailCount: items.length });

  if (!items.length) {
    const empty = i18n.t('ai-summaries:empty.day');
    const row: AiSummary = { id: date, title: empty, markdown: empty, sources: [], emailCount: 0, model: '', createdAt: Date.now(), read: false };
    opts?.signal?.throwIfAborted();
    await db.aiSummaries.put(row);
    return row;
  }

  const { prompt, sources } = buildPrompt(date, items, summary.maxCharsPerEmail);
  const result = streamText({ model, instructions: buildInstructions('summary'), prompt, abortSignal: opts?.signal });
  let acc = '';
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      acc += part.text;
      opts?.onProgress?.({ stage: 'write', emailCount: items.length, markdown: acc });
    } else if (part.type === 'error') {
      throw part.error;
    } else if (part.type === 'abort') {
      // v7 : un flux annulé se ferme sans erreur ; rien ne doit être enregistré
      opts?.signal?.throwIfAborted();
      throw new DOMException('Aborted', 'AbortError');
    }
  }
  opts?.signal?.throwIfAborted();
  const { title, body } = splitTitle(acc.replace(/<think>[\s\S]*?<\/think>/g, ''));
  const row: AiSummary = {
    id: date,
    title: title ?? i18n.t('ai-summaries:fallbackTitle', { date }),
    markdown: body,
    sources,
    emailCount: items.length,
    model: ref.model,
    createdAt: Date.now(),
    read: false,
  };
  await db.aiSummaries.put(row);
  return row;
}
