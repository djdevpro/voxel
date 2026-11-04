/**
 * Transport de chat de l'assistant : tout tourne dans le navigateur (`streamText` + outils).
 * Si le modèle ne gère pas l'appel d'outils, repli : le modèle traduit la demande en recherche (`planner`),
 * l'appli l'exécute, puis le modèle répond avec les résultats.
 */
import {
  convertToModelMessages,
  createUIMessageStream,
  generateText,
  smoothStream,
  stepCountIs,
  streamText,
  type ChatTransport,
  type InferUITools,
  type LanguageModel,
  type UIMessage,
} from 'ai';
import { Chat } from '@ai-sdk/react';
import { z } from 'zod';
import { describeAiError } from './errors';
import { resolveModel, supportsTools } from './models';
import { buildInstructions } from './prompts';
import { clearRefs } from './refs';
import { createChatTools, findContacts, resetDraftCount, readThread, searchEmails, searchEmailsInput, type ContactsResult, type EmailHit, type EmailsResult, type SearchEmailsInput } from './tools';

export interface ChatMetadata {
  model?: string;
  providerId?: string;
  createdAt?: number;
}
export type ChatDataTypes = { emails: EmailsResult; contacts: ContactsResult };
export type ChatTools = ReturnType<typeof createChatTools>;
export type ChatMessage = UIMessage<ChatMetadata, ChatDataTypes, InferUITools<ChatTools>>;

const HISTORY = 16;

function lastUserText(history: ChatMessage[]): string {
  const last = [...history].reverse().find((m) => m.role === 'user');
  return (last?.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n')
    .trim();
}

const planSchema = z.object({
  search: searchEmailsInput.partial().optional(),
  contacts: z.string().optional(),
  read: z.boolean().optional(),
});
type SearchPlan = { search?: SearchEmailsInput; contacts?: string; read?: boolean };

/** Premier objet `{…}` de la réponse, lu avec souplesse ; échec → recherche du texte de la question. */
function parsePlan(text: string, question: string): SearchPlan {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const r = planSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
      if (r.success) {
        const folder = r.data.search?.folder;
        return { ...r.data, search: { ...r.data.search, folder: folder === 'any' ? undefined : folder }, contacts: r.data.contacts?.trim() || undefined };
      }
    } catch {
      /* JSON invalide : repli */
    }
  }
  return { search: { text: question } };
}

async function planSearch(model: LanguageModel, question: string, abortSignal: AbortSignal | undefined): Promise<SearchPlan> {
  const r = await generateText({ model, instructions: buildInstructions('planner'), prompt: question, abortSignal });
  return parsePlan(r.text, question);
}

/** Élément de recherche réduit, pour le contexte du modèle. */
function compactHit(h: EmailHit) {
  return {
    ref: h.ref,
    from: h.from ? (h.from.name ? `${h.from.name} <${h.from.email}>` : h.from.email) : '',
    subject: h.subject,
    date: h.receivedAt,
    preview: h.preview.slice(0, 160),
    unread: h.unread,
    attachments: h.hasAttachment,
    mailbox: h.accountEmail,
  };
}

function retrievalStream(opts: { model: LanguageModel; instructions: string; history: ChatMessage[]; meta: ChatMetadata; abortSignal: AbortSignal | undefined }) {
  const { model, instructions, history, meta, abortSignal } = opts;
  return createUIMessageStream<ChatMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: 'start', messageMetadata: meta });
      const question = lastUserText(history);
      const plan = await planSearch(model, question, abortSignal);
      let context = '';
      if (plan.contacts) {
        const c = await findContacts(plan.contacts);
        writer.write({ type: 'data-contacts', id: 'contacts', data: c });
        context += `\n\nContacts found for "${plan.contacts}":\n${JSON.stringify(c.items)}`;
      }
      const found = await searchEmails(plan.search ?? {});
      writer.write({ type: 'data-emails', id: 'emails', data: found });
      context += `\n\nSearch results (${found.total} in total):\n${JSON.stringify(found.items.map(compactHit))}`;
      if (plan.read) {
        for (const hit of found.items.slice(0, 3)) {
          context += `\n\nContent of ${hit.ref}:\n${(await readThread(hit.ref)).messages.map((m) => m.markdown).join('\n---\n')}`;
        }
      }
      const result = streamText({
        model,
        instructions: `${instructions}\n\nYou cannot call tools in this conversation: the app already searched for you. Use these results.${context}`,
        messages: await convertToModelMessages(history, { ignoreIncompleteToolCalls: true }),
        abortSignal,
        experimental_transform: smoothStream({ chunking: 'word' }),
      });
      writer.merge(result.toUIMessageStream<ChatMessage>({ sendStart: false, sendReasoning: true, onError: (e) => describeAiError(e).message }));
    },
    onError: (e) => describeAiError(e).message,
  });
}

class VoxelChatTransport implements ChatTransport<ChatMessage> {
  async sendMessages({ messages, abortSignal }: Parameters<ChatTransport<ChatMessage>['sendMessages']>[0]) {
    resetDraftCount();
    const { model, ref, provider } = await resolveModel('chat');
    const tools = createChatTools();
    const history = messages.slice(-HISTORY);
    const meta: ChatMetadata = { model: ref.model, providerId: ref.providerId, createdAt: Date.now() };
    const instructions = buildInstructions('chat');
    if (!(await supportsTools(provider, ref.model, model))) return retrievalStream({ model, instructions, history, meta, abortSignal });
    const result = streamText({
      model,
      instructions,
      messages: await convertToModelMessages(history, { tools, ignoreIncompleteToolCalls: true }),
      tools,
      stopWhen: stepCountIs(8),
      abortSignal,
      experimental_transform: smoothStream({ chunking: 'word' }),
    });
    return result.toUIMessageStream<ChatMessage>({
      sendReasoning: true,
      messageMetadata: ({ part }) => (part.type === 'start' ? meta : undefined),
      onError: (e) => describeAiError(e, provider).message,
    });
  }

  async reconnectToStream() {
    return null;
  }
}

let chat: Chat<ChatMessage> | null = null;

/** Discussion courante (une seule à la fois, gardée en mémoire tant que la page vit). */
export function getChat(): Chat<ChatMessage> {
  chat ??= new Chat<ChatMessage>({ transport: new VoxelChatTransport() });
  return chat;
}

/** Nouvelle discussion : arrête la génération, vide les références, crée une nouvelle instance. */
export function resetChat(): Chat<ChatMessage> {
  void chat?.stop();
  clearRefs();
  chat = new Chat<ChatMessage>({ transport: new VoxelChatTransport() });
  return chat;
}
