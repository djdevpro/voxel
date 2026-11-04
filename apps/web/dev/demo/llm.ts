/**
 * LLM simulé, compatible OpenAI Chat Completions (`/__demo/llm/v1`) : réponses scriptées pour essayer
 * l'interface IA sans token (streaming SSE, appels d'outils, raisonnement `<think>`). Aucune intelligence.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: string;
  content?: string | Array<{ type?: string; text?: string }> | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: Array<{ type?: string; function?: { name?: string } }>;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

type Reply = { text: string } | { call: { name: string; args: Record<string, unknown> } };

const MODELS = ['voxel-demo', 'voxel-demo-thinking'];

function textOf(m: ChatMessage | undefined): string {
  if (!m?.content) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.map((p) => p.text ?? '').join('');
}

function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ scénarios

/** Résumé du jour : blocs `[Cn] … From: … · Subject: …`. */
function digest(user: string, fr: boolean): string {
  const items: Array<{ ref: string; from: string; subject: string }> = [];
  for (const line of user.split('\n')) {
    const m = /^\[(C\d+)\]\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const from = /From:\s*([^<·]+?)\s*(?:<[^>]*>)?\s*(?:·|$)/.exec(m[2]!)?.[1]?.trim() ?? '?';
    const subject = /Subject:\s*(.*)$/.exec(m[2]!)?.[1]?.trim() ?? '';
    items.push({ ref: m[1]!, from, subject });
  }
  const urgent = /URGENT|devis|valider|review|relecture|facture/i;
  const todo = items.filter((i) => urgent.test(i.subject));
  const rest = items.filter((i) => !urgent.test(i.subject));
  const bullet = (i: (typeof items)[number]) => `- **${i.from}** : ${i.subject || (fr ? '(sans objet)' : '(no subject)')} [${i.ref}]`;
  const out = [
    fr ? `# ${items.length} e-mails, dont ${todo.length} à traiter` : `# ${items.length} emails, ${todo.length} need action`,
    '',
    fr
      ? `Journée ${items.length > 8 ? 'chargée' : 'calme'} : ${items.length} conversations reçues. Ce résumé est produit par le LLM de démonstration.`
      : `A ${items.length > 8 ? 'busy' : 'quiet'} day: ${items.length} conversations received. This digest comes from the demo LLM.`,
  ];
  if (todo.length) out.push('', fr ? '## À traiter' : '## Needs action', ...todo.map(bullet));
  if (rest.length) out.push('', fr ? '## Aussi aujourd\'hui' : '## Also today', ...rest.map(bullet));
  return out.join('\n');
}

/** Rédaction : remise en forme du texte entre `<text>` et `</text>`, ou courte réponse polie. */
function writing(user: string, fr: boolean): string {
  const tag = (name: string) => new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`).exec(user)?.[1] ?? '';
  const instruction = tag('instruction');
  const replyTo = tag('reply_to');
  // langue : celle des réglages, ou celle de l'e-mail auquel on répond
  fr ||= /\b(bonjour|merci|vous)\b/i.test(replyTo);
  if (/reply/i.test(instruction)) {
    const firstLine = replyTo.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
    const subject = /Subject:\s*(.+)/i.exec(replyTo)?.[1]?.trim() || firstLine || (fr ? 'votre message' : 'your message');
    return fr
      ? `Bonjour,\n\nMerci pour votre message au sujet de « ${subject} ». Je reviens vers vous très vite avec une réponse détaillée.\n\nBien cordialement,`
      : `Hello,\n\nThank you for your message about "${subject}". I will get back to you shortly with a detailed answer.\n\nBest regards,`;
  }
  const text = tag('text') || user;
  return text
    .split(/\n{2,}/)
    .map((p) => {
      let s = p.replace(/[ \t]{2,}/g, ' ').trim();
      s = s.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, pre: string, c: string) => pre + c.toUpperCase());
      if (s && !/[.!?…:]$/.test(s)) s += '.';
      return s;
    })
    .filter(Boolean)
    .join('\n\n');
}

const WRITE_RE = /(?:écri(?:s|re|t|vez)?|write(?:\s+to)?|mail\s+à|envoie(?:r)?(?:\s+un\s+(?:e-?)?mail)?)\s+(?:à\s+|a\s+|to\s+|au\s+)?(\p{Lu}[\p{L}'-]*|\p{L}[\p{L}'-]+)/iu;
const STOP = new Set(['un', 'une', 'le', 'la', 'les', 'mail', 'email', 'e-mail', 'message', 'an', 'a', 'the', 'to', 'à']);

function firstName(text: string): string | undefined {
  const m = WRITE_RE.exec(text);
  const n = m?.[1];
  return n && !STOP.has(n.toLowerCase()) ? n : undefined;
}

/** Discussion avec outils. */
function chat(messages: ChatMessage[], fr: boolean): Reply {
  const last = messages[messages.length - 1];
  const users = messages.filter((m) => m.role === 'user').map(textOf);
  const wantsWrite = users.some((u) => firstName(u) !== undefined);

  if (last?.role === 'tool') {
    const call = messages.flatMap((m) => m.tool_calls ?? []).find((t) => t.id === last.tool_call_id);
    const name = call?.function.name ?? '';
    let result: unknown;
    try {
      result = JSON.parse(textOf(last));
    } catch {
      result = textOf(last);
    }
    if (name === 'find_contacts') {
      const list = (Array.isArray(result) ? result : ((result as { items?: unknown[] })?.items ?? [])) as Array<{ name?: string | null; email?: string }>;
      if (!list.length) return { text: fr ? 'Je n\'ai trouvé aucun contact correspondant.' : 'I could not find any matching contact.' };
      if (list.length > 1) {
        const lines = list.map((c) => `- ${c.name ?? c.email} <${c.email}>`).join('\n');
        return { text: fr ? `J'ai trouvé plusieurs contacts :\n${lines}\n\nLequel voulez-vous ?` : `I found several contacts:\n${lines}\n\nWhich one do you mean?` };
      }
      const c = list[0]!;
      if (wantsWrite) {
        const first = (c.name ?? '').split(' ')[0] ?? '';
        return { call: { name: 'compose_email', args: { to: [{ name: c.name ?? undefined, email: c.email }], subject: '', body: fr ? `Bonjour ${first},\n\n` : `Hello ${first},\n\n` } } };
      }
      return { text: fr ? `Contact trouvé : ${c.name ?? ''} <${c.email}>.` : `Found: ${c.name ?? ''} <${c.email}>.` };
    }
    if (name === 'search_emails') {
      const r = result as { total?: number; emails?: Array<{ ref?: string; from?: string; subject?: string }> };
      const emails = r?.emails ?? [];
      if (!emails.length) return { text: fr ? 'Aucun e-mail ne correspond à cette recherche.' : 'No email matches this search.' };
      const top = emails.slice(0, 3).map((e) => `- ${e.from ?? '?'} : ${e.subject ?? ''} [${e.ref ?? ''}]`).join('\n');
      const total = r.total ?? emails.length;
      return { text: fr ? `J'ai trouvé ${total} conversation${total > 1 ? 's' : ''}. Les plus récentes :\n${top}` : `I found ${total} conversation${total > 1 ? 's' : ''}. The most recent:\n${top}` };
    }
    if (name === 'compose_email') return { text: fr ? 'Le brouillon est ouvert, relisez-le avant l\'envoi.' : 'The draft is open, please review it before sending.' };
    return { text: fr ? 'C\'est fait.' : 'Done.' };
  }

  const text = textOf(last);
  const prev = [...messages.slice(0, -1)].reverse().find((m) => m.role === 'assistant' && textOf(m));
  // adresse choisie pendant une demande d'écriture (après find_contacts ou « Lequel ? ») : brouillon direct
  const address = /[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+/.exec(text)?.[0];
  const askedContacts = wantsWrite && messages.some((m) => m.tool_calls?.some((t) => t.function.name === 'find_contacts'));
  if (address && (askedContacts || (prev && /Lequel|Which one/i.test(textOf(prev))))) {
    const name = text.replace(address, '').replace(/[<>"']/g, '').replace(/\s+/g, ' ').trim().replace(/[.!?:,]+$/, '').trim();
    const first = name.split(' ')[0] ?? '';
    return { call: { name: 'compose_email', args: { to: [{ name: name || undefined, email: address }], subject: '', body: fr ? `Bonjour ${first},\n\n` : `Hello ${first},\n\n` } } };
  }
  if (prev && /Lequel|Which one/i.test(textOf(prev))) return { call: { name: 'find_contacts', args: { query: text.trim().replace(/[.!?]+$/, '') } } };
  const who = firstName(text);
  if (who) return { call: { name: 'find_contacts', args: { query: who } } };
  if (/aujourd|today|du jour/i.test(text)) return { call: { name: 'search_emails', args: { since: localDate() } } };
  const from = /(?:\bde|\bfrom)\s+(\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+)?)/u.exec(text)?.[1];
  if (from) return { call: { name: 'search_emails', args: { from } } };
  const words = text.split(/[^\p{L}\p{N}'-]+/u).filter((w) => w.length > 2).sort((x, y) => y.length - x.length).slice(0, 3);
  return { call: { name: 'search_emails', args: { text: words.join(' ') || text } } };
}

function plan(req: ChatRequest): Reply {
  const messages = req.messages ?? [];
  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map(textOf).join('\n');
  const fr = /Always answer in French|Write in French/i.test(system);
  const user = textOf([...messages].reverse().find((m) => m.role === 'user'));
  if (/daily email digest/i.test(system)) return { text: digest(user, fr) };
  if (/writing assistant/i.test(system)) return { text: writing(user, fr) };
  const tools = new Set((req.tools ?? []).map((t) => t.function?.name).filter((n): n is string => !!n));
  const last = messages[messages.length - 1];
  // sonde de prise en charge des outils : un seul outil `ping`
  if (tools.has('ping')) {
    if (last?.role === 'tool') return { text: 'OK' };
    return { call: { name: 'ping', args: {} } };
  }
  if (tools.size) {
    const r = chat(messages, fr);
    if ('text' in r || tools.has(r.call.name)) return r;
    return { text: fr ? `Réponse de démonstration : j'ai bien reçu « ${user.slice(0, 80)} ».` : `Demo answer: I received "${user.slice(0, 80)}".` };
  }
  return { text: 'OK' };
}

// ------------------------------------------------------------------ HTTP

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handleLlm(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (req.method === 'GET' && (path === '/models' || path === '/models/')) {
    return json(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', created: 1730000000, owned_by: 'demo' })) });
  }
  if (req.method !== 'POST' || path !== '/chat/completions') return json(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });

  let body: ChatRequest;
  try {
    const raw = await readJson(req);
    if (!raw || typeof raw !== 'object') throw new Error('body');
    body = raw as ChatRequest;
  } catch {
    return json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }
  const model = body.model ?? 'voxel-demo';
  const reply = plan(body);
  const thinking = model === 'voxel-demo-thinking';
  const fr = /Always answer in French|Write in French/i.test((body.messages ?? []).filter((m) => m.role === 'system').map(textOf).join('\n'));
  const text = 'text' in reply
    ? (thinking ? `<think>${fr ? 'L\'utilisateur attend une réponse claire. Je reprends les éléments fournis et je réponds brièvement.' : 'The user expects a clear answer. I will reuse the provided material and answer briefly.'}</think>\n\n` : '') + reply.text
    : '';
  const call: ToolCall | undefined = 'call' in reply
    ? { id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`, type: 'function', function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }
    : undefined;
  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const finish = call ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: JSON.stringify(body.messages ?? []).length >> 2, completion_tokens: (text.length + (call?.function.arguments.length ?? 0)) >> 2, total_tokens: 0 };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  if (!body.stream) {
    return json(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: call ? null : text, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: finish }],
      usage,
    });
  }

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  let closed = false;
  res.on('close', () => (closed = true));
  const send = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);

  send({ role: 'assistant', content: '' });
  if (call) {
    await sleep(25);
    send({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] });
    await sleep(25);
    send({ tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] });
  } else {
    for (const word of text.match(/\S+\s*|\s+/g) ?? []) {
      if (closed) return;
      await sleep(25);
      send({ content: word });
    }
  }
  if (closed) return;
  send({}, finish);
  if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}
