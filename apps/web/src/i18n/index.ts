/**
 * Internationalisation (i18next). Une langue = un dossier `locales/<lang>/`, un fichier JSON par espace de noms.
 * Chaque espace de noms appartient à une zone de l'appli (voir NAMESPACES) ; l'anglais est la référence.
 * Les fichiers sont chargés à la demande : seule la langue courante (et l'anglais en repli) est téléchargée.
 */
import i18n, { type BackendModule, type ReadCallback } from 'i18next';
import { initReactI18next } from 'react-i18next';

export const LANGUAGES = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'fr', name: 'Français', dir: 'ltr' },
  { code: 'es', name: 'Español', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', dir: 'ltr' },
  { code: 'it', name: 'Italiano', dir: 'ltr' },
  { code: 'pt', name: 'Português', dir: 'ltr' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

/**
 * Espaces de noms. `common` est celui par défaut (`t('key')`) ; les autres s'utilisent avec
 * `useTranslation('mail')` ou `t('mail:list.empty')`.
 */
export const NAMESPACES = [
  'common', // libellés partagés (boutons génériques, dates relatives, unités)
  'errors', // messages pour les codes d'erreur de l'API (invalid_credentials, rate_limited…)
  'auth', // connexion, choix du compte, réglages avancés
  'accounts', // rail des boîtes, menu de compte, paramètres « Boîtes »
  'settings', // cadre des paramètres, identités & signatures, répondeur
  'appearance', // paramètres « Apparence » et « Lecture & envoi »
  'themes', // noms et descriptions des collections de thèmes
  'mail', // barre latérale, liste, recherche, actions sur les messages
  'reader', // lecteur de conversation, pièces jointes
  'compose', // rédaction
  'shortcuts', // raccourcis clavier, palette de commandes, aide
  'contacts', // écran Contacts, fiches, groupes, import / export, ajout depuis le lecteur
  'calendar', // écran Agenda, événements, invitations, import / export .ics, rappels
  'ai', // socle et réglages IA (erreurs, fournisseurs, modèles de prompts)
  'ai-chat', // assistant de recherche
  'ai-compose', // rédaction assistée
  'ai-summaries', // résumés quotidiens
] as const;

export type Namespace = (typeof NAMESPACES)[number];

const STORAGE_KEY = 'voxel.lang';
const files = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*/*.json');

const lazyBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language: string, namespace: string, callback: ReadCallback) {
    const load = files[`./locales/${language}/${namespace}.json`];
    if (!load) {
      callback(null, {});
      return;
    }
    load().then(
      (mod) => callback(null, mod.default),
      (err: unknown) => callback(err as Error, false),
    );
  },
};

function isLanguage(code: string | null | undefined): code is LanguageCode {
  return !!code && LANGUAGES.some((l) => l.code === code);
}

function detectLanguage(): LanguageCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    /* stockage indisponible (navigation privée) */
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLanguage(base)) return base;
  }
  return 'en';
}

export function languageDir(code: string): 'ltr' | 'rtl' {
  return LANGUAGES.find((l) => l.code === code)?.dir ?? 'ltr';
}

function applyToDocument(code: string) {
  const root = document.documentElement;
  root.lang = code;
  root.dir = languageDir(code);
}

export async function setLanguage(code: LanguageCode): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignoré */
  }
  await i18n.changeLanguage(code);
}

/** Langue courante, utilisable par `Intl.*` (dates, nombres, temps relatif). */
export function currentLocale(): LanguageCode {
  return isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : 'en';
}

i18n.on('languageChanged', applyToDocument);

const initialLanguage = detectLanguage();
applyToDocument(initialLanguage);

/** Résolue quand la langue courante (et l'anglais de repli) sont chargés : attendre avant le premier rendu. */
export const i18nReady = i18n
  .use(lazyBackend)
  .use(initReactI18next)
  .init({
    lng: initialLanguage,
    fallbackLng: 'en',
    supportedLngs: LANGUAGES.map((l) => l.code),
    ns: [...NAMESPACES],
    defaultNS: 'common',
    fallbackNS: 'common',
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false },
  });

export default i18n;
