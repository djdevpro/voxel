/**
 * Filtre prérempli depuis un message (« Créer un filtre… » du lecteur) : posé par le lecteur,
 * consommé par Paramètres → Filtres à l'ouverture.
 */
import { create } from 'zustand';
import type { SieveFilter } from '@voxel/jmap';

export interface FilterDraft {
  accountId: string;
  filter: SieveFilter;
}

export const useFilterDraft = create<{ draft: FilterDraft | null; set: (d: FilterDraft | null) => void }>()((set) => ({
  draft: null,
  set: (draft) => set({ draft }),
}));

/** Identifiant court et stable d'un nouveau filtre. */
export function newFilterId(): string {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
