/**
 * Construction des instructions envoyées au modèle : prompt `base` + prompt de la fonction,
 * variables `{{…}}` remplacées (langue, date, boîtes, style d'écriture).
 */
import { currentLocale } from '@/i18n';
import type { Account } from '@/lib/api';
import { accountsQuery } from '@/lib/mail';
import { queryClient } from '@/lib/queryClient';
import { MAILBOX_STYLE_FALLBACK } from './defaults';
import { systemPromptText, useAiSettings } from './store';
import type { AiFeature } from './types';

/** Langue de réponse : réglage, ou langue de l'interface (`currentLocale()`). `name` en anglais via Intl.DisplayNames(['en']). */
export function responseLanguage(): { code: string; name: string } {
  const pref = useAiSettings.getState().responseLanguage;
  const code = pref === 'auto' ? currentLocale() : pref;
  let name: string = code;
  try {
    name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    /* code inconnu d'Intl : on garde le code */
  }
  return { code, name };
}

/** Remplace les {{variables}} connues ; laisse les autres intactes. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k]! : all));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** « Wednesday, November 4, 2026 (2026-11-04), 09:12 », heure locale. */
function dateVar(d = new Date()): string {
  const long = new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  return `${long} (${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}), ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addressOf(a: Account): string {
  const name = a.displayName?.trim();
  return name ? `${name} <${a.email}>` : a.email;
}

function variables(accountId?: string): Record<string, string> {
  const accounts = queryClient.getQueryData<Account[]>(accountsQuery.queryKey) ?? [];
  const style = accountId ? useAiSettings.getState().mailboxStyles[accountId]?.trim() : undefined;
  return {
    language: responseLanguage().name,
    date: dateVar(),
    user: accounts.map(addressOf).join('; '),
    mailboxes: accounts.map((a) => `- ${addressOf(a)}`).join('\n'),
    mailbox_style: style || MAILBOX_STYLE_FALLBACK,
  };
}

/** Instructions complètes : base + fonction, variables remplacées. `planner` : sans `base`. */
export function buildInstructions(kind: AiFeature | 'planner', opts?: { accountId?: string }): string {
  const vars = variables(opts?.accountId);
  const text = kind === 'planner' ? systemPromptText('planner') : `${systemPromptText('base')}\n\n${systemPromptText(kind)}`;
  return renderTemplate(text, vars);
}
