import { onlineManager } from '@tanstack/react-query';
import { JmapError, toServerCardSet, toServerEventSet, type ArgsOf, type Invocation, type MethodName, type WithRefs } from '@voxel/jmap';
import { accountRow } from './accounts';
import { db, type OutboxRow } from './db';
import { jmap } from './jmap';
import { isNetworkError } from './api';

export type Call = { [M in MethodName]: [M, WithRefs<ArgsOf<M>>] }[MethodName];

function toInvocations(accountId: string, calls: Call[]): Invocation[] {
  // boîte JMAP : agenda et contacts au dialecte du serveur (JSCalendar 2.0, JSContact) ; la passerelle IMAP garde celui de l'interface
  const row = accountRow(accountId);
  const direct = !!row && (row.protocol ?? 'jmap') === 'jmap';
  return calls.map(([name, args], i) => {
    const a = args as Record<string, unknown>;
    const out = !direct ? a : name === 'CalendarEvent/set' ? toServerEventSet(a) : name === 'ContactCard/set' ? toServerCardSet(a) : a;
    return [name, out, `o${i}`];
  });
}

export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && (!navigator.onLine || !onlineManager.isOnline());
}

export interface RunResult {
  queued: boolean;
  responses?: Invocation[];
}

/** Erreurs de méthode dans une réponse JMAP (y compris notCreated/notUpdated/notDestroyed). */
export function responseErrors(responses: Invocation[]): string[] {
  const errs: string[] = [];
  for (const [name, body] of responses) {
    if (name === 'error') errs.push(String((body as { type?: string; description?: string }).description ?? (body as { type?: string }).type));
    for (const k of ['notCreated', 'notUpdated', 'notDestroyed'] as const) {
      const v = (body as Record<string, unknown>)[k] as Record<string, { type: string; description?: string }> | null | undefined;
      if (v) for (const e of Object.values(v)) errs.push(e.description ?? e.type);
    }
  }
  return errs;
}

/**
 * Exécute des appels JMAP ; hors ligne (ou si le réseau échoue), les met en file
 * d'attente Dexie pour les rejouer au retour en ligne.
 */
export async function runCalls(accountId: string, calls: Call[], meta: { kind: OutboxRow['kind']; label: string }): Promise<RunResult> {
  const methodCalls = toInvocations(accountId, calls);
  const enqueue = async () => {
    await db.outbox.add({ accountId, kind: meta.kind, label: meta.label, calls: methodCalls, createdAt: Date.now(), attempts: 0 });
    window.dispatchEvent(new CustomEvent('voxel:queued'));
    return { queued: true };
  };
  if (isOffline()) return enqueue();
  try {
    const c = jmap(accountId);
    const res = await c.rawRequest({ using: c.usingFor(methodCalls), methodCalls });
    const errs = responseErrors(res.methodResponses);
    if (errs.length) throw new JmapError(errs.join(' · '), 'method');
    return { queued: false, responses: res.methodResponses };
  } catch (e) {
    if (isNetworkError(e)) return enqueue();
    throw e;
  }
}

let replaying = false;

/** Rejoue la file d'attente. Renvoie le nombre d'actions synchronisées et en échec. */
export async function replayOutbox(): Promise<{ ok: number; failed: number; remaining: number; accounts: Set<string> }> {
  const accounts = new Set<string>();
  if (replaying) return { ok: 0, failed: 0, remaining: await db.outbox.count(), accounts };
  replaying = true;
  let ok = 0;
  let failed = 0;
  try {
    const rows = await db.outbox.orderBy('id').toArray();
    for (const row of rows) {
      try {
        const c = jmap(row.accountId);
        const res = await c.rawRequest({ using: c.usingFor(row.calls), methodCalls: row.calls });
        const errs = responseErrors(res.methodResponses);
        await db.outbox.delete(row.id!);
        accounts.add(row.accountId);
        if (errs.length) failed++;
        else ok++;
      } catch (e) {
        if (isNetworkError(e)) break; // toujours hors ligne : on garde le reste
        const attempts = row.attempts + 1;
        if (attempts >= 3) {
          await db.outbox.delete(row.id!);
          failed++;
        } else await db.outbox.update(row.id!, { attempts, lastError: String((e as Error).message) });
      }
    }
  } finally {
    replaying = false;
  }
  return { ok, failed, remaining: await db.outbox.count(), accounts };
}
