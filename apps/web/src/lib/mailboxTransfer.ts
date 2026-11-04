/**
 * Export d'un dossier en `.mbox` et import de `.eml` ou `.mbox` dans un dossier, côté client.
 * Le travail est fait par `@voxel/jmap` (`exportMessages`, `importMessages`) ; ici : fichiers, progression,
 * annulation et messages.
 * - Export : écrit au fil de l'eau dans le fichier choisi (`showSaveFilePicker` si le navigateur le permet, sinon
 *   un `Blob` assemblé par morceaux puis enregistré).
 * - Import : lecture en flux ; un serveur qui limite les téléversements (Stalwart : 1 000 fichiers ou 50 Mo par
 *   heure) met l'import en pause, puis il reprend seul ; relancé, il ignore les messages déjà présents.
 */
import { toast } from 'sonner';
import { exportMessages, importMessages, readMessages } from '@voxel/jmap';
import { getMailboxData } from './mail';
import { jmap } from './jmap';
import { invalidateAccount } from './actions';
import { errorMessage } from './api';
import i18n from '@/i18n';

const t = (k: string, o?: Record<string, unknown>) => i18n.t(`mail:transfer.${k}`, o);

/** Nom de fichier sûr. */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'mailbox';
}

interface Sink {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/** Fichier de destination : écriture directe sur le disque si possible, sinon assemblage en mémoire. */
async function openSink(fileName: string): Promise<Sink | null> {
  const w = window as Window & { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<WritableStreamLike> }> };
  interface WritableStreamLike {
    write(d: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: fileName, types: [{ description: 'mbox', accept: { 'application/mbox': ['.mbox'] } }] });
      const ws = await handle.createWritable();
      return { write: (c) => ws.write(c), close: () => ws.close(), abort: () => ws.abort() };
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return null; // choix annulé
      // autre erreur (iframe, permissions…) : repli en mémoire
    }
  }
  const parts: BlobPart[] = [];
  return {
    write: async (c) => void parts.push(c),
    close: async () => {
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/mbox' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    abort: async () => void (parts.length = 0),
  };
}

/** Exporte un dossier en `.mbox`. */
export async function exportMailbox(accountId: string, mailboxId: string, name: string): Promise<void> {
  const sink = await openSink(`${safeName(name)}.mbox`);
  if (!sink) return;
  const id = `export-${accountId}-${mailboxId}`;
  const ctrl = new AbortController();
  const progress = (done: number, total: number) =>
    toast.loading(t('exporting', { name, done, total }), {
      id,
      duration: Infinity,
      action: { label: t('cancel'), onClick: () => ctrl.abort() },
    });
  progress(0, 0);
  try {
    const data = await getMailboxData(accountId);
    const r = await exportMessages(jmap(accountId), { accountId: data.jmapAccountId, mailboxId, write: (c) => sink.write(c), signal: ctrl.signal, onProgress: progress });
    if (r.aborted) {
      await sink.abort();
      toast(t('cancelled'), { id, duration: 3000, action: undefined });
      return;
    }
    await sink.close();
    toast.success(t('exported', { name, count: r.exported }), { id, duration: 5000, action: undefined });
  } catch (e) {
    await sink.abort().catch(() => undefined);
    toast.error(t('exportFailed'), { id, description: errorMessage(e), duration: 10000, action: undefined });
  }
}

/** Demande des fichiers à l'utilisateur. */
export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export const IMPORT_ACCEPT = '.eml,.mbox,message/rfc822,application/mbox';

async function* messagesOf(files: File[]): AsyncGenerator<string> {
  for (const f of files) yield* readMessages(f, f.name);
}

/** Importe des `.eml` ou `.mbox` dans un dossier. */
export async function importIntoMailbox(accountId: string, mailboxId: string, name: string, files: File[]): Promise<void> {
  if (!files.length) return;
  const id = `import-${accountId}-${mailboxId}`;
  const ctrl = new AbortController();
  const action = { label: t('cancel'), onClick: () => ctrl.abort() };
  const progress = (count: number) => toast.loading(t('importing', { name, count }), { id, duration: Infinity, action });
  const clock = (d: Date) => new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(d);
  progress(0);
  try {
    const data = await getMailboxData(accountId);
    const r = await importMessages(jmap(accountId), {
      accountId: data.jmapAccountId,
      mailboxId,
      messages: messagesOf(files),
      signal: ctrl.signal,
      onProgress: (c) => progress(c.imported),
      onWait: (until, c) => toast.loading(t('importWaiting', { name, count: c.imported, time: clock(until) }), { id, duration: Infinity, action }),
    });
    invalidateAccount(accountId, 300);
    if (r.failed) console.warn('import: failures', r.errors);
    const msg = t('imported', { name, count: r.imported });
    const details = [r.skipped ? t('importSkipped', { count: r.skipped }) : '', r.failed ? t('importFailedSome', { count: r.failed }) : ''].filter(Boolean).join(' · ');
    if (r.failed) toast.warning(msg, { id, description: details, duration: 8000, action: undefined });
    else toast.success(msg, { id, description: details || undefined, duration: 5000, action: undefined });
  } catch (e) {
    invalidateAccount(accountId, 300);
    toast.error(t('importFailed'), { id, description: errorMessage(e), duration: 10000, action: undefined });
  }
}
