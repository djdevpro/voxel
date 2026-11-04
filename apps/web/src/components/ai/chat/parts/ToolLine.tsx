import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { BookOpen, CircleAlert, LoaderCircle, MailOpen, PenLine, Search, Users, type LucideIcon } from 'lucide-react';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import type { ChatMessage } from '@/lib/ai/chat';
import type { SearchEmailsInput } from '@/lib/ai/tools';
import { resolveRef } from '@/lib/ai/refs';
import { roleLabel } from '@/lib/mail';
import { currentLocale } from '@/i18n';
import type { SystemRole } from '@/store/ui';

export type ToolPart = Extract<ChatMessage['parts'][number], { type: `tool-${string}` }>;

function day(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  return new Intl.DateTimeFormat(currentLocale(), { day: 'numeric', month: 'short' }).format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Critères lisibles d'une recherche : `de “max” · depuis le 1 nov.` ; sans critère : « Derniers e-mails ». */
export function searchTitle(input: Partial<SearchEmailsInput> | undefined, t: TFunction<'ai-chat'>): string {
  const parts: string[] = [];
  const i = input ?? {};
  if (i.from?.trim()) parts.push(t('tools.from', { value: i.from.trim() }));
  if (i.to?.trim()) parts.push(t('tools.to', { value: i.to.trim() }));
  if (i.subject?.trim()) parts.push(t('tools.subject', { value: i.subject.trim() }));
  if (i.text?.trim()) parts.push(t('tools.text', { value: i.text.trim() }));
  if (i.since) parts.push(t('tools.since', { date: day(i.since) }));
  if (i.until) parts.push(t('tools.until', { date: day(i.until) }));
  if (i.unread === true) parts.push(t('tools.unread'));
  if (i.unread === false) parts.push(t('tools.read'));
  if (i.flagged) parts.push(t('tools.flagged'));
  if (i.hasAttachment) parts.push(t('tools.attachments'));
  if (i.folder && i.folder !== 'any') parts.push(t('tools.folder', { folder: roleLabel(i.folder as SystemRole) }));
  if (i.mailbox?.trim()) parts.push(t('tools.mailbox', { mailbox: i.mailbox.trim() }));
  return parts.length ? t('tools.search', { criteria: parts.join(' · ') }) : t('tools.latest');
}

function describe(part: ToolPart, t: TFunction<'ai-chat'>): { icon: LucideIcon; title: string; description?: string } {
  const done = part.state === 'output-available';
  switch (part.type) {
    case 'tool-search_emails':
      return { icon: Search, title: searchTitle(part.input, t), description: done ? t('tools.count', { count: part.output.total }) : undefined };
    case 'tool-read_email': {
      const subject = (done ? part.output.subject : undefined) ?? (part.input?.ref ? resolveRef(part.input.ref)?.subject : undefined) ?? '';
      return { icon: BookOpen, title: t('tools.readTitle', { subject }) };
    }
    case 'tool-find_contacts':
      return { icon: Users, title: t('tools.contactsTitle', { query: part.input?.query ?? '' }), description: done ? t('tools.contactsCount', { count: part.output.items.length }) : undefined };
    case 'tool-compose_email': {
      const to = done ? part.output.to : (part.input?.to ?? []).map((a) => a?.name || a?.email || '').filter(Boolean);
      return { icon: PenLine, title: t('tools.composeTitle', { to: to.join(', ') }) };
    }
    case 'tool-open_email': {
      const subject = (done ? part.output.subject : undefined) ?? (part.input?.ref ? resolveRef(part.input.ref)?.subject : undefined) ?? '';
      return { icon: MailOpen, title: t('tools.openTitle', { subject }) };
    }
  }
}

/** Trace d'un appel d'outil : en cours, terminé (avec un compte) ou en erreur (dépliable). */
export function ToolLine({ part }: { part: ToolPart }) {
  const { t } = useTranslation('ai-chat');
  const { icon, title, description } = describe(part, t);
  return <TraceRow icon={icon} title={title} description={description} running={part.state === 'input-streaming' || part.state === 'input-available'} errorText={part.state === 'output-error' ? part.errorText : undefined} />;
}

/** Ligne de trace générique (aussi pour le repli sans outils). */
export function TraceRow({ icon: Icon, title, description, running, errorText }: { icon: LucideIcon; title: string; description?: string; running?: boolean; errorText?: string }) {
  const error = errorText !== undefined;
  const line = (
    <TraceLine status={running ? 'running' : error ? 'error' : undefined}>
      <TraceIcon>{running ? <LoaderCircle className="animate-spin" /> : error ? <CircleAlert /> : <Icon />}</TraceIcon>
      <TraceTitle>{title}</TraceTitle>
      {description && <TraceDescription>{description}</TraceDescription>}
    </TraceLine>
  );
  return (
    <Trace className="text-[13px]">
      {error ? (
        <TraceCollapsible>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-[12.5px] whitespace-pre-wrap">{errorText}</TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        line
      )}
    </Trace>
  );
}
