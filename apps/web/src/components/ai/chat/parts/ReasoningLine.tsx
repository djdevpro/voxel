import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, LoaderCircle } from 'lucide-react';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';

/** Trace du raisonnement : ouverte pendant la réflexion, repliée ensuite (sauf choix de l'utilisateur). */
export function ReasoningLine({ text, running }: { text: string; running: boolean }) {
  const { t } = useTranslation('ai-chat');
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const line = (
    <TraceLine status={running ? 'running' : undefined}>
      <TraceIcon>{running ? <LoaderCircle className="animate-spin" /> : <Brain />}</TraceIcon>
      <TraceTitle>{running ? t('reasoning.running') : t('reasoning.done')}</TraceTitle>
    </TraceLine>
  );
  return (
    <Trace className="text-[13px]">
      {text.trim() ? (
        <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-[12.5px] whitespace-pre-wrap">{text}</TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        line
      )}
    </Trace>
  );
}
