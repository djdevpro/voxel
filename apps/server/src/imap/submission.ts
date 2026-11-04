/**
 * Envoi SMTP (nodemailer) : EmailSubmission/set|get, vérification SMTP.
 * Le MIME vient du message déjà enregistré (brouillon) ; Bcc retiré avant envoi.
 */
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { connect as netConnect } from 'node:net';
import { BackendAuthError, BackendUnavailableError, type ImapConfig } from '../backend/types.js';
import { assertAllowedPort, BlockedHostError, pinHostCandidates } from '../netguard.js';
import { stripBcc } from './mime.js';
import type { Identities } from './identities.js';
import type { Messages } from './messages.js';
import { hashOf, isObject, LRU, MethodError, randomBase36, SetError, setErrorOf, utcDate } from './util.js';

const SMTP_NET = new Set(['ESOCKET', 'ECONNECTION', 'ETIMEDOUT', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETLS', 'EPROTOCOL']);

export function mapSmtpError(e: unknown): unknown {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string } | undefined;
  if (err?.code === 'EAUTH' || err?.responseCode === 535) {
    return new BackendAuthError(`SMTP authentication failed${err.responseCode ? ` (${err.responseCode})` : ''}`);
  }
  if (err?.code && SMTP_NET.has(err.code)) return new BackendUnavailableError(`SMTP server unreachable (${err.code})`);
  return e;
}

type Probe = (host: string, port: number, timeoutMs: number) => Promise<void>;

/** Ouverture TCP simple (fermée aussitôt) : l'adresse est-elle joignable ? */
export const tcpProbe: Probe = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const s = netConnect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      const e = new Error(`connect timeout ${host}:${port}`) as NodeJS.ErrnoException;
      e.code = 'ETIMEDOUT';
      reject(e);
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve();
    });
    s.once('error', (e) => {
      clearTimeout(t);
      s.destroy();
      reject(e);
    });
  });

/**
 * Première adresse candidate joignable (une seule candidate : rendue sans sonde). Si aucune ne répond,
 * on rend la première : nodemailer produira l'erreur réseau habituelle (→ upstream_unreachable).
 */
export async function firstReachable<C extends { host: string }>(candidates: C[], port: number, probe: Probe = tcpProbe, timeoutMs = 5000): Promise<C> {
  if (candidates.length <= 1) return candidates[0]!;
  for (const c of candidates) {
    try {
      await probe(c.host, port, timeoutMs);
      return c;
    } catch {
      /* adresse suivante */
    }
  }
  return candidates[0]!;
}

interface Submission {
  id: string;
  identityId: string;
  emailId: string;
  threadId: string | null;
  envelope: { mailFrom: { email: string; parameters: null }; rcptTo: Array<{ email: string; parameters: null }> };
  sendAt: string;
  undoStatus: 'final';
  deliveryStatus: Record<string, unknown> | null;
  dsnBlobIds: string[];
  mdnBlobIds: string[];
}

export class Submissions {
  private sent = new LRU<string, Submission>(200);
  private stateCounter = 0;

  constructor(
    private readonly cfg: ImapConfig,
    private readonly messages: Messages,
    private readonly identities: Identities,
  ) {}

  /** Transport SMTP vers une IP publique vérifiée et épinglée (servername = nom d'origine), port SMTP autorisé. */
  async transport() {
    const { cfg } = this;
    let pinned: { host: string; servername?: string };
    try {
      assertAllowedPort('smtp', cfg.smtp.port);
      // Plusieurs adresses (A puis AAAA) : on garde la première qui accepte une connexion TCP. L'envoi lui-même
      // n'est jamais rejoué sur une autre adresse (pas de double envoi si la coupure survient pendant DATA).
      pinned = await firstReachable(await pinHostCandidates(cfg.smtp.host), cfg.smtp.port);
    } catch (e) {
      if (e instanceof BlockedHostError) throw new BackendUnavailableError(`SMTP ${e.message}`);
      throw e;
    }
    const auth: SMTPTransport.Options['auth'] =
      { user: cfg.username, pass: cfg.auth.password };
    return nodemailer.createTransport({
      host: pinned.host,
      ...(pinned.servername ? { servername: pinned.servername, tls: { servername: pinned.servername } } : {}),
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      requireTLS: !cfg.smtp.secure,
      auth,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
  }

  async verify(): Promise<void> {
    const t = await this.transport();
    try {
      await t.verify();
    } catch (e) {
      const m = mapSmtpError(e);
      throw m instanceof Error ? m : new BackendUnavailableError(String(m));
    } finally {
      t.close();
    }
  }

  state(): string {
    return `s${hashOf(`${this.cfg.email}|${this.stateCounter}`, 10)}`;
  }

  get(args: Record<string, unknown>): Record<string, unknown> {
    const ids = Array.isArray(args.ids) ? (args.ids as string[]) : null;
    const all: Submission[] = [];
    if (ids) {
      const notFound: string[] = [];
      for (const id of ids) {
        const s = this.sent.get(id);
        if (s) all.push(s);
        else notFound.push(id);
      }
      return { state: this.state(), list: all, notFound };
    }
    return { state: this.state(), list: [], notFound: [] };
  }

  /**
   * EmailSubmission/set. Renvoie la réponse et, si des actions onSuccess* sont demandées,
   * les arguments d'un Email/set implicite (RFC 8621 §7.5).
   */
  async set(
    args: Record<string, unknown>,
    resolveId: (id: string) => string,
    onCreated: (cid: string, id: string) => void,
  ): Promise<{ response: Record<string, unknown>; emailSet: Record<string, unknown> | null }> {
    const oldState = this.state();
    if (typeof args.ifInState === 'string' && args.ifInState !== oldState) throw new MethodError('stateMismatch');
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    const subToEmail = new Map<string, string>();

    for (const [cid, obj] of isObject(args.create) ? Object.entries(args.create) : []) {
      try {
        if (!isObject(obj)) throw new SetError('invalidProperties');
        const emailId = typeof obj.emailId === 'string' ? resolveId(obj.emailId) : '';
        if (!emailId) throw new SetError('invalidProperties', 'emailId required', ['emailId']);
        const identityId = typeof obj.identityId === 'string' ? resolveId(obj.identityId) : '';
        const identity = this.identities.find(identityId);
        if (!identity) throw new SetError('invalidProperties', 'identity not found', ['identityId']);
        const info = await this.messages.envelopeOf(emailId);
        if (!info) throw new SetError('invalidProperties', 'email not found', ['emailId']);
        const env = isObject(obj.envelope) ? obj.envelope : null;
        const mailFrom = env && isObject(env.mailFrom) && typeof env.mailFrom.email === 'string' ? env.mailFrom.email : identity.email;
        let rcpt: string[] =
          env && Array.isArray(env.rcptTo)
            ? (env.rcptTo as Array<{ email?: string }>).map((r) => r.email).filter((x): x is string => !!x)
            : [...info.to, ...info.cc, ...info.bcc, ...(identity.bcc ?? [])].map((a) => a.email);
        rcpt = [...new Set(rcpt.map((r) => r.trim()).filter(Boolean))];
        if (!rcpt.length) throw new SetError('noRecipients', 'no recipients');
        const blob = await this.messages.loadBlob(emailId);
        if (!blob) throw new SetError('invalidProperties', 'email source not found', ['emailId']);
        const raw = stripBcc(blob.data);
        const t = await this.transport();
        try {
          await t.sendMail({ envelope: { from: mailFrom, to: rcpt }, raw });
        } catch (e) {
          const mapped = mapSmtpError(e);
          if (mapped instanceof BackendAuthError || mapped instanceof BackendUnavailableError) throw mapped;
          const err = e as { responseCode?: number; message?: string; rejected?: string[] };
          throw new SetError(err.responseCode && err.responseCode >= 500 ? 'forbiddenToSend' : 'serverFail', err.message ?? 'SMTP error');
        } finally {
          t.close();
        }
        const id = `S${randomBase36(10)}`;
        const sub: Submission = {
          id,
          identityId,
          emailId,
          threadId: null,
          envelope: { mailFrom: { email: mailFrom, parameters: null }, rcptTo: rcpt.map((email) => ({ email, parameters: null })) },
          sendAt: utcDate(Date.now())!,
          undoStatus: 'final',
          deliveryStatus: null,
          dsnBlobIds: [],
          mdnBlobIds: [],
        };
        this.sent.set(id, sub);
        this.stateCounter++;
        subToEmail.set(`#${cid}`, emailId);
        subToEmail.set(id, emailId);
        onCreated(cid, id);
        created[cid] = { id, sendAt: sub.sendAt, undoStatus: 'final' };
      } catch (e) {
        if (e instanceof BackendAuthError || e instanceof BackendUnavailableError) throw e;
        notCreated[cid] = setErrorOf(e);
      }
    }

    const notUpdated: Record<string, unknown> = {};
    for (const id of isObject(args.update) ? Object.keys(args.update) : []) notUpdated[id] = { type: 'cannotUnsend', description: 'messages are sent immediately' };
    const notDestroyed: Record<string, unknown> = {};
    for (const id of Array.isArray(args.destroy) ? (args.destroy as string[]) : []) notDestroyed[id] = { type: 'forbidden' };

    // actions implicites sur les emails envoyés
    let emailSet: Record<string, unknown> | null = null;
    const update: Record<string, unknown> = {};
    const destroy: string[] = [];
    if (isObject(args.onSuccessUpdateEmail)) {
      for (const [ref, patch] of Object.entries(args.onSuccessUpdateEmail)) {
        const emailId = subToEmail.get(ref) ?? subToEmail.get(resolveId(ref));
        if (emailId && isObject(patch)) update[emailId] = patch;
      }
    }
    if (Array.isArray(args.onSuccessDestroyEmail)) {
      for (const ref of args.onSuccessDestroyEmail as string[]) {
        const emailId = subToEmail.get(ref) ?? subToEmail.get(resolveId(ref));
        if (emailId) destroy.push(emailId);
      }
    }
    if (Object.keys(update).length || destroy.length) emailSet = { update, destroy };

    return {
      response: {
        oldState,
        newState: this.state(),
        created: Object.keys(created).length ? created : null,
        updated: null,
        destroyed: null,
        notCreated: Object.keys(notCreated).length ? notCreated : null,
        notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
        notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
      },
      emailSet,
    };
  }
}
