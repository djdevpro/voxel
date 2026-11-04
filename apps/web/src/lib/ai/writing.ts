/** Rédaction assistée : une instruction appliquée au texte de l'éditeur, résultat en Markdown, en direct. */
import { smoothStream, streamText } from 'ai';
import { resolveModel } from './models';
import { buildInstructions } from './prompts';

export interface WritingRequest {
  instruction: string;
  /** texte à traiter (sélection ou brouillon) en Markdown, peut être vide */
  text: string;
  /** e-mail auquel on répond, en Markdown */
  replyTo?: string;
  accountId: string;
  signal?: AbortSignal;
  /** texte complet à chaque morceau reçu */
  onDelta?: (text: string) => void;
}

function buildPrompt(req: WritingRequest): string {
  const blocks = [`<instruction>\n${req.instruction.trim()}\n</instruction>`];
  if (req.replyTo) blocks.push(`<reply_to>\n${req.replyTo.trim()}\n</reply_to>`);
  blocks.push(`<text>\n${req.text.trim()}\n</text>`);
  return blocks.join('\n\n');
}

/** Retire un raisonnement `<think>` résiduel, une clôture de code ou des guillemets englobants. */
function clean(text: string): string {
  let out = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  const fence = /^```[\w-]*\n([\s\S]*?)(\n```)?$/.exec(out);
  if (fence) out = fence[1]!.trim();
  const quoted = /^(["“«])([\s\S]*)(["”»])$/.exec(out);
  if (quoted) out = quoted[2]!.trim();
  return out;
}

/** Renvoie le texte final (Markdown nettoyé). */
export async function runWriting(req: WritingRequest): Promise<string> {
  const { model } = await resolveModel('writing');
  const result = streamText({
    model,
    instructions: buildInstructions('writing', { accountId: req.accountId }),
    prompt: buildPrompt(req),
    abortSignal: req.signal,
    experimental_transform: smoothStream({ chunking: 'word' }),
  });
  let acc = '';
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      acc += part.text;
      req.onDelta?.(clean(acc));
    } else if (part.type === 'error') {
      throw part.error;
    }
  }
  return clean(acc);
}
