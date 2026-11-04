/**
 * Résumés quotidiens : lecture des résumés enregistrés (Dexie `aiSummaries`) et génération en cours. Module léger :
 * la génération (`summaryGenerator.ts`, AI SDK) se charge à la demande.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { create } from 'zustand';
import { db } from '@/lib/db';
import { describeAiError } from './errors';
import type { AiSummary } from './types';

export interface SummaryProgress {
  stage: 'collect' | 'write';
  emailCount?: number;
  markdown?: string;
}

/** Liste vivante (récents d'abord). */
export function useSummaries(): AiSummary[] | undefined {
  return useLiveQuery(() => db.aiSummaries.orderBy('id').reverse().toArray(), []);
}

export function useSummary(id: string | undefined): AiSummary | undefined {
  return useLiveQuery(() => (id ? db.aiSummaries.get(id) : undefined), [id]);
}

export async function markSummaryRead(id: string): Promise<void> {
  await db.aiSummaries.update(id, { read: true });
}

export async function deleteSummary(id: string): Promise<void> {
  await db.aiSummaries.delete(id);
}

interface SummaryJob {
  date: string | null;
  progress: SummaryProgress | null;
  error: string | null;
}

/** Génération en cours (une à la fois), pour l'affichage en direct. */
export const useSummaryJob = create<SummaryJob>()(() => ({ date: null, progress: null, error: null }));

let controller: AbortController | null = null;
let generatorPrefetched = false;

/** Précharge le moteur des résumés (écran Résumés, IA prête) ; une seule fois, erreurs ignorées. */
export function prefetchSummaryGenerator(): void {
  if (generatorPrefetched) return;
  generatorPrefetched = true;
  void import('./summaryGenerator').catch(() => undefined);
}

/** Lance generateSummary et alimente useSummaryJob ; ignore si une génération tourne déjà. */
export function startSummaryJob(date: string): void {
  if (controller) return;
  const ctrl = new AbortController();
  controller = ctrl;
  useSummaryJob.setState({ date, progress: { stage: 'collect' }, error: null });
  import('./summaryGenerator')
    .then(({ generateSummary }) => generateSummary(date, { signal: ctrl.signal, onProgress: (progress) => useSummaryJob.setState({ progress }) }))
    .then(
      () => useSummaryJob.setState({ date: null, progress: null, error: null }),
      (e: unknown) => {
        const { code, message } = describeAiError(e);
        // annulation demandée : pas d'erreur affichée
        useSummaryJob.setState({ date: code === 'aborted' ? null : date, progress: null, error: code === 'aborted' ? null : message });
      },
    )
    .finally(() => {
      if (controller === ctrl) controller = null;
    });
}

export function cancelSummaryJob(): void {
  controller?.abort();
}
