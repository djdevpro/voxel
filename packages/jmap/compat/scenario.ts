/**
 * Scénario du banc de compatibilité : le même parcours, joué avec le client partagé (`JmapClient` et `fetch` de Node,
 * donc le même code de protocole que le web et le bureau), sur chaque serveur et sur la boîte de test.
 * Les étapes 12 à 15 relisent avec le code de l'interface, sans rien activer, et remettent la boîte en l'état.
 */
import { CAP, JmapClient, JmapError, buildManagedScript, parseManagedScript, sameManagedScript } from '../src/index.ts';
import type { FetchLike, Invocation, JmapResponse, Session } from '../src/index.ts';
import { expandEvent } from '../src/recurrence.ts';
// Espaces de noms : les fonctions de dialecte arrivent avec WP10 ; leur absence ne fait échouer que leur étape.
import * as jscalendar from '../src/jscalendar.ts';
import * as jscontact from '../src/jscontact.ts';

export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

/** Détail d'une étape sautée (capacité absente ou option) : affiché `—` dans le tableau. */
export const SKIPPED = '—';

/** Attente maximale d'un StateChange `Email` après l'envoi. */
const PUSH_TIMEOUT_MS = 15_000;
/** Attente maximale du message dans la Réception. */
const RECEIVE_TIMEOUT_MS = 30_000;
/** Intervalle de sondage de la Réception. */
const RECEIVE_POLL_MS = 250;
/** Nombre d'`Email/get` lancés ensemble à l'étape `limits`. */
const PARALLEL_GETS = 20;
/** Nombre d'identifiants inventés du gros `Email/get` (plus que `maxObjectsInGet` des serveurs mesurés). */
const FAKE_IDS = 600;
const DAY_MS = 86_400_000;

type O = Record<string, any>;

/**
 * `fetch` instrumenté : requêtes API et téléversements en vol, et, pour chaque requête API, nombre d'appels,
 * taille du corps, `ids` de chaque `…/get` et entrées de chaque `…/set`. Relève aussi chaque méthode appelée.
 */
function limitsProbe() {
  const stats = { inFlight: 0, maxInFlight: 0, uploadsInFlight: 0, maxUploadsInFlight: 0, maxCalls: 0, maxSize: 0, maxGet: 0, maxSet: 0, uploadMaxSize: 0 };
  const methods = new Set<string>();
  let apiUrl = '';
  let uploadPrefix = '';
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const isApi = !!apiUrl && url === apiUrl && init?.method === 'POST';
    const isUpload = !!uploadPrefix && url.startsWith(uploadPrefix) && init?.method === 'POST';
    if (isApi) {
      const body = String(init?.body ?? '');
      stats.maxSize = Math.max(stats.maxSize, Buffer.byteLength(body));
      const req = JSON.parse(body) as { methodCalls: Invocation[] };
      stats.maxCalls = Math.max(stats.maxCalls, req.methodCalls.length);
      for (const [name, args] of req.methodCalls as Array<[string, O, string]>) {
        methods.add(name);
        if (name.endsWith('/get') && Array.isArray(args.ids)) stats.maxGet = Math.max(stats.maxGet, args.ids.length);
        if (name.endsWith('/set')) {
          const n = Object.keys(args.create ?? {}).length + Object.keys(args.update ?? {}).length + (Array.isArray(args.destroy) ? args.destroy.length : 0);
          stats.maxSet = Math.max(stats.maxSet, n);
        }
      }
      stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight);
    }
    if (isUpload) {
      const b = init?.body;
      const size = b instanceof Uint8Array ? b.byteLength : b instanceof ArrayBuffer ? b.byteLength : typeof b === 'string' ? Buffer.byteLength(b) : b instanceof Blob ? b.size : 0;
      stats.uploadMaxSize = Math.max(stats.uploadMaxSize, size);
      stats.maxUploadsInFlight = Math.max(stats.maxUploadsInFlight, ++stats.uploadsInFlight);
    }
    try {
      const res = await fetch(url, init);
      // La réponse est lue par l'appelant : on attend son corps pour compter la requête « en vol » jusqu'au bout.
      if (!isApi && !isUpload) return res;
      const buf = await res.arrayBuffer();
      return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
    } finally {
      if (isApi) stats.inFlight--;
      if (isUpload) stats.uploadsInFlight--;
    }
  };
  return {
    fetch: fetchImpl,
    stats,
    methods,
    bind(s: Session, sessionUrl: string) {
      apiUrl = new URL(s.apiUrl, sessionUrl).href;
      uploadPrefix = new URL(s.uploadUrl.split('{')[0]!, sessionUrl).href;
    },
  };
}

const basic = (login: string, password: string) => 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');

/** Prochain lundi strictement après aujourd'hui (date UTC, `AAAA-MM-JJ`). */
function nextMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

export async function runScenario(target: {
  label: string;
  sessionUrl?: string;
  wellKnown?: string;
  login: string;
  password: string;
  push: boolean;
  absent: string[];
  checkWrongPassword: boolean;
}): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const subject = `Voxel compat ${run}`;
  const auth = basic(target.login, target.password);
  const probe = limitsProbe();
  let sessionUrl = target.sessionUrl ?? '';
  let client: JmapClient | undefined;
  let session: Session | undefined;

  const step = async (name: string, fn: () => Promise<string>): Promise<void> => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - t0, detail });
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message : String(e) });
    }
  };
  const skip = (name: string) => results.push({ name, ok: true, ms: 0, detail: SKIPPED });
  const need = <T>(v: T | undefined | null, what: string): T => {
    if (v === undefined || v === null) throw new Error(`${what} manquant (étape précédente en échec)`);
    return v;
  };
  const announced = (cap: string) => !!session && cap in session.capabilities;
  /** Lot d'appels envoyé par le client ; une réponse `error` fait échouer l'étape. */
  const req = async (calls: Invocation[]): Promise<JmapResponse['methodResponses']> => {
    const c = need(client, 'client');
    const res = await c.rawRequest({ using: c.usingFor(calls), methodCalls: calls });
    for (const [name, args] of res.methodResponses) if (name === 'error') throw new Error(`erreur de méthode : ${JSON.stringify(args).slice(0, 300)}`);
    return res.methodResponses;
  };
  const one = async (name: string, args: O): Promise<O> => (await req([[name, args, 'c'] as Invocation]))[0]![1] as O;
  const acc = (cap: string) => need(session, 'session').primaryAccounts[cap] ?? need(session, 'session').primaryAccounts[CAP.mail]!;

  // 1. session
  await step('session', async () => {
    if (!sessionUrl) {
      const r = await fetch(need(target.wellKnown, 'wellKnown'), { headers: { Authorization: auth }, redirect: 'follow' });
      await r.arrayBuffer();
      if (!r.ok) throw new Error(`découverte : HTTP ${r.status}`);
      sessionUrl = r.url;
    }
    client = new JmapClient({ sessionUrl, fetch: probe.fetch, headers: { Authorization: auth } });
    session = await client.getSession();
    probe.bind(session, sessionUrl);
    const cors = await fetch(sessionUrl, { headers: { Authorization: auth, Origin: 'http://tauri.localhost' } });
    await cors.arrayBuffer();
    return `cors: ${cors.headers.get('access-control-allow-origin') ?? 'none'}`;
  });

  // 2. wrong-password
  if (target.checkWrongPassword) {
    await step('wrong-password', async () => {
      const bad = new JmapClient({ sessionUrl: need(sessionUrl || undefined, 'URL de session'), headers: { Authorization: basic(target.login, `${target.password}-wrong`) } });
      try {
        await bad.getSession();
      } catch (e) {
        if (e instanceof JmapError && e.status === 401) return '401';
        throw e;
      }
      throw new Error('session ouverte avec un mauvais mot de passe');
    });
  } else skip('wrong-password');

  // 3. capabilities (le contrôle des méthodes appelées est refait à la fin, voir plus bas)
  await step('capabilities', async () => {
    const s = need(session, 'session');
    const present = target.absent.filter((c) => c in s.capabilities);
    if (present.length) throw new Error(`annoncées à tort : ${present.join(', ')}`);
    return target.absent.length ? `absentes : ${target.absent.map((c) => c.split(':').pop()).join(', ')}` : 'rien à vérifier';
  });

  // 4. mailboxes
  const roles: Record<string, string> = {};
  await step('mailboxes', async () => {
    const r = await one('Mailbox/get', { accountId: acc(CAP.mail), ids: null });
    for (const m of r.list as O[]) if (m.role && !roles[m.role]) roles[m.role] = m.id;
    const missing = ['inbox', 'drafts', 'sent'].filter((role) => !roles[role]);
    if (missing.length) throw new Error(`rôles manquants : ${missing.join(', ')}`);
    return `${(r.list as O[]).length} dossiers`;
  });

  // 5. upload
  const attachment = new Uint8Array(286);
  for (let i = 0; i < 256; i++) attachment[i] = i;
  attachment.set(new TextEncoder().encode('voxel compat attachment bytes\n'), 256);
  let uploadedBlobId: string | undefined;
  await step('upload', async () => {
    const r = await need(client, 'client').upload(acc(CAP.mail), attachment, 'application/octet-stream');
    if (r.size !== attachment.length) throw new Error(`taille ${r.size} au lieu de ${attachment.length}`);
    uploadedBlobId = r.blobId;
    return `${r.size} octets`;
  });

  // 7. push : flux ouvert avant l'envoi
  let closePush: (() => void) | undefined;
  let pushedAt: number | undefined;
  let pushError: unknown;
  let pushWaiter: (() => void) | undefined;
  if (target.push && client && session) {
    const mailAcc = acc(CAP.mail);
    try {
      closePush = await client.subscribe({
        types: ['Email'],
        onStateChange: (ch) => {
          if (ch.changed?.[mailAcc]?.Email && pushedAt === undefined) {
            pushedAt = Date.now();
            pushWaiter?.();
          }
        },
        onError: (e) => (pushError = e),
      });
    } catch (e) {
      pushError = e;
    }
  }

  // 6. send
  let address: string | undefined;
  let sentAt = 0;
  await step('send', async () => {
    const mailAcc = acc(CAP.mail);
    const ids = (await one('Identity/get', { accountId: mailAcc, ids: null })).list as O[];
    const identity = need(ids[0], 'identité');
    // Cyrus renvoie une identité sans adresse : on prend l'adresse de connexion.
    address = identity.email || target.login;
    const blobId = need(uploadedBlobId, 'blobId');
    const drafts = need(roles.drafts, 'Brouillons');
    const sent = need(roles.sent, 'Envoyés');
    sentAt = Date.now();
    const res = await req([
      [
        'Email/set',
        {
          accountId: mailAcc,
          create: {
            d: {
              mailboxIds: { [drafts]: true },
              keywords: { $draft: true, $seen: true },
              from: [{ name: 'Voxel Compat', email: address }],
              to: [{ name: 'Voxel Compat', email: address }],
              subject,
              bodyValues: { b: { value: `Message du banc de compatibilité Voxel (${run}).\n` } },
              textBody: [{ partId: 'b', type: 'text/plain' }],
              attachments: [{ blobId, type: 'application/octet-stream', name: 'voxel-compat.bin', disposition: 'attachment' }],
            },
          },
        },
        'e',
      ],
      [
        'EmailSubmission/set',
        {
          accountId: mailAcc,
          create: { s: { identityId: identity.id, emailId: '#d' } },
          onSuccessUpdateEmail: { '#s': { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null } },
        },
        's',
      ],
    ] as Invocation[]);
    const email = res.find(([n, , id]) => n === 'Email/set' && id === 'e')?.[1] as O | undefined;
    const sub = res.find(([n]) => n === 'EmailSubmission/set')?.[1] as O | undefined;
    if (!email?.created?.d) throw new Error(`brouillon refusé : ${JSON.stringify(email?.notCreated)}`);
    if (!sub?.created?.s) throw new Error(`envoi refusé : ${JSON.stringify(sub?.notCreated)}`);
    return 'brouillon et envoi en un lot';
  });

  // 7. push : résultat
  if (target.push) {
    await step('push', async () => {
      try {
        if (pushedAt === undefined && closePush) await new Promise<void>((r) => ((pushWaiter = r), setTimeout(r, Math.max(0, sentAt + PUSH_TIMEOUT_MS - Date.now()))));
      } finally {
        closePush?.();
      }
      if (!closePush) throw new Error(`flux non ouvert : ${String(pushError)}`);
      if (pushedAt === undefined) throw new Error(`aucun StateChange Email en ${PUSH_TIMEOUT_MS / 1000} s${pushError ? ` (${String(pushError)})` : ''}`);
      return `StateChange en ${pushedAt - sentAt} ms`;
    });
  } else skip('push');

  // 8. receive
  let receivedId: string | undefined;
  await step('receive', async () => {
    const inbox = need(roles.inbox, 'Réception');
    const t0 = Date.now();
    while (Date.now() - t0 < RECEIVE_TIMEOUT_MS) {
      const r = await one('Email/query', { accountId: acc(CAP.mail), filter: { inMailbox: inbox, subject } });
      if ((r.ids as string[]).length) {
        receivedId = r.ids[0];
        return `reçu en ${Date.now() - sentAt} ms`;
      }
      await new Promise((res) => setTimeout(res, RECEIVE_POLL_MS));
    }
    throw new Error(`absent de la Réception après ${RECEIVE_TIMEOUT_MS / 1000} s`);
  });

  // 9. read
  let receivedAttachment: O | undefined;
  await step('read', async () => {
    const r = await one('Email/get', {
      accountId: acc(CAP.mail),
      ids: [need(receivedId, 'message reçu')],
      properties: ['subject', 'from', 'attachments', 'bodyValues', 'textBody'],
      fetchTextBodyValues: true,
    });
    const e = need((r.list as O[])[0], 'message');
    if (e.subject !== subject) throw new Error(`sujet « ${e.subject} »`);
    if (!(e.from as O[] | null)?.some((f) => f.email?.toLowerCase() === address?.toLowerCase())) throw new Error(`expéditeur ${JSON.stringify(e.from)}`);
    const text = Object.values((e.bodyValues ?? {}) as O).map((v) => v.value as string).join('');
    if (!text.includes(run)) throw new Error('corps du message absent');
    receivedAttachment = ((e.attachments ?? []) as O[]).find((a) => a.name === 'voxel-compat.bin') ?? (e.attachments as O[] | undefined)?.[0];
    if (!receivedAttachment) throw new Error('pièce jointe absente');
    return `pièce jointe ${receivedAttachment.size} octets`;
  });

  // 10. download
  await step('download', async () => {
    const a = need(receivedAttachment, 'pièce jointe');
    const blob = await need(client, 'client').download(acc(CAP.mail), a.blobId, a.name ?? 'voxel-compat.bin', a.type ?? 'application/octet-stream');
    const got = new Uint8Array(await blob.arrayBuffer());
    if (got.length !== attachment.length || got.some((b, i) => b !== attachment[i])) throw new Error(`octets différents (${got.length} reçus)`);
    return `${got.length} octets identiques`;
  });

  const checkLimits = (): string => {
    const core = need(session, 'session').capabilities[CAP.core] as O;
    const s = probe.stats;
    const over = [
      ['requêtes en vol', s.maxInFlight, core.maxConcurrentRequests],
      ['appels par requête', s.maxCalls, core.maxCallsInRequest],
      ['taille de requête', s.maxSize, core.maxSizeRequest],
      ['objets par get', s.maxGet, core.maxObjectsInGet],
      ['objets par set', s.maxSet, core.maxObjectsInSet],
      ['téléversements en vol', s.maxUploadsInFlight, core.maxConcurrentUpload],
      ['taille de téléversement', s.uploadMaxSize, core.maxSizeUpload],
    ].filter(([, used, max]) => typeof max === 'number' && (used as number) > max);
    if (over.length) throw new Error(`limite dépassée : ${over.map(([n, u, m]) => `${n} ${u} > ${m}`).join(', ')}`);
    return `max en vol ${s.maxInFlight}, appels ${s.maxCalls}, get ${s.maxGet}, set ${s.maxSet}, téléversements ${s.maxUploadsInFlight}`;
  };


  // 11. limits
  await step('limits', async () => {
    const mailAcc = acc(CAP.mail);
    const id = need(receivedId, 'message reçu');
    const gets = await Promise.all(Array.from({ length: PARALLEL_GETS }, () => one('Email/get', { accountId: mailAcc, ids: [id], properties: ['subject'] })));
    if (gets.some((g) => (g.list as O[]).length !== 1)) throw new Error('Email/get parallèle incomplet');
    const fake = Array.from({ length: FAKE_IDS }, (_, i) => `voxelcompat${run}${i}`);
    const res = await req([['Email/get', { accountId: mailAcc, ids: fake, properties: ['subject'] }, 'g'] as Invocation]);
    const notFound = res.filter(([n]) => n === 'Email/get').reduce((n, [, a]) => n + ((a as O).notFound as string[]).length, 0);
    if (notFound !== FAKE_IDS) throw new Error(`notFound ${notFound} au lieu de ${FAKE_IDS}`);
    return checkLimits();
  });
  // 12. contacts
  if (announced(CAP.contacts)) {
    await step('contacts', async () => {
      const a = acc(CAP.contacts);
      const books = (await one('AddressBook/get', { accountId: a, ids: null })).list as O[];
      const book = need(books[0], 'carnet');
      for (const card of (await one('ContactCard/get', { accountId: a, ids: null })).list as O[]) jscontact.cardDisplayName(jscontact.fromServerCard(card));
      const card = {
        addressBookIds: { [book.id]: true },
        '@type': 'Card',
        uid: `voxel-compat-${run}`,
        name: { full: 'Voxel Compat', components: [{ kind: 'given', value: 'Voxel' }, { kind: 'surname', value: 'Compat' }] },
        emails: { e1: { address: `compat-${run}@example.com`, contexts: { work: true } }, e2: { address: `pref-${run}@example.com`, pref: 1 } },
        phones: { p1: { number: '+33 6 00 00 00 00', features: { mobile: true } } },
        anniversaries: { n1: { kind: 'birth', date: { '@type': 'PartialDate', month: 2, day: 29 } } },
      };
      const set = await one('ContactCard/set', jscontact.toServerCardSet({ accountId: a, create: { c: card } }));
      const id = set.created?.c?.id as string | undefined;
      if (!id) throw new Error(`fiche refusée : ${JSON.stringify(set.notCreated)}`);
      try {
        const c = jscontact.fromServerCard(need(((await one('ContactCard/get', { accountId: a, ids: [id] })).list as O[])[0], 'fiche relue'));
        const name = jscontact.cardDisplayName(c);
        if (name !== 'Voxel Compat') throw new Error(`nom « ${name} »`);
        const emails = jscontact.cardEmails(c);
        if (JSON.stringify(emails) !== JSON.stringify([`pref-${run}@example.com`, `compat-${run}@example.com`])) throw new Error(`adresses ${JSON.stringify(emails)}`);
        const phone = Object.values((c.phones ?? {}) as O)[0] as O | undefined;
        if (phone?.number !== '+33 6 00 00 00 00' || phone.features?.mobile !== true) throw new Error(`téléphone ${JSON.stringify(phone)}`);
        const birth = (Object.values((c.anniversaries ?? {}) as O) as O[]).find((x) => x.kind === 'birth');
        if (birth?.date?.month !== 2 || birth.date.day !== 29 || birth.date.year !== undefined) throw new Error(`anniversaire ${JSON.stringify(birth?.date)}`);
      } finally {
        const d = await one('ContactCard/set', { accountId: a, destroy: [id] });
        if (!(d.destroyed as string[] | null)?.includes(id)) throw new Error(`fiche non détruite : ${JSON.stringify(d.notDestroyed)}`);
      }
      return `${books.length} carnet(s), fiche relue et détruite`;
    });
  } else skip('contacts');

  // 13. calendar
  if (announced(CAP.calendars)) {
    await step('calendar', async () => {
      const a = acc(CAP.calendars);
      const cals = (await one('Calendar/get', { accountId: a, ids: null })).list as O[];
      const cal = need(cals[0], 'agenda');
      const now = Date.now();
      const q = await one('CalendarEvent/query', { accountId: a, limit: 50 });
      if ((q.ids as string[]).length) {
        for (const ev of (await one('CalendarEvent/get', { accountId: a, ids: q.ids })).list as O[]) expandEvent(jscalendar.fromServerEvent(ev), now, now + 31 * DAY_MS);
      }
      const me = `mailto:${need(address, 'adresse de l’identité')}`;
      const start = `${nextMonday()}T10:00:00`;
      const event = {
        calendarIds: { [cal.id]: true },
        '@type': 'Event',
        uid: `voxel-compat-${run}`,
        title: subject,
        start,
        timeZone: 'Europe/Paris',
        duration: 'PT1H',
        recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 3, byDay: [{ '@type': 'NDay', day: 'mo' }] }],
        participants: {
          owner: { '@type': 'Participant', calendarAddress: me, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
          p1: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.com', roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true },
        },
        organizerCalendarAddress: me,
      };
      const set = await one('CalendarEvent/set', jscalendar.toServerEventSet({ accountId: a, create: { e: event } }));
      const id = set.created?.e?.id as string | undefined;
      if (!id) throw new Error(`événement refusé : ${JSON.stringify(set.notCreated)}`);
      const from = Date.parse(`${start}Z`) - DAY_MS;
      const to = Date.parse(`${start}Z`) + 30 * DAY_MS;
      const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
      try {
        const raw = need(((await one('CalendarEvent/get', { accountId: a, ids: [id] })).list as O[])[0], 'événement relu');
        if (!('recurrenceRule' in raw)) throw new Error('réponse brute sans recurrenceRule');
        const ev = jscalendar.fromServerEvent(raw) as O;
        const occ = expandEvent(ev as never, from, to);
        if (occ.length !== 3) throw new Error(`${occ.length} occurrences au lieu de 3`);
        const bad = occ.map((o) => fmt.format(o.start)).filter((t) => t !== 'Mon 10:00');
        if (bad.length) throw new Error(`horaires ${bad.join(', ')}`);
        if (!jscalendar.findParticipant(ev as never, 'bob@example.com')) throw new Error('participant bob absent');
        const patch = jscalendar.eventPatch(ev, { ...ev, recurrenceRules: [{ ...ev.recurrenceRules[0], count: 2 }] });
        const up = await one('CalendarEvent/set', jscalendar.toServerEventSet({ accountId: a, update: { [id]: patch } }));
        if (!up.updated || !(id in up.updated)) throw new Error(`modification refusée : ${JSON.stringify(up.notUpdated)}`);
        const raw2 = need(((await one('CalendarEvent/get', { accountId: a, ids: [id] })).list as O[])[0], 'événement modifié');
        const occ2 = expandEvent(jscalendar.fromServerEvent(raw2) as never, from, to);
        if (occ2.length !== 2) throw new Error(`${occ2.length} occurrences après modification au lieu de 2`);
      } finally {
        const d = await one('CalendarEvent/set', { accountId: a, destroy: [id] });
        if (!(d.destroyed as string[] | null)?.includes(id)) throw new Error(`événement non détruit : ${JSON.stringify(d.notDestroyed)}`);
      }
      return `${cals.length} agenda(s), série 3 → 2 lundis, détruite`;
    });
  } else skip('calendar');

  // 14. sieve
  if (announced(CAP.sieve)) {
    await step('sieve', async () => {
      const a = acc(CAP.sieve);
      const c = need(client, 'client');
      const listScripts = async () => (await one('SieveScript/get', { accountId: a, ids: null })).list as O[];
      const before = await listScripts();
      const names = before.map((x) => x.name as string).sort();
      const active = before.find((x) => x.isActive)?.id ?? null;
      const cap = (need(session, 'session').accounts[a]?.accountCapabilities[CAP.sieve] ?? {}) as O;
      const model = {
        blocklist: { addresses: [], domains: [] },
        vacation: null,
        filters: [{ id: 'f1', name: 'Voxel compat', enabled: true, match: 'all' as const, conditions: [{ field: 'subject' as const, op: 'contains' as const, value: `voxel-compat-${run}` }], actions: [{ type: 'flag' as const }] }],
      };
      const text = buildManagedScript(model, { extensions: cap.sieveExtensions ?? [], maxSize: cap.maxSizeScript ?? null });
      const blob = await c.upload(a, new TextEncoder().encode(text), 'application/sieve');
      const v = await one('SieveScript/validate', { accountId: a, blobId: blob.blobId });
      if (v.error !== null) throw new Error(`script invalide : ${JSON.stringify(v.error)}`);
      const set = await one('SieveScript/set', { accountId: a, create: { s: { name: `voxel-compat-${run}`, blobId: blob.blobId } } });
      const id = set.created?.s?.id as string | undefined;
      if (!id) throw new Error(`script refusé : ${JSON.stringify(set.notCreated)}`);
      try {
        const got = need(((await one('SieveScript/get', { accountId: a, ids: [id] })).list as O[])[0], 'script relu');
        if (got.isActive !== false) throw new Error('script actif');
        const back = await (await c.download(a, got.blobId, 'script.sieve', 'application/sieve')).text();
        if (!sameManagedScript(back, text)) throw new Error('texte relu différent');
        if (JSON.stringify(parseManagedScript(back)?.filters) !== JSON.stringify(parseManagedScript(text)?.filters)) throw new Error('filtres relus différents');
      } finally {
        await one('SieveScript/set', { accountId: a, destroy: [id] });
        const after = await listScripts();
        if (JSON.stringify(after.map((x) => x.name as string).sort()) !== JSON.stringify(names)) throw new Error(`scripts après nettoyage : ${after.map((x) => x.name).join(', ')}`);
        if ((after.find((x) => x.isActive)?.id ?? null) !== active) throw new Error('script actif changé');
      }
      return `${before.length} script(s) avant, script créé inactif, relu et détruit`;
    });
  } else skip('sieve');

  // 15. vacation
  if (announced(CAP.vacation)) {
    await step('vacation', async () => {
      const a = acc(CAP.vacation);
      const getVacation = async () => need(((await one('VacationResponse/get', { accountId: a, ids: ['singleton'] })).list as O[])[0], 'répondeur');
      const sieveAcc = announced(CAP.sieve) ? acc(CAP.sieve) : undefined;
      const scriptNames = async () => ((await one('SieveScript/get', { accountId: sieveAcc, ids: null })).list as O[]).map((x) => ({ id: x.id as string, name: x.name as string, isActive: x.isActive as boolean }));
      const orig = await getVacation();
      const namesBefore = sieveAcc ? await scriptNames() : [];
      try {
        const u = await one('VacationResponse/set', { accountId: a, update: { singleton: { subject, textBody: subject, isEnabled: false } } });
        if (!u.updated || !('singleton' in u.updated)) throw new Error(`écriture refusée : ${JSON.stringify(u.notUpdated)}`);
        const g = await getVacation();
        if (g.subject !== subject || g.textBody !== subject || g.isEnabled !== false) throw new Error(`relu ${JSON.stringify({ subject: g.subject, textBody: g.textBody, isEnabled: g.isEnabled })}`);
      } finally {
        // James n'envoie pas les propriétés nulles : on remet à `null` celles écrites ici et absentes de `orig` (C4).
        const { id: _id, ...restore } = orig;
        for (const k of ['subject', 'textBody']) if (!(k in restore)) restore[k] = null;
        await one('VacationResponse/set', { accountId: a, update: { singleton: restore } });
        const back = await getVacation();
        if (JSON.stringify(back) !== JSON.stringify(orig)) throw new Error('répondeur non restauré');
        if (sieveAcc) {
          const had = new Set(namesBefore.map((x) => x.name));
          const extra = (await scriptNames()).filter((x) => x.name === 'vacation' && !x.isActive && !had.has('vacation'));
          if (extra.length) await one('SieveScript/set', { accountId: sieveAcc, destroy: extra.map((x) => x.id) });
          const after = (await scriptNames()).map((x) => x.name).sort();
          if (JSON.stringify(after) !== JSON.stringify([...had].sort())) throw new Error(`scripts après nettoyage : ${after.join(', ')}`);
        }
      }
      return 'écrit inactif, relu, restauré à l’identique';
    });
  } else skip('vacation');

  // 16. cleanup
  await step('cleanup', async () => {
    const mailAcc = acc(CAP.mail);
    const q = await one('Email/query', { accountId: mailAcc, filter: { subject } });
    const ids = q.ids as string[];
    if (!ids.length) return 'rien à détruire';
    const d = await one('Email/set', { accountId: mailAcc, destroy: ids });
    if (d.notDestroyed && Object.keys(d.notDestroyed).length) throw new Error(`non détruits : ${JSON.stringify(d.notDestroyed)}`);
    return `${ids.length} message(s) détruit(s)`;
  });

  // 3. capabilities (suite) : aucune méthode d'une capacité absente n'a été appelée pendant le scénario.
  const capStep = results.find((r) => r.name === 'capabilities');
  if (capStep?.ok && client) {
    const c = client;
    const used = [...probe.methods].filter((m) => c.usingFor([[m, {}, 'x'] as Invocation]).some((cap) => target.absent.includes(cap)));
    if (used.length) Object.assign(capStep, { ok: false, detail: `méthodes appelées malgré l'absence : ${used.join(', ')}` });
  }
  return results;
}
