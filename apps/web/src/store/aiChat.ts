/**
 * État d'interface de la discussion de l'assistant (colonne de liste en mode discussion). Pas de persistance.
 * Le moteur de discussion (`@/lib/ai/chat`, AI SDK) se charge à la première question.
 */
import { create } from 'zustand';

type ChatModule = typeof import('@/lib/ai/chat');

/** module de discussion, une fois chargé (pour `resetAiChat` sans import statique du moteur) */
let chatModule: ChatModule | null = null;
let chatImport: Promise<ChatModule> | null = null;

function loadChat(): Promise<ChatModule> {
  chatImport ??= import('@/lib/ai/chat').then((m) => (chatModule = m));
  return chatImport;
}

/** Précharge le moteur de discussion (intention de l'utilisateur) ; une seule fois, erreurs ignorées. */
export function prefetchAiChat(): void {
  if (chatImport) return;
  loadChat().catch(() => {
    chatImport = null;
  });
}

interface AiChatState {
  /** colonne de liste en mode discussion */
  open: boolean;
  /** clé React de la discussion courante (incrémentée à chaque nouvelle discussion) */
  session: number;
  /** une discussion existe (pour « Reprendre ») */
  started: boolean;
  /** génération en cours (recopié depuis la discussion par `AiConversation`) */
  busy: boolean;
  /** texte à placer dans la saisie (suggestions « sans envoi ») */
  draft: string;
  openChat(): void;
  closeChat(): void;
  setDraft(text: string): void;
  /** ouvre la discussion et envoie la question */
  ask(text: string): void;
  /** nouvelle discussion vide, ouverte */
  newChat(): void;
}

export const useAiChat = create<AiChatState>()((set, get) => ({
  open: false,
  session: 0,
  started: false,
  busy: false,
  draft: '',
  openChat: () => set({ open: true }),
  closeChat: () => set({ open: false }),
  setDraft: (draft) => set({ draft }),
  ask: (text) => {
    set({ open: true, started: true, draft: '' });
    void loadChat().then(async ({ getChat }) => {
      const chat = getChat();
      // une seule génération à la fois
      if (chat.status === 'submitted' || chat.status === 'streaming') await chat.stop();
      await chat.sendMessage({ text });
    });
  },
  newChat: () => {
    void loadChat().then(({ resetChat }) => {
      resetChat();
      set({ session: get().session + 1, started: false, draft: '', open: true });
    });
  },
}));

/** « Tout déconnecter » : discussion fermée et vidée ; le moteur n'est réinitialisé que s'il est déjà chargé. */
export function resetAiChat(): void {
  useAiChat.setState({ open: false, started: false, draft: '', busy: false });
  if (chatModule) {
    chatModule.resetChat();
    useAiChat.setState({ session: useAiChat.getState().session + 1 });
  }
}
