import { useEffect, useRef } from 'react';
import { MessageSquareText, Settings2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/common/bits';
import { effectiveTemplates, modelRefFor, templateLabel, useAiSettings } from '@/lib/ai/store';
import { shortModelName } from '@/lib/ai/errors';
import { openSettings } from '@/nav/nav';
import type { ComposerState } from '@/store/ui';
import { prefetchAiWriting, type AiWriting } from './useAiWriting';
import { templateIcon } from './templateIcons';

/** Raccourci du menu de l'assistant d'écriture : Alt+I (touche physique). */
export function isAiShortcut(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyI';
}

/** Bouton ✨ du pied de l'éditeur et menu des modèles de prompts. */
export function AiComposeMenu({
  writing,
  state,
  open,
  onOpenChange,
  onFocusEditor,
}: {
  writing: AiWriting;
  state: ComposerState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFocusEditor: () => void;
}) {
  const { t } = useTranslation('ai-compose');
  // abonnement : le menu suit les réglages (modèles, modèle de rédaction)
  const settings = useAiSettings();
  const isReply = state.mode === 'reply' || state.mode === 'replyAll' || state.mode === 'forward';
  const templates = effectiveTemplates('compose', settings).filter((tpl) => !tpl.replyOnly || isReply);
  const model = modelRefFor('writing', settings)?.model;
  const toPrompt = useRef(false);

  // préchargement du moteur d'écriture dès l'ouverture du menu
  useEffect(() => {
    if (open) prefetchAiWriting();
  }, [open]);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <IconButton label={t('menu.label')} shortcut={t('menu.shortcut')} active={writing.run?.status === 'streaming'}>
          <Sparkles />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="w-72"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          // l'instruction libre garde le focus dans son champ
          if (!toPrompt.current) onFocusEditor();
          toPrompt.current = false;
        }}
      >
        <DropdownMenuLabel className="flex items-center gap-2 text-[11.5px] font-medium text-text-3">
          <span className="flex-1 truncate">{t('menu.label')}</span>
          {model && <span className="truncate font-normal text-text-3">{shortModelName(model)}</span>}
        </DropdownMenuLabel>
        {templates.map((tpl) => {
          const Icon = templateIcon(tpl.icon);
          const label = templateLabel(tpl);
          return (
            <DropdownMenuItem key={tpl.id} onSelect={() => writing.start(label, tpl.prompt)}>
              <Icon />
              <span className="truncate" dir="auto">
                {label}
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => {
            toPrompt.current = true;
            writing.openPrompt();
          }}>
          <MessageSquareText /> {t('menu.custom')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSettings('ai')}>
          <Settings2 /> {t('menu.manage')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
