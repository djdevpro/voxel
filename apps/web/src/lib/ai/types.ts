import type { LanguageCode } from '@/i18n';

export type AiProtocol = 'openai' | 'anthropic';
export type AiFeature = 'chat' | 'writing' | 'summary';
export type SystemPromptKey = 'base' | 'chat' | 'writing' | 'summary' | 'planner';
export type ProviderPresetId = 'openai' | 'anthropic' | 'hetzner' | 'ollama' | 'custom' | 'demo';

/** Fournisseur configuré. La clé d'API n'est jamais ici : voir `secrets.ts`. */
export interface AiProvider {
  id: string;
  /** nom affiché (« Hetzner », « Ollama »…) */
  name: string;
  preset: ProviderPresetId;
  protocol: AiProtocol;
  /** URL de base de l'API, sans « / » final (https://api.openai.com/v1) */
  baseUrl: string;
  /** identifiants des modèles connus (récupérés ou saisis) */
  models: string[];
  /** JSON fusionné dans le corps des requêtes OpenAI-compatibles, ex. {"chat_template_kwargs":{"enable_thinking":false}} */
  extraBody?: string;
  /** développement seulement : passer par le proxy de Vite (`/__ai-proxy`) pour contourner CORS */
  devProxy?: boolean;
}

export interface AiModelRef {
  providerId: string;
  model: string;
}

/** Modèle de prompt (menu ✨ de l'éditeur, suggestions de la discussion). */
export interface AiPromptTemplate {
  id: string;
  /** modèle livré d'origine : libellé traduit `ai:templates.<builtin>` tant que `name` est vide */
  builtin?: string;
  name?: string;
  prompt: string;
  scope: 'compose' | 'chat';
  /** chat : envoyer directement (sinon pré-remplir la saisie) */
  send?: boolean;
  /** compose : nom d'icône lucide (voir TEMPLATE_ICONS du lot 05) */
  icon?: string;
  /** compose : seulement en réponse ou transfert */
  replyOnly?: boolean;
}

export interface AiSummarySettings {
  /** générer le résumé du jour en ouvrant « Résumés » s'il n'existe pas */
  auto: boolean;
  maxEmails: number;
  maxCharsPerEmail: number;
  includeRead: boolean;
  /** ids de comptes ignorés */
  excludedAccounts: string[];
}

export interface AiDictationSettings {
  enabled: boolean;
  /** modèle Deepgram (nova-3) */
  model: string;
  /** `auto` = langue du message, `multi` = détection Deepgram, sinon code de langue */
  language: string;
}

export interface AiSettings {
  /** interrupteur général : rail, éditeur, discussion, résumés */
  enabled: boolean;
  providers: AiProvider[];
  defaultModel: AiModelRef | null;
  /** surcharge du modèle par fonction */
  featureModels: Partial<Record<AiFeature, AiModelRef>>;
  /** `auto` = langue de l'interface */
  responseLanguage: 'auto' | LanguageCode;
  /** surcharges des prompts système (absent = texte par défaut) */
  systemPrompts: Partial<Record<SystemPromptKey, string>>;
  /** style d'écriture par boîte (id de compte → instructions) */
  mailboxStyles: Record<string, string>;
  /** `null` = modèles livrés (suivent les mises à jour) */
  templates: AiPromptTemplate[] | null;
  summary: AiSummarySettings;
  dictation: AiDictationSettings;
  /** `${providerId}:${model}` → le serveur accepte l'appel d'outils */
  toolSupport: Record<string, boolean>;
}

/** Conversation citée dans un résumé (`[C3]`). */
export interface SummarySource {
  ref: string;
  accountId: string;
  threadId: string;
  emailId: string;
  subject: string;
  from: string;
  receivedAt: string;
}

/** Résumé d'une journée (table Dexie `aiSummaries`, clé = date locale AAAA-MM-JJ). */
export interface AiSummary {
  id: string;
  title: string;
  markdown: string;
  sources: SummarySource[];
  emailCount: number;
  model: string;
  createdAt: number;
  read: boolean;
}
