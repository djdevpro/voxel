import { create } from 'zustand';
import type { EmailAddress, ComposeAttachment, Priority } from '@voxel/jmap';

export type SystemRole = 'inbox' | 'flagged' | 'drafts' | 'sent' | 'scheduled' | 'archive' | 'junk' | 'trash';
export type MailboxSel = { kind: 'role'; role: SystemRole } | { kind: 'id'; id: string };

export const ALL = 'all' as const;

export interface View {
  accountId: string; // id de compte ou 'all'
  mailbox: MailboxSel;
}

export interface SearchChip {
  key: string;
  value: string;
}

export interface QuickFilters {
  unread: boolean;
  flagged: boolean;
  attachment: boolean;
}

export interface OpenThread {
  accountId: string;
  threadId: string;
  /** message ciblé (`?msg=`), facultatif */
  emailId?: string;
}

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward' | 'draft';

export interface ComposerState {
  id: string;
  accountId: string;
  identityId?: string;
  mode: ComposeMode;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  html: string;
  quoteHtml?: string;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  replyToEmailId?: string;
  attachments: ComposeAttachment[];
  draftEmailId?: string;
  minimized: boolean;
  fullscreen: boolean;
  /** affichée dans le lecteur plutôt qu'en fenêtre flottante */
  inline?: { threadKey: string };
  signature: boolean;
  /** Priorité à l'envoi. */
  priority?: Priority;
  /** Demander un accusé de lecture (`Disposition-Notification-To`). */
  requestReceipt?: boolean;
  /** Langue du message : attribut `lang` de l'éditeur pour le correcteur orthographique. */
  lang?: string;
}

export function threadKey(accountId: string, threadId: string) {
  return `${accountId}:${threadId}`;
}

export function viewKey(v: View): string {
  return `${v.accountId}|${v.mailbox.kind === 'role' ? 'r:' + v.mailbox.role : 'i:' + v.mailbox.id}`;
}

/**
 * État d'interface éphémère. La navigation (boîte, dossier, conversation ouverte, recherche, filtres,
 * paramètres) vit dans l'URL : voir `src/nav/`.
 */
interface UiState {
  sortAsc: boolean;
  selected: Set<string>;
  anchorKey: string | null;
  focusedKey: string | null;
  leaving: Set<string>;
  composers: ComposerState[];
  drawerOpen: boolean;
  paletteOpen: boolean;
  helpOpen: boolean;
  searchFocusTick: number;

  setSortAsc: (v: boolean) => void;
  setSelected: (s: Set<string>, anchor?: string | null) => void;
  clearSelection: () => void;
  setFocused: (k: string | null) => void;
  markLeaving: (keys: string[]) => void;
  unmarkLeaving: (keys: string[]) => void;
  openComposer: (c: Omit<ComposerState, 'id' | 'minimized' | 'fullscreen' | 'signature'> & Partial<Pick<ComposerState, 'id' | 'signature'>>) => string;
  updateComposer: (id: string, patch: Partial<ComposerState>) => void;
  closeComposer: (id: string) => void;
  setDrawer: (o: boolean) => void;
  setPalette: (o: boolean) => void;
  setHelp: (o: boolean) => void;
  focusSearch: () => void;
  /** remise à zéro quand la liste affichée change (autre dossier, autre recherche) */
  resetListState: () => void;
}

export const useUi = create<UiState>()((set, get) => ({
  sortAsc: false,
  selected: new Set(),
  anchorKey: null,
  focusedKey: null,
  leaving: new Set(),
  composers: [],
  drawerOpen: false,
  paletteOpen: false,
  helpOpen: false,
  searchFocusTick: 0,

  setSortAsc: (v) => set({ sortAsc: v }),
  setSelected: (s, anchor) => set({ selected: s, anchorKey: anchor === undefined ? get().anchorKey : anchor }),
  clearSelection: () => set({ selected: new Set(), anchorKey: null }),
  setFocused: (k) => set({ focusedKey: k }),
  markLeaving: (keys) => {
    const next = new Set(get().leaving);
    keys.forEach((k) => next.add(k));
    set({ leaving: next });
  },
  unmarkLeaving: (keys) => {
    const next = new Set(get().leaving);
    keys.forEach((k) => next.delete(k));
    set({ leaving: next });
  },
  openComposer: (c) => {
    const id = c.id ?? `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const existing = get().composers.find((x) => x.id === id);
    if (existing) {
      set({ composers: get().composers.map((x) => (x.id === id ? { ...x, minimized: false } : x)) });
      return id;
    }
    // Au plus une réponse en ligne par fil
    let list = get().composers;
    if (c.inline) list = list.filter((x) => x.inline?.threadKey !== c.inline?.threadKey);
    const state: ComposerState = { signature: true, ...c, id, minimized: false, fullscreen: false };
    // Les fenêtres flottantes : 3 maximum ouvertes, les autres minimisées
    if (!c.inline) {
      const floating = list.filter((x) => !x.inline && !x.minimized);
      if (floating.length >= 3) {
        const oldest = floating[0]!;
        list = list.map((x) => (x.id === oldest.id ? { ...x, minimized: true } : x));
      }
    }
    set({ composers: [...list, state] });
    return id;
  },
  updateComposer: (id, patch) => set({ composers: get().composers.map((c) => (c.id === id ? { ...c, ...patch } : c)) }),
  closeComposer: (id) => set({ composers: get().composers.filter((c) => c.id !== id) }),
  setDrawer: (o) => set({ drawerOpen: o }),
  setPalette: (o) => set({ paletteOpen: o }),
  setHelp: (o) => set({ helpOpen: o }),
  focusSearch: () => set({ searchFocusTick: get().searchFocusTick + 1 }),
  resetListState: () => set({ selected: new Set(), anchorKey: null, focusedKey: null, drawerOpen: false }),
}));
