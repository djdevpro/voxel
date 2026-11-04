/** Aides communes : expéditeur lisible, aperçu, ouverture d'une conversation citée. */
import type { SummarySource } from '@/lib/ai/types';
import { openHit } from '../openHit';

/** « Max Durand <max@x.fr>, … » → « Max Durand ». */
export function senderName(from: string): string {
  const first = from.split(',')[0]?.trim() ?? '';
  return first.replace(/\s*<[^>]*>$/, '').trim() || first;
}

/** Premier paragraphe du Markdown, sans sa syntaxe (`#`, `*`, `_`, `[Cn]`, puces). */
export function previewText(markdown: string): string {
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block
      .replace(/\[C\d+\]/g, '')
      .replace(/^\s*(#+|[-*+]|\d+\.)\s+/gm, '')
      .replace(/[#*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }
  return '';
}

/** Ouvre la conversation (dans la réception de sa boîte si elle n'est pas dans la vue courante). */
export function openSource(s: SummarySource): void {
  openHit({ accountId: s.accountId, threadId: s.threadId, emailId: s.emailId });
}
