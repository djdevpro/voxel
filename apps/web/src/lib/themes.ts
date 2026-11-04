/**
 * Collections de thèmes. Une collection redéfinit les tokens (`--voxel-*` + variables shadcn) en clair et en sombre
 * via `[data-theme="<id>"]` et `[data-theme="<id>"].dark` (fichiers `src/styles/themes/<id>.css`).
 * Le mode clair/sombre/système reste géré à part (store des paramètres → classe `.dark`).
 * Les noms affichés viennent de l'espace de noms i18n `themes` : `themes:<id>.name` et `themes:<id>.description`.
 */
import { useSyncExternalStore } from 'react';
import { refreshAppearance } from './accent';

export const THEME_IDS = [
  'porcelain',
  'graphite',
  'nord',
  'rose-pine',
  'catppuccin',
  'solarized',
  'sepia',
  'forest',
  'ocean',
  'midnight',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

/** Couleurs d'aperçu d'une variante : [fond appli, barre latérale, panneau, texte, accent]. */
export type ThemePreview = readonly [app: string, sidebar: string, panel: string, text: string, accent: string];

export interface ThemeDef {
  id: ThemeId;
  /** Accent par défaut de la collection (l'accent de la boîte active reste prioritaire). */
  accent: string;
  preview: { light: ThemePreview; dark: ThemePreview };
}

export const DEFAULT_THEME: ThemeId = 'porcelain';

/** Registre des collections : accent par défaut et couleurs d'aperçu réelles (identiques aux fichiers CSS). */
export const THEMES: readonly ThemeDef[] = [
  {
    id: 'porcelain',
    accent: '#5b5bd6',
    preview: {
      light: ['#f6f5f3', '#f6f5f3', '#ffffff', '#1c1917', '#5b5bd6'],
      dark: ['#121110', '#121110', '#1a1918', '#edebe8', '#8b8ef5'],
    },
  },
  {
    id: 'graphite',
    accent: '#2563eb',
    preview: {
      light: ['#f4f5f7', '#f4f5f7', '#ffffff', '#15181e', '#2563eb'],
      dark: ['#111214', '#111214', '#18191c', '#e8eaee', '#6ea8fe'],
    },
  },
  {
    id: 'nord',
    accent: '#4c6f99',
    preview: {
      light: ['#e5e9f0', '#e5e9f0', '#eceff4', '#2e3440', '#4c6f99'],
      dark: ['#2e3440', '#2e3440', '#3b4252', '#eceff4', '#88c0d0'],
    },
  },
  {
    id: 'rose-pine',
    accent: '#286983',
    preview: {
      light: ['#faf4ed', '#faf4ed', '#fffaf3', '#575279', '#286983'],
      dark: ['#232136', '#232136', '#2a273f', '#e0def4', '#c4a7e7'],
    },
  },
  {
    id: 'catppuccin',
    accent: '#8839ef',
    preview: {
      light: ['#e6e9ef', '#e6e9ef', '#eff1f5', '#4c4f69', '#8839ef'],
      dark: ['#181825', '#181825', '#1e1e2e', '#cdd6f4', '#cba6f7'],
    },
  },
  {
    id: 'solarized',
    accent: '#1f6fa8',
    preview: {
      light: ['#eee8d5', '#eee8d5', '#fdf6e3', '#073642', '#1f6fa8'],
      dark: ['#00222b', '#00222b', '#002b36', '#eee8d5', '#4aa3df'],
    },
  },
  {
    id: 'sepia',
    accent: '#9a4a24',
    preview: {
      light: ['#f3ecdf', '#f3ecdf', '#fbf7ee', '#2f2418', '#9a4a24'],
      dark: ['#1b1611', '#1b1611', '#231d17', '#ede3d1', '#dc9a62'],
    },
  },
  {
    id: 'forest',
    accent: '#2d7a4c',
    preview: {
      light: ['#f1f4ef', '#f1f4ef', '#fbfcfa', '#17221a', '#2d7a4c'],
      dark: ['#0e1510', '#0e1510', '#141d17', '#e3ece5', '#62c08a'],
    },
  },
  {
    id: 'ocean',
    accent: '#0b6aa2',
    preview: {
      light: ['#eef3f8', '#eef3f8', '#fbfdff', '#0f1d2b', '#0b6aa2'],
      dark: ['#0a1520', '#0a1520', '#0f1d2a', '#e1ebf4', '#52b4ea'],
    },
  },
  {
    id: 'midnight',
    accent: '#5a4fd1',
    preview: {
      light: ['#f2f2f6', '#f2f2f6', '#fafafc', '#1a1a24', '#5a4fd1'],
      dark: ['#000000', '#050507', '#0b0b0e', '#ececf1', '#9488f7'],
    },
  },
];

const STORAGE_KEY = 'voxel.theme';
const EVENT = 'voxel:theme';

function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v) && THEMES.some((t) => t.id === v);
}

export function getThemeId(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(saved)) return saved;
  } catch {
    /* stockage indisponible */
  }
  return DEFAULT_THEME;
}

export function applyThemeId(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
  // accent lisible et <meta name="theme-color"> suivent la collection
  refreshAppearance();
}

let fadeTimer: ReturnType<typeof setTimeout> | undefined;

/** Fondu croisé (View Transitions API, sinon transition des couleurs 180 ms) ; immédiat si prefers-reduced-motion. */
export function crossFade(commit: () => void): void {
  const root = document.documentElement;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (reduce || document.visibilityState === 'hidden') return commit();
  if (typeof doc.startViewTransition === 'function') {
    try {
      doc.startViewTransition(commit);
      return;
    } catch {
      /* transition refusée : repli ci-dessous */
    }
  }
  clearTimeout(fadeTimer);
  root.classList.add('voxel-theme-fade');
  commit();
  fadeTimer = setTimeout(() => root.classList.remove('voxel-theme-fade'), 220);
}


/**
 * Change de collection avec un fondu croisé doux : View Transitions API si disponible,
 * sinon transition des couleurs (classe 'voxel-theme-fade', 180 ms). Aucune animation si
 * prefers-reduced-motion le demande.
 */
export function setThemeId(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignoré */
  }
  const root = document.documentElement;
  const commit = () => {
    applyThemeId(id);
    window.dispatchEvent(new Event(EVENT));
  };
  if (root.dataset.theme === id) return commit();
  crossFade(commit);
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

export function useThemeId(): [ThemeId, (id: ThemeId) => void] {
  const id = useSyncExternalStore(subscribe, getThemeId, () => DEFAULT_THEME);
  return [id, setThemeId];
}
