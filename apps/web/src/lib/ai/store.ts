/**
 * Réglages IA, propres à l'appareil (localStorage `voxel-ai`), communs à toutes les boîtes.
 * Aucune clé d'API ici : voir `secrets.ts`.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import i18n from '@/i18n';
import { DEFAULT_AI_SETTINGS, DEFAULT_SYSTEM_PROMPTS, DEFAULT_TEMPLATES } from './defaults';
import { deleteAiSecret } from './secrets';
import type { AiFeature, AiModelRef, AiPromptTemplate, AiProvider, AiSettings, SystemPromptKey } from './types';

interface AiSettingsState extends AiSettings {
  set(patch: Partial<AiSettings>): void;
  upsertProvider(p: AiProvider): void;
  /** retire aussi sa clé (deleteAiSecret) et les références de modèle qui le visent */
  removeProvider(id: string): void;
  setSystemPrompt(key: SystemPromptKey, text: string): void;
  resetSystemPrompt(key: SystemPromptKey): void;
  setMailboxStyle(accountId: string, style: string): void;
  /** la première modification copie DEFAULT_TEMPLATES dans `templates` */
  upsertTemplate(t: AiPromptTemplate): void;
  removeTemplate(id: string): void;
  moveTemplate(id: string, delta: -1 | 1): void;
  resetTemplates(): void;
  setFeatureModel(feature: AiFeature, ref: AiModelRef | null): void;
  setToolSupport(providerId: string, model: string, supported: boolean): void;
  /** oublie le résultat de la sonde d'outils de ce modèle (nouveau test) */
  clearToolSupport(providerId: string, model: string): void;
}

const SETTINGS_KEYS = Object.keys(DEFAULT_AI_SETTINGS) as Array<keyof AiSettings>;

function normalizeProvider(p: AiProvider): AiProvider {
  const models = [...new Set(p.models.map((m) => m.trim()).filter(Boolean))];
  return { ...p, baseUrl: p.baseUrl.trim().replace(/\/+$/, ''), models };
}

export const useAiSettings = create<AiSettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_AI_SETTINGS,
      set: (patch) => set(patch),
      upsertProvider: (raw) => {
        const p = normalizeProvider(raw);
        const s = get();
        const exists = s.providers.some((x) => x.id === p.id);
        const providers = exists ? s.providers.map((x) => (x.id === p.id ? p : x)) : [...s.providers, p];
        // premier fournisseur, premier modèle : il devient le modèle par défaut
        const first = providers[0];
        const defaultModel = !s.defaultModel && first?.id === p.id && p.models[0] ? { providerId: p.id, model: p.models[0] } : s.defaultModel;
        set({ providers, defaultModel });
      },
      removeProvider: (id) => {
        const s = get();
        const featureModels = Object.fromEntries(Object.entries(s.featureModels).filter(([, r]) => r.providerId !== id)) as AiSettings['featureModels'];
        const toolSupport = Object.fromEntries(Object.entries(s.toolSupport).filter(([k]) => !k.startsWith(`${id}:`)));
        set({
          providers: s.providers.filter((p) => p.id !== id),
          defaultModel: s.defaultModel?.providerId === id ? null : s.defaultModel,
          featureModels,
          toolSupport,
        });
        void deleteAiSecret(id);
      },
      setSystemPrompt: (key, text) => {
        const { [key]: _old, ...rest } = get().systemPrompts;
        set({ systemPrompts: text === DEFAULT_SYSTEM_PROMPTS[key] ? rest : { ...rest, [key]: text } });
      },
      resetSystemPrompt: (key) => {
        const { [key]: _old, ...rest } = get().systemPrompts;
        set({ systemPrompts: rest });
      },
      setMailboxStyle: (accountId, style) => {
        const { [accountId]: _old, ...rest } = get().mailboxStyles;
        set({ mailboxStyles: style.trim() ? { ...rest, [accountId]: style } : rest });
      },
      upsertTemplate: (t) => {
        const list = get().templates ?? DEFAULT_TEMPLATES;
        const templates = list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t];
        set({ templates });
      },
      removeTemplate: (id) => set({ templates: (get().templates ?? DEFAULT_TEMPLATES).filter((x) => x.id !== id) }),
      moveTemplate: (id, delta) => {
        const list = [...(get().templates ?? DEFAULT_TEMPLATES)];
        const i = list.findIndex((x) => x.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j]!, list[i]!];
        set({ templates: list });
      },
      resetTemplates: () => set({ templates: null }),
      setFeatureModel: (feature, ref) => {
        const { [feature]: _old, ...rest } = get().featureModels;
        set({ featureModels: ref ? { ...rest, [feature]: ref } : rest });
      },
      setToolSupport: (providerId, model, supported) => set({ toolSupport: { ...get().toolSupport, [`${providerId}:${model}`]: supported } }),
      clearToolSupport: (providerId, model) => {
        const { [`${providerId}:${model}`]: _old, ...rest } = get().toolSupport;
        set({ toolSupport: rest });
      },
    }),
    {
      name: 'voxel-ai',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => Object.fromEntries(SETTINGS_KEYS.map((k) => [k, s[k]])) as unknown as AiSettingsState,
      // champs ajoutés plus tard : complétés par les valeurs par défaut
      merge: (persisted, current) => ({ ...current, ...(persisted as Partial<AiSettings>) }),
    },
  ),
);

const state = (s?: AiSettings): AiSettings => s ?? useAiSettings.getState();

/** Modèles de prompts effectifs, optionnellement filtrés par portée. */
export function effectiveTemplates(scope?: 'compose' | 'chat', s?: AiSettings): AiPromptTemplate[] {
  const list = state(s).templates ?? DEFAULT_TEMPLATES;
  return scope ? list.filter((t) => t.scope === scope) : list;
}

/** Libellé : nom saisi, sinon `ai:templates.<builtin>`, sinon début du prompt. */
export function templateLabel(t: AiPromptTemplate): string {
  const name = t.name?.trim();
  if (name) return name;
  if (t.builtin) return i18n.t(`ai:templates.${t.builtin}`);
  const p = t.prompt.trim();
  return p.length > 40 ? `${p.slice(0, 40).trimEnd()}…` : p;
}

/** Texte effectif d'un prompt système (surcharge ou défaut). */
export function systemPromptText(key: SystemPromptKey, s?: AiSettings): string {
  return state(s).systemPrompts[key] ?? DEFAULT_SYSTEM_PROMPTS[key];
}

export function findProvider(id: string, s?: AiSettings): AiProvider | undefined {
  return state(s).providers.find((p) => p.id === id);
}

/** Modèle d'une fonction : surcharge, sinon défaut ; `null` si le fournisseur n'existe plus ou si le modèle est vide. */
export function modelRefFor(feature: AiFeature, s?: AiSettings): AiModelRef | null {
  const st = state(s);
  const ref = st.featureModels[feature] ?? st.defaultModel;
  if (!ref || !ref.model.trim() || !findProvider(ref.providerId, st)) return null;
  return ref;
}

/** Interrupteur général. */
export function useAiEnabled(): boolean {
  return useAiSettings((s) => s.enabled);
}

/** IA utilisable pour la fonction : activée et un modèle résolu. */
export function useAiReady(feature: AiFeature = 'chat'): boolean {
  return useAiSettings((s) => s.enabled && modelRefFor(feature, s) !== null);
}
