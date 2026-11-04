/**
 * Réponses types : liste par boîte, rangée dans les réglages synchronisés (clé
 * `templates`). Lecture depuis la copie locale du document (`kv` `synced:<id>`), écriture locale immédiate
 * (relue par `useSync` à chaque changement de la boîte) puis envoi groupé vers le dossier caché (hors ligne : au retour du réseau, comme les autres réglages).
 */
import { queryOptions } from '@tanstack/react-query';
import { EMPTY_SYNCED, parseTemplates, patchSynced, type MailTemplate, type SyncedDoc } from '@voxel/jmap';
import { db } from './db';
import { queryClient } from './queryClient';
import { scheduleSyncedWrite } from './syncedSettings';
import { currentLocale } from '@/i18n';

async function localDoc(accountId: string): Promise<SyncedDoc> {
  return ((await db.kv.get(`synced:${accountId}`))?.value as SyncedDoc | undefined) ?? EMPTY_SYNCED;
}

export const templatesQuery = (accountId: string) =>
  queryOptions({
    queryKey: ['templates', accountId],
    queryFn: async (): Promise<MailTemplate[]> => {
      return parseTemplates((await localDoc(accountId)).entries.templates?.value, currentLocale());
    },
    staleTime: 60_000,
  });

/** Remplace la liste des réponses types d'une boîte. */
export async function saveTemplates(accountId: string, list: MailTemplate[]): Promise<void> {
  const clean = list.map((t) => ({ id: t.id, name: t.name.trim(), html: t.html, ...(t.subject?.trim() ? { subject: t.subject.trim() } : {}) }));
  const doc = patchSynced(await localDoc(accountId), { templates: clean }, new Date().toISOString());
  await db.kv.put({ key: `synced:${accountId}`, value: doc });
  queryClient.setQueryData(['templates', accountId], parseTemplates(clean, currentLocale()));
  scheduleSyncedWrite(accountId, { templates: clean });
}

export function newTemplateId(): string {
  return crypto.randomUUID();
}
