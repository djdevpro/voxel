/** Critères de l'outil `search_emails` → recherche classique de la liste (« Voir dans la liste »). */
import { chipsOf } from '@/lib/ai/searchQuery';
import type { SearchEmailsInput } from '@/lib/ai/tools';
import type { SearchChip } from '@/store/ui';

/** Même correspondance que `searchEmails` : `since` → `after:` veille, `until` → `before:` lendemain. */
export function searchToQuery(input: SearchEmailsInput): { chips: SearchChip[]; text: string } {
  return { chips: chipsOf(input), text: input.text?.trim() ?? '' };
}
