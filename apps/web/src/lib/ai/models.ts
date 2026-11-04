/**
 * Fournisseurs IA → `LanguageModel` de l'AI SDK (protocoles OpenAI-compatible et Anthropic), liste des modèles,
 * test de connexion et sonde d'appel d'outils (les erreurs sont dans `errors.ts`). Tous les appels partent du navigateur.
 */
import { APICallError, extractReasoningMiddleware, generateText, stepCountIs, tool, wrapLanguageModel, type LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { PROVIDER_PRESETS } from './defaults';
import { AiError, hostOf } from './errors';
import { getAiSecret } from './secrets';
import { findProvider, modelRefFor, useAiSettings } from './store';
import type { AiFeature, AiModelRef, AiProvider } from './types';

/** En-tête exigé par le proxy de développement (`dev/ai-proxy.ts`). */
const DEV_PROXY_HEADER = 'x-voxel-dev-proxy';

function viaDevProxy(p: AiProvider): boolean {
  return import.meta.env.DEV && !!p.devProxy && !p.baseUrl.trim().startsWith('/');
}

/** URL effective : en développement, `devProxy` passe par `/__ai-proxy/<base encodée>`. URL relative (`/__demo/…`) → préfixée par `location.origin`. */
export function providerBaseUrl(p: AiProvider): string {
  const base = p.baseUrl.trim().replace(/\/+$/, '');
  if (base.startsWith('/')) return `${location.origin}${base}`;
  if (import.meta.env.DEV && p.devProxy) return `${location.origin}/__ai-proxy/${encodeURIComponent(base)}`;
  return base;
}

/** JSON objet ou `undefined` ; JSON invalide → `undefined`. */
function parseExtraBody(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function languageModelFor(p: AiProvider, model: string): Promise<LanguageModel> {
  const key = await getAiSecret(p.id);
  const base = providerBaseUrl(p);
  const proxyHeaders: Record<string, string> = viaDevProxy(p) ? { [DEV_PROXY_HEADER]: '1' } : {};
  if (p.protocol === 'anthropic') {
    if (!key) throw new AiError('missing_key', { provider: p.name });
    return createAnthropic({ apiKey: key, baseURL: base, headers: { 'anthropic-dangerous-direct-browser-access': 'true', ...proxyHeaders } })(model);
  }
  const presetNeedsKey = PROVIDER_PRESETS.find((x) => x.id === p.preset)?.needsKey;
  if (presetNeedsKey && !key) throw new AiError('missing_key', { provider: p.name });
  const extra = parseExtraBody(p.extraBody);
  const provider = createOpenAICompatible({
    name: 'voxel',
    baseURL: base,
    apiKey: key || undefined,
    includeUsage: true,
    headers: proxyHeaders,
    ...(extra ? { transformRequestBody: (args: Record<string, unknown>) => ({ ...args, ...extra }) } : {}),
  });
  // Qwen, DeepSeek… peuvent renvoyer leur raisonnement dans <think>…</think>
  return wrapLanguageModel({ model: provider.chatModel(model), middleware: extractReasoningMiddleware({ tagName: 'think' }) });
}

export async function resolveModel(feature: AiFeature): Promise<{ model: LanguageModel; ref: AiModelRef; provider: AiProvider }> {
  const s = useAiSettings.getState();
  const ref = s.enabled ? modelRefFor(feature, s) : null;
  const provider = ref ? findProvider(ref.providerId, s) : undefined;
  if (!ref || !provider) throw new AiError('not_configured');
  return { model: await languageModelFor(provider, ref.model), ref, provider };
}

function errorOfStatus(status: number, p: AiProvider): AiError {
  if (status === 401 || status === 403) return new AiError('auth', { provider: p.name });
  if (status === 404) return new AiError('not_found', { provider: p.name });
  if (status === 429) return new AiError('rate_limited', { provider: p.name });
  if (status >= 500) return new AiError('server', { provider: p.name, status: String(status) });
  return new AiError('bad_request', { provider: p.name, detail: String(status) });
}

export async function listModels(p: AiProvider): Promise<string[]> {
  const key = await getAiSecret(p.id);
  const headers: Record<string, string> = viaDevProxy(p) ? { [DEV_PROXY_HEADER]: '1' } : {};
  let url = `${providerBaseUrl(p)}/models`;
  if (p.protocol === 'anthropic') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    url += '?limit=1000';
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    if (e instanceof TypeError) throw new AiError('network', { host: hostOf(p) });
    throw e;
  }
  if (!res.ok) throw errorOfStatus(res.status, p);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && !!id);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export async function testProvider(p: AiProvider, model: string): Promise<{ ms: number; tools: boolean }> {
  const lm = await languageModelFor(p, model);
  // nouveau test : la sonde d'outils est refaite
  useAiSettings.getState().clearToolSupport(p.id, model);
  const t0 = performance.now();
  // pas de maxOutputTokens : `max_tokens` est refusé par les modèles à raisonnement (o-series, GPT-5)
  await generateText({ model: lm, prompt: 'Reply with the single word OK.', timeout: 30_000 });
  const ms = Math.round(performance.now() - t0);
  return { ms, tools: await supportsTools(p, model, lm) };
}

/** L'appel d'outils marche-t-il avec ce modèle ? Sonde mise en cache dans `toolSupport`. */
export async function supportsTools(p: AiProvider, modelId: string, model: LanguageModel): Promise<boolean> {
  const k = `${p.id}:${modelId}`;
  const known = useAiSettings.getState().toolSupport[k];
  if (known !== undefined) return known;
  try {
    const r = await generateText({
      model,
      tools: { ping: tool({ description: 'Connectivity check. Call it once.', inputSchema: z.object({}), execute: async () => 'pong' }) },
      prompt: 'Call the ping tool now.',
      stopWhen: stepCountIs(1),
      timeout: 30_000,
    });
    // serveur sans analyseur d'outils : l'appel arrive en texte brut
    const ok = r.toolCalls.length > 0 || !/<tool_call>|"name"\s*:\s*"ping"/.test(r.text);
    useAiSettings.getState().setToolSupport(p.id, modelId, ok);
    return ok;
  } catch (e) {
    // 400/404/422/501 qui parle d'outils : paramètre `tools` refusé ; le reste remonte sans être mis en cache
    if (APICallError.isInstance(e) && e.statusCode && [400, 404, 422, 501].includes(e.statusCode) && /tool/i.test(e.responseBody ?? e.message)) {
      useAiSettings.getState().setToolSupport(p.id, modelId, false);
      return false;
    }
    throw e;
  }
}
