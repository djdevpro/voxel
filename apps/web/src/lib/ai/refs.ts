/** Références `#n` des fils cités dans la discussion courante (même fil → même référence). */

export interface EmailRef {
  ref: string;
  accountId: string;
  threadId: string;
  emailId: string;
  subject: string;
  from: string;
  receivedAt: string;
}

const byKey = new Map<string, EmailRef>();
const byRef = new Map<string, EmailRef>();
let counter = 0;

/** Référence stable `#n` d'un fil dans la discussion courante (même fil → même référence). */
export function refFor(hit: Omit<EmailRef, 'ref'>): string {
  const key = `${hit.accountId}:${hit.threadId}`;
  const known = byKey.get(key);
  if (known) {
    // garde les informations les plus récentes (dernier message du fil)
    const next = { ...hit, ref: known.ref };
    byKey.set(key, next);
    byRef.set(known.ref, next);
    return known.ref;
  }
  const ref = `#${++counter}`;
  const entry = { ...hit, ref };
  byKey.set(key, entry);
  byRef.set(ref, entry);
  return ref;
}

/** Accepte « #3 », « 3 », « [#3] ». */
export function resolveRef(ref: string): EmailRef | undefined {
  const n = /^\s*\[?\s*#?\s*(\d+)\s*\]?\s*$/.exec(ref)?.[1];
  return n ? byRef.get(`#${Number(n)}`) : undefined;
}

export function clearRefs(): void {
  byKey.clear();
  byRef.clear();
  counter = 0;
}
