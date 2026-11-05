/**
 * Serveurs JMAP du banc de compatibilité : URL de découverte, utilisateurs de test locaux, disponibilité,
 * provisionnement et capacités attendues absentes (CA5). Faits mesurés le 2026-11-04.
 */
import { readFileSync } from 'node:fs';

export interface CompatServer {
  name: 'stalwart' | 'cyrus' | 'james' | 'james-minimal';
  /** URL de découverte, suivie comme le ferait un client (redirection vers la session). */
  wellKnown: string;
  users: Array<{ login: string; password: string }>; // alice puis bob
  ready: string; // URL de disponibilité
  provision(): Promise<void>;
  /** Le flux EventSource du serveur est-il utilisable ? */
  push: boolean;
  /** Capacités qui doivent manquer (CA5). */
  absent: string[];
}

/** Identifiants de test locaux du banc (pas des secrets). */
const USERS = [
  { login: 'alice@example.com', password: 'alice-Pass-2026' },
  { login: 'bob@example.com', password: 'bob-Pass-2026' },
];

/** Administrateur de secours de Stalwart, fixé dans `compose.yaml`. */
const STALWART_ADMIN = 'admin:CompatAdmin-2026';

/** Mot de passe de l'API d'administration de James, fixé dans `james-webadmin.properties`. */
const JAMES_WEBADMIN_PASSWORD = 'compat-webadmin-2026';

const basic = (pair: string) => 'Basic ' + Buffer.from(pair).toString('base64');

async function expectStatus(res: Response, ok: number[], what: string): Promise<void> {
  const text = await res.text();
  if (!ok.includes(res.status)) throw new Error(`${what} : HTTP ${res.status} ${text.slice(0, 300)}`);
}

async function provisionStalwart(): Promise<void> {
  const accounts = Object.fromEntries(
    USERS.map(({ login, password }) => {
      const name = login.split('@')[0]!;
      const description = `${name[0]!.toUpperCase()}${name.slice(1)} Compat`;
      return [name, { '@type': 'User', name, domainId: '#dom', description, credentials: { '0': { '@type': 'Password', secret: password } } }];
    }),
  );
  const res = await fetch('http://127.0.0.1:18480/jmap/', {
    method: 'POST',
    headers: { Authorization: basic(STALWART_ADMIN), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
      methodCalls: [
        ['x:Domain/set', { create: { dom: { name: 'example.com' } } }, 'd'],
        ['x:Account/set', { create: accounts }, 'a'],
        ['x:SystemSettings/set', { update: { singleton: { defaultHostname: 'mail.example.com', defaultDomainId: '#dom' } } }, 's'],
      ],
    }),
  });
  if (!res.ok) throw new Error(`provisionnement stalwart : HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { methodResponses: Array<[string, Record<string, unknown>, string]> };
  for (const [name, args] of body.methodResponses) {
    if (name === 'error' || args.notCreated || args.notUpdated) throw new Error(`provisionnement stalwart : ${name} ${JSON.stringify(args).slice(0, 300)}`);
  }
}

async function provisionCyrus(): Promise<void> {
  // Jamais de corps vide : le serveur de gestion de l'image se bloque ~50 s.
  const body = readFileSync(new URL('./cyrus-mailboxes.json', import.meta.url), 'utf8');
  for (const { login } of USERS) {
    const local = login.split('@')[0]!;
    const res = await fetch(`http://127.0.0.1:18501/api/${local}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    await expectStatus(res, [204], `provisionnement cyrus (${local})`);
  }
}

function provisionJames(webadmin: string): () => Promise<void> {
  return async () => {
    const headers = { Password: JAMES_WEBADMIN_PASSWORD, 'Content-Type': 'application/json' };
    await expectStatus(await fetch(`${webadmin}/domains/example.com`, { method: 'PUT', headers }), [204, 409], 'provisionnement james (domaine)');
    for (const { login, password } of USERS) {
      const res = await fetch(`${webadmin}/users/${login}`, { method: 'PUT', headers, body: JSON.stringify({ password }) });
      await expectStatus(res, [204], `provisionnement james (${login})`);
    }
  };
}

export const SERVERS: CompatServer[] = [
  {
    name: 'stalwart',
    wellKnown: 'http://127.0.0.1:18480/.well-known/jmap',
    users: USERS,
    ready: 'http://127.0.0.1:18480/healthz/ready',
    provision: provisionStalwart,
    push: true,
    absent: [],
  },
  {
    name: 'cyrus',
    wellKnown: 'http://127.0.0.1:18580/.well-known/jmap',
    users: USERS,
    ready: 'http://127.0.0.1:18501/',
    provision: provisionCyrus,
    // Le flux EventSource de cette image n'envoie aucun StateChange et bloque les autres requêtes de l'utilisateur.
    push: false,
    absent: ['urn:ietf:params:jmap:vacationresponse'],
  },
  {
    name: 'james',
    wellKnown: 'http://127.0.0.1:18680/.well-known/jmap',
    users: USERS,
    ready: 'http://127.0.0.1:18600/healthcheck',
    provision: provisionJames('http://127.0.0.1:18600'),
    push: true,
    absent: ['urn:ietf:params:jmap:sieve', 'urn:ietf:params:jmap:contacts', 'urn:ietf:params:jmap:calendars'],
  },
  {
    name: 'james-minimal',
    wellKnown: 'http://127.0.0.1:18780/.well-known/jmap',
    users: USERS,
    ready: 'http://127.0.0.1:18700/healthcheck',
    provision: provisionJames('http://127.0.0.1:18700'),
    push: true,
    absent: [
      'urn:ietf:params:jmap:quota',
      'urn:ietf:params:jmap:sieve',
      'urn:ietf:params:jmap:vacationresponse',
      'urn:ietf:params:jmap:contacts',
      'urn:ietf:params:jmap:calendars',
      'urn:ietf:params:jmap:websocket',
    ],
  },
];
