/** Paramètres → IA : sous-onglets Général, Modèles, Prompts, Résumés, Dictée. */
import { useState } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { useAiEnabled, useAiReady } from '@/lib/ai/store';
import { tFast } from '@/lib/motion';
import { Segmented } from '../ui';
import { GeneralPane } from './GeneralPane';
import { ProvidersPane } from './ProvidersPane';
import { PromptsPane } from './PromptsPane';
import { SummariesPane } from './SummariesPane';
import { DictationPane } from './DictationPane';

type Pane = 'general' | 'models' | 'prompts' | 'summaries' | 'dictation';
const PANES: Pane[] = ['general', 'models', 'prompts', 'summaries', 'dictation'];

export function AiSection() {
  const { t } = useTranslation('ai');
  const enabled = useAiEnabled();
  const ready = useAiReady();
  // « Modèles » d'abord seulement si l'IA est activée sans être prête ; sinon « Général » (où est l'interrupteur)
  const [pane, setPane] = useState<Pane>(() => (enabled && !ready ? 'models' : 'general'));

  return (
    <div>
      <div className="-mx-1 mb-5 overflow-x-auto px-1 [scrollbar-width:none]">
        <Segmented value={pane} onChange={setPane} options={PANES.map((p) => ({ value: p, label: t(`settings.tabs.${p}`) }))} />
      </div>
      <motion.div key={pane} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={tFast}>
        {pane === 'general' && <GeneralPane onConfigure={() => setPane('models')} />}
        {pane === 'models' && <ProvidersPane />}
        {pane === 'prompts' && <PromptsPane />}
        {pane === 'summaries' && <SummariesPane />}
        {pane === 'dictation' && <DictationPane />}
      </motion.div>
    </div>
  );
}
