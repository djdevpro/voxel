/**
 * Push : IMAP IDLE sur INBOX (connexion dédiée, ouverte tant qu'un abonné existe) + relevé
 * périodique des dossiers ; émet des StateChange JMAP `{ changed: { a: { Email, Mailbox, Thread } } }`.
 */
import type { ImapFlow } from 'imapflow';
import type { BackendEvent } from '../backend/types.js';
import type { ChangeLog } from './changelog.js';
import type { Folders } from './folders.js';
import type { Messages } from './messages.js';
import type { ImapPool } from './pool.js';

type Listener = (states: Record<string, string>) => void;

export const ACCOUNT_ID = 'a';

export class Push {
  private listeners = new Set<Listener>();
  private idle: ImapFlow | null = null;
  private starting = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private last: Record<string, string> = {};
  private stopped = false;
  private retryDelay = 2_000;

  constructor(
    private readonly pool: ImapPool,
    private readonly folders: Folders,
    private readonly messages: Messages,
    private readonly changelog: ChangeLog | null = null,
    private readonly pollMs = 45_000,
  ) {}

  /** Signale un changement possible (écriture locale, IDLE) : vérifie les états puis diffuse. */
  notify(delay = 150) {
    if (!this.listeners.size) {
      this.folders.invalidate();
      return;
    }
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.check(), delay);
  }

  private async check() {
    try {
      this.folders.invalidate();
      const [email, mailbox] = await Promise.all([this.folders.emailState(), this.folders.mailboxState()]);
      const next: Record<string, string> = { Email: email, Thread: email, Mailbox: mailbox };
      const changed: Record<string, string> = {};
      for (const [k, v] of Object.entries(next)) if (this.last[k] !== v) changed[k] = v;
      if (Object.keys(changed).length) {
        if (changed.Email) this.messages.invalidateQueries();
        const hadBaseline = Object.keys(this.last).length > 0;
        this.last = next;
        if (hadBaseline) for (const l of this.listeners) l(changed);
      }
    } catch {
      /* serveur momentanément indisponible : prochain relevé */
    }
  }

  private async startIdle() {
    if (this.idle || this.starting || this.stopped || !this.listeners.size) return;
    this.starting = true;
    try {
      const client = await this.pool.open({ disableAutoIdle: false, maxIdleTime: 4 * 60_000 });
      this.idle = client;
      this.retryDelay = 2_000;
      const onEvent = () => this.notify(300);
      client.on('exists', onEvent);
      client.on('expunge', onEvent);
      client.on('flags', onEvent);
      client.on('close', () => {
        if (this.idle === client) this.idle = null;
        if (!this.stopped && this.listeners.size) setTimeout(() => void this.startIdle(), this.retryDelay).unref?.();
        this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
      });
      await client.mailboxOpen('INBOX');
      // imapflow passe en IDLE automatiquement quand la connexion est libre
      void client.idle().catch(() => undefined);
    } catch {
      if (!this.stopped && this.listeners.size) setTimeout(() => void this.startIdle(), this.retryDelay).unref?.();
      this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
    } finally {
      this.starting = false;
    }
  }

  private stopIdle() {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    const c = this.idle;
    this.idle = null;
    if (c) c.logout().catch(() => c.close());
  }

  private subscribe(l: Listener): () => void {
    this.listeners.add(l);
    // Un abonné au push lira Email/changes : le journal doit suivre les relevés dès maintenant.
    this.changelog?.activate();
    if (this.listeners.size === 1) {
      void this.check();
      void this.startIdle();
      this.pollTimer = setInterval(() => void this.check(), this.pollMs);
      this.pollTimer.unref?.();
    }
    return () => {
      this.listeners.delete(l);
      if (!this.listeners.size) this.stopIdle();
    };
  }

  /** Abonnement immédiat (avant la première lecture) : aucun changement n'est perdu entre l'appel et l'itération. */
  events(types: string[], signal: AbortSignal): AsyncIterable<BackendEvent> {
    const want = (t: string) => !types.length || types.includes('*') || types.includes(t);
    const queue: BackendEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (ev: BackendEvent) => {
      queue.push(ev);
      wake?.();
    };
    const unsubscribe = this.subscribe((changed) => {
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(changed)) if (want(k)) filtered[k] = v;
      if (Object.keys(filtered).length) push({ type: 'state', data: { '@type': 'StateChange', changed: { [ACCOUNT_ID]: filtered } } });
    });
    const ping = setInterval(() => push({ type: 'ping' }), 30_000);
    ping.unref?.();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(ping);
      signal.removeEventListener('abort', onAbort);
      unsubscribe();
      wake?.();
    };
    const onAbort = () => finish();
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) finish();
    async function* run(): AsyncGenerator<BackendEvent> {
      try {
        while (!done) {
          if (!queue.length) await new Promise<void>((r) => (wake = r));
          wake = null;
          while (queue.length && !done) yield queue.shift()!;
        }
      } finally {
        finish();
      }
    }
    return run();
  }

  close() {
    this.stopped = true;
    this.listeners.clear();
    clearTimeout(this.debounce);
    this.stopIdle();
  }
}
