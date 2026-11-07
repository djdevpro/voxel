/**
 * Auto-test du bureau : Rust (binaire de débogage seulement) envoie des étapes `selftest:step`,
 * l'interface les joue avec les fonctions de l'appli et répond `selftest:done`. Jamais chargé sur le web
 * ni dans l'appli publiée (import dynamique, conditionné par `desktop_info`).
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { CAP, type Email, type Identity } from '@voxel/jmap';
import { platformFetch } from '@/lib/platform';
import { authHeader, capabilitiesOf, listAccounts, loginAccount, peekSession } from '@/lib/accounts';
import { jmap } from '@/lib/jmap';
import { getMailboxData, roleId } from '@/lib/mail';
import { createMailbox, invalidateAccount } from '@/lib/actions';
import { afterLogin, logoutMailbox } from '@/components/auth/session';
import { startCompose } from '@/components/compose/startCompose';
import { EmailFrame } from '@/components/reader/EmailFrame';
import { applySearch, closeSettings, goFolder, goTarget, inboxTarget, openSettings, openThread } from '@/nav/nav';
import { useUi } from '@/store/ui';
import { useSettings } from '@/store/settings';
import i18n from '@/i18n';
import { fetchQuota } from '@/hooks/useQuota';

/** HTML piège de l'étape `trap` : rien ne doit s'y exécuter ni atteindre l'IPC. */
const TRAP_HTML = `<p>Voxel trap</p>
<script>window.parent.__voxelTrap = 'script'; window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke('desktop_info');</script>
<img src="x" onerror="window.parent.__voxelTrap = 'onerror'">
<a id="js" href="javascript:window.parent.__voxelTrap='href'">lien</a>
<iframe src="data:text/html,<script>parent.parent.__voxelTrap='iframe'</script>"></iframe>
<form action="http://127.0.0.1:9/"><input name="a"></form>
<object data="data:text/html,x"></object>`;

/** Nom du dossier créé quand la boîte n'a pas de dossier Archives. */
const SELFTEST_FOLDER = 'Voxel selftest';

type Args = Record<string, unknown>;
type Data = Record<string, unknown> | undefined;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs: number, everyMs = 500): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await wait(everyMs);
  }
}

const textOnPage = (s: string) => document.body.innerText.includes(s);

/** Compte connecté par l'étape `login`, utilisé par les suivantes. */
let accountId = '';

const str = (a: Args, k: string) => String(a[k] ?? '');
const errorToasts = () => document.querySelectorAll('[data-sonner-toast][data-type="error"]').length;
const hasMeter = () => !!document.querySelector('[role="meter"]');

function navButton(navLabel: string, label: string): boolean {
  const nav = document.querySelector(`nav[aria-label="${CSS.escape(navLabel)}"]`);
  return !!nav && [...nav.querySelectorAll('[aria-label]')].some((b) => b.getAttribute('aria-label')?.split(', ')[0] === label);
}

function navEntry(navLabel: string, label: string): boolean {
  const nav = document.querySelector(`nav[aria-label="${CSS.escape(navLabel)}"]`);
  return !!nav && [...nav.querySelectorAll('button, a')].some((b) => (b as HTMLElement).innerText.trim() === label);
}

async function inboxEmail(subject: string): Promise<Email | undefined> {
  const c = jmap(accountId);
  const data = await getMailboxData(accountId);
  const inbox = roleId(data, 'inbox');
  const b = c.batch();
  const q = b.call('Email/query', { accountId: data.jmapAccountId, filter: { inMailbox: inbox, subject } as never, sort: [{ property: 'receivedAt', isAscending: false }], limit: 1 });
  const g = b.call('Email/get', { accountId: data.jmapAccountId, '#ids': q.ref('/ids'), properties: ['id', 'threadId', 'attachments'] } as never);
  await b.send();
  return (g.result as unknown as { list: Email[] }).list[0];
}

const steps: Record<string, (a: Args) => Promise<Data>> = {
  async environment() {
    // CSP appliquée : un script en ligne est bloqué et signalé (WebView2 laisse passer `new Function`)
    const violations: string[] = [];
    const onViolation = (e: SecurityPolicyViolationEvent) => {
      violations.push(e.effectiveDirective);
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    const probe = document.createElement('script');
    probe.textContent = 'window.__voxelCspProbe = 1';
    document.head.appendChild(probe);
    await wait(300);
    probe.remove();
    document.removeEventListener('securitypolicyviolation', onViolation);
    const csp = (window as unknown as { __voxelCspProbe?: number }).__voxelCspProbe === undefined && violations.some((d) => d.startsWith('script-src'));
    let evalAllowed = true;
    try {
      new Function('return 1');
    } catch {
      evalAllowed = false;
    }
    const serviceWorkers = 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0;
    const res = await fetch('/config.json', { cache: 'no-cache' });
    let configOk = false;
    try {
      const j = (await res.json()) as unknown;
      configOk = !!j && typeof j === 'object' && 'jmap' in j;
    } catch {
      configOk = false;
    }
    return { origin: location.origin, csp, evalAllowed, serviceWorkers, configStatus: res.status, configOk, prod: import.meta.env.PROD };
  },

  async login(a) {
    const email = str(a, 'email');
    let sessionUrl = typeof a.sessionUrl === 'string' ? a.sessionUrl : null;
    if (!sessionUrl) {
      const res = await platformFetch('/imap/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = (await res.json()) as { protocol?: string; sessionUrl?: string };
      if (d?.protocol !== 'jmap' || !d.sessionUrl) throw new Error(`discover: ${d?.protocol ?? 'none'}`);
      sessionUrl = d.sessionUrl;
    }
    const mailbox = await loginAccount({ email, protocol: 'jmap', sessionUrl, password: str(a, 'password'), remember: true });
    accountId = mailbox.id;
    await afterLogin(mailbox);
    goTarget(inboxTarget(mailbox.id));
    const data = await getMailboxData(mailbox.id);
    await wait(1500);
    return { accountId, jmapAccountId: data.jmapAccountId, sessionUrl };
  },

  async folders() {
    const data = await getMailboxData(accountId);
    return { count: data.mailboxes.length, roles: data.mailboxes.map((m) => m.role).filter(Boolean) };
  },

  async compose(a) {
    startCompose({ accountId, to: [{ name: null, email: str(a, 'to') }] as never, subject: str(a, 'subject') });
    await wait(1000);
    return undefined;
  },

  async send(a) {
    const ui = useUi.getState();
    for (const c of ui.composers) ui.closeComposer(c.id);
    const c = jmap(accountId);
    const data = await getMailboxData(accountId);
    const acc = data.jmapAccountId;
    const identities = (await c.call('Identity/get', { accountId: acc } as never)) as unknown as { list: Identity[] };
    const identity = identities.list[0];
    if (!identity) throw new Error('no identity');
    const bytes = Uint8Array.from(atob(str(a, 'attachmentBase64')), (ch) => ch.charCodeAt(0));
    const up = await c.upload(acc, bytes, 'text/plain');
    const drafts = roleId(data, 'drafts');
    const sent = roleId(data, 'sent');
    if (!drafts || !sent) throw new Error('no drafts/sent');
    const b = c.batch();
    const created = b.call('Email/set', {
      accountId: acc,
      create: {
        draft: {
          mailboxIds: { [drafts]: true },
          keywords: { $draft: true, $seen: true },
          from: [{ name: identity.name, email: identity.email }],
          to: [{ email: str(a, 'to') }],
          subject: str(a, 'subject'),
          bodyValues: { t: { value: str(a, 'text') } },
          textBody: [{ partId: 't', type: 'text/plain' }],
          attachments: [{ blobId: up.blobId, type: 'text/plain', name: str(a, 'attachmentName'), disposition: 'attachment' }],
        },
      },
    } as never);
    b.call('EmailSubmission/set', {
      accountId: acc,
      create: { sub: { identityId: identity.id, emailId: '#draft' } },
      onSuccessUpdateEmail: { '#sub': { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null } },
    } as never);
    b.using(CAP.submission);
    await b.send();
    const r = created.result as unknown as { created?: Record<string, { id: string }>; notCreated?: Record<string, { type: string }> };
    const draftId = r.created?.draft?.id;
    if (!draftId) throw new Error(`Email/set: ${r.notCreated?.draft?.type ?? 'failed'}`);
    return { draftId };
  },

  /** Message de la Réception par son objet (ménage de l'étape « fenêtre fermée »). */
  async lookup(a) {
    const e = await inboxEmail(str(a, 'subject'));
    return e ? { emailId: e.id } : undefined;
  },

  async receive(a) {
    const started = Date.now();
    goTarget(inboxTarget(accountId));
    const subject = str(a, 'subject');
    await waitFor(() => !!document.querySelector<HTMLElement>('[data-scroll-restoration-id="thread-list"]')?.innerText.includes(subject), Number(a.timeoutMs) || 60000);
    return { elapsedMs: Date.now() - started };
  },

  async open(a) {
    const e = await inboxEmail(str(a, 'subject'));
    if (!e) throw new Error('message not found');
    openThread({ accountId, threadId: e.threadId, emailId: e.id });
    await wait(1500);
    const att = e.attachments?.[0];
    const data = await getMailboxData(accountId);
    return {
      emailId: e.id,
      attachment: att?.blobId
        ? { name: att.name ?? 'file', type: att.type, url: jmap(accountId).downloadUrl(data.jmapAccountId, att.blobId, att.name ?? 'file', att.type), headers: authHeader(accountId) }
        : null,
    };
  },

  async search(a) {
    const subject = str(a, 'subject');
    applySearch({ chips: [], text: subject });
    await waitFor(() => textOnPage(subject), 15000);
    return undefined;
  },

  async mark(a) {
    const data = await getMailboxData(accountId);
    await jmap(accountId).call('Email/set', { accountId: data.jmapAccountId, update: { [str(a, 'emailId')]: { 'keywords/$seen': null, 'keywords/$flagged': true } } } as never);
    invalidateAccount(accountId, 0);
    await wait(1500);
    return undefined;
  },

  async move(a) {
    const data = await getMailboxData(accountId);
    let mailboxId = roleId(data, 'archive');
    let created = false;
    if (!mailboxId) {
      mailboxId = await createMailbox(accountId, SELFTEST_FOLDER, null);
      created = true;
    }
    if (!mailboxId) throw new Error('no target folder');
    await jmap(accountId).call('Email/set', { accountId: data.jmapAccountId, update: { [str(a, 'emailId')]: { mailboxIds: { [mailboxId]: true } } } } as never);
    goFolder({ kind: 'id', id: mailboxId });
    await wait(1500);
    return { mailboxId, created };
  },

  async trap() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px;height:400px';
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(createElement(EmailFrame, { html: TRAP_HTML, allowRemote: false, cidMap: {}, accountId }));
    try {
      await wait(2000);
      const iframe = host.querySelector('iframe');
      if (!iframe) throw new Error('no iframe');
      const sandbox = iframe.getAttribute('sandbox') ?? '';
      let ipcInFrame = false;
      try {
        ipcInFrame = (iframe.contentWindow as (Window & { __TAURI_INTERNALS__?: unknown }) | null)?.__TAURI_INTERNALS__ !== undefined;
      } catch {
        ipcInFrame = false; // cadre d'une autre origine : inaccessible
      }
      const trapRan = (window as Window & { __voxelTrap?: unknown }).__voxelTrap !== undefined;
      // appel IPC depuis le cadre du mail (son `invoke`, son `fetch`, son `window.chrome`) : la coque ne doit jamais répondre
      let tauri: { invoke?: (c: string, a?: unknown) => Promise<unknown> } | undefined;
      try {
        tauri = (iframe.contentWindow as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } })?.__TAURI_INTERNALS__;
      } catch {
        tauri = undefined; // cadre d'une autre origine : inaccessible
      }
      const frameIpc = tauri?.invoke
        ? await Promise.race([tauri.invoke('notify', { title: 'Voxel trap', body: '' }).then(() => 'answered', () => 'refused'), wait(3000).then(() => 'timeout')])
        : 'absent';
      const data = { sandbox, ipcInFrame, trapRan, frameIpc };
      // wry injecte l'IPC dans toutes les iframes sous Windows : `ipcInFrame` reste informatif
      if (sandbox.includes('allow-scripts') || trapRan || frameIpc === 'answered') return { ok: false, data } as never;
      return data;
    } finally {
      root.unmount();
      host.remove();
    }
  },

  async delete(a) {
    const c = jmap(accountId);
    const data = await getMailboxData(accountId);
    const sent = roleId(data, 'sent');
    const emailId = str(a, 'emailId');
    const subject = (await c.call('Email/get', { accountId: data.jmapAccountId, ids: [emailId], properties: ['subject'] } as never)) as unknown as { list: Email[] };
    const subj = subject.list[0]?.subject;
    const ids = [emailId];
    if (sent && subj) {
      const q = (await c.call('Email/query', { accountId: data.jmapAccountId, filter: { inMailbox: sent, subject: subj } } as never)) as unknown as { ids: string[] };
      ids.push(...q.ids);
    }
    await c.call('Email/set', { accountId: data.jmapAccountId, destroy: ids } as never);
    if (a.createdFolder === true && typeof a.mailboxId === 'string') {
      await c.call('Mailbox/set', { accountId: data.jmapAccountId, destroy: [a.mailboxId], onDestroyRemoveEmails: true } as never);
    }
    invalidateAccount(accountId, 0);
    await wait(1000);
    return undefined;
  },

  async settings() {
    openSettings('reading');
    await wait(1500);
    const pushHidden = !textOnPage(i18n.t('settings:reading.push.title'));
    const mailtoHidden = !textOnPage(i18n.t('appearance:reading.mailto.title'));
    const sw = document.querySelector(`[aria-label="${CSS.escape(i18n.t('appearance:reading.notifications.title'))}"]`);
    const notificationsOn = sw?.getAttribute('data-state') === 'checked';
    useSettings.getState().set({ theme: 'dark' });
    const data = { pushHidden, mailtoHidden, notificationsOn };
    if (!pushHidden || !mailtoHidden || !notificationsOn) return { ok: false, data } as never;
    return data;
  },

  async features() {
    closeSettings();
    goTarget(inboxTarget(accountId));
    await wait(1500);
    const caps = capabilitiesOf(peekSession(accountId));
    const rail = i18n.t('accounts:rail.label');
    // la jauge n'apparaît que pour un quota avec une limite
    const expected = { quota: caps.quota && (await fetchQuota(accountId)) !== null };
    await waitFor(() => hasMeter() === expected.quota, 10000).catch(() => undefined);
    const announced = { calendars: !!caps.calendars, contacts: caps.contacts, quota: caps.quota };
    const shown = { calendars: navButton(rail, i18n.t('calendar:nav')), contacts: navButton(rail, i18n.t('contacts:nav')), quota: hasMeter() };
    const toasts = errorToasts();
    const data = { announced, expected, shown, errorToasts: toasts };
    const same = announced.calendars === shown.calendars && announced.contacts === shown.contacts && expected.quota === shown.quota;
    if (!same || toasts !== 0) return { ok: false, data } as never;
    return data;
  },

  async sections() {
    openSettings('accounts');
    await wait(1500);
    const caps = capabilitiesOf(peekSession(accountId));
    const expected = { quota: caps.quota && (await fetchQuota(accountId)) !== null };
    const nav = i18n.t('settings:sections');
    const announced = { vacation: caps.vacation, sieve: caps.sieve, quota: caps.quota };
    const shown = {
      vacation: navEntry(nav, i18n.t('settings:tabs.vacation')),
      filters: navEntry(nav, i18n.t('settings:tabs.filters')),
      blocked: navEntry(nav, i18n.t('settings:tabs.blocked')),
      quota: hasMeter(),
    };
    const toasts = errorToasts();
    const data = { announced, expected, shown, errorToasts: toasts };
    const same = shown.vacation === (caps.vacation || caps.sieve) && shown.filters === caps.sieve && shown.blocked === caps.sieve && shown.quota === expected.quota;
    if (!same || toasts !== 0) return { ok: false, data } as never;
    return data;
  },

  async resume(a) {
    const email = str(a, 'email');
    const account = (await listAccounts()).find((m) => m.email === email);
    const unlocked = !!account;
    const themeKept = useSettings.getState().theme === 'dark';
    if (account) {
      accountId = account.id;
      goTarget(inboxTarget(account.id));
    }
    await wait(2000);
    const data = { unlocked, themeKept };
    if (!unlocked || !themeKept) return { ok: false, data } as never;
    return data;
  },

  async cleanup(a) {
    const account = (await listAccounts()).find((m) => m.email === str(a, 'email'));
    if (account) await logoutMailbox(account.id);
    await wait(1000);
    return undefined;
  },
};

/** Message court d'une exception, sans secret (jamais d'en-tête ni de mot de passe). */
function shortMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 200);
}

export async function startSelftest(): Promise<void> {
  const { listen, emit } = await import('@tauri-apps/api/event');
  await listen<{ id: number; name: string; args: Args }>('selftest:step', async ({ payload }) => {
    const { id, name, args } = payload;
    const run = steps[name];
    if (!run) {
      await emit('selftest:done', { id, ok: false, detail: `unknown step ${name}` });
      return;
    }
    try {
      const r = (await run(args ?? {})) as Data | { ok: false; data: Data };
      if (r && (r as { ok?: unknown }).ok === false) {
        await emit('selftest:done', { id, ok: false, detail: `${name}: check failed`, data: (r as { data: Data }).data });
        return;
      }
      await emit('selftest:done', { id, ok: true, detail: name, ...(r ? { data: r } : {}) });
    } catch (e) {
      await emit('selftest:done', { id, ok: false, detail: shortMessage(e) });
    }
  });
  await emit('selftest:ready');
}
