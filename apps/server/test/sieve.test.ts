/**
 * Client ManageSieve (RFC 5804) et façade JMAP for Sieve, contre un faux serveur en mémoire
 * (TCP local, STARTTLS simulé sans chiffrement). Lancer depuis la racine du dépôt : npm test
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, test } from 'node:test';
import { ManageSieveClient, ResponseReader, SieveAuthError } from '../src/sieve/client.js';
import { SieveFacade } from '../src/sieve/facade.js';

// ---------------------------------------------------------------- faux serveur

interface FakeState {
  scripts: Map<string, string>;
  active: string | null;
  log: string[];
}

const CAPS = ['"IMPLEMENTATION" "Fake Sieve"', '"SASL" "PLAIN"', '"SIEVE" "fileinto vacation imap4flags copy mailboxid"', '"MAXREDIRECTS" "4"', '"VERSION" "1.0"'];
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const lit = (s: string) => `{${Buffer.byteLength(s)}}\r\n${s}`;

function fakeServer(state: FakeState, opts: { user: string; pass: string; chunk?: number }) {
  return net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let tls = false;
    const send = (s: string) => {
      const data = Buffer.from(s);
      // découpage en petits morceaux arbitraires pour éprouver le lecteur
      const n = opts.chunk ?? data.length;
      for (let i = 0; i < data.length; i += n) sock.write(data.subarray(i, i + n));
    };
    const caps = () => [...CAPS, ...(tls ? [] : ['"STARTTLS"'])].join('\r\n') + '\r\nOK\r\n';
    send(caps());
    /** Lit un argument : chaîne entre guillemets ou littéral déjà extrait. */
    const handle = (args: string[], cmd: string) => {
      state.log.push(cmd);
      switch (cmd) {
        case 'STARTTLS':
          tls = true;
          send('OK "begin TLS"\r\n');
          send(caps());
          return;
        case 'AUTHENTICATE': {
          const [, user, pass] = Buffer.from(args[1] ?? '', 'base64').toString('utf8').split('\0');
          send(user === opts.user && pass === opts.pass ? 'OK "logged in"\r\n' : 'NO "auth failed"\r\n');
          return;
        }
        case 'CAPABILITY':
          send(caps());
          return;
        case 'LISTSCRIPTS':
          send([...state.scripts.keys()].map((n) => `${q(n)}${n === state.active ? ' ACTIVE' : ''}\r\n`).join('') + 'OK\r\n');
          return;
        case 'GETSCRIPT': {
          const s = state.scripts.get(args[0]!);
          send(s === undefined ? 'NO (NONEXISTENT) "no such script"\r\n' : `${lit(s)}\r\nOK\r\n`);
          return;
        }
        case 'PUTSCRIPT':
        case 'CHECKSCRIPT': {
          const content = cmd === 'PUTSCRIPT' ? args[1]! : args[0]!;
          if (content.includes('syntax error')) {
            const msg = 'line 1: syntax error\nunexpected token';
            send(`NO ${lit(msg)}\r\n`);
            return;
          }
          if (cmd === 'PUTSCRIPT') state.scripts.set(args[0]!, content);
          send('OK\r\n');
          return;
        }
        case 'SETACTIVE':
          if (args[0] && !state.scripts.has(args[0])) return send('NO (NONEXISTENT) "no such script"\r\n');
          state.active = args[0] || null;
          send('OK\r\n');
          return;
        case 'DELETESCRIPT':
          if (state.active === args[0]) return send('NO (ACTIVE) "script is active"\r\n');
          state.scripts.delete(args[0]!);
          send('OK\r\n');
          return;
        case 'RENAMESCRIPT': {
          const s = state.scripts.get(args[0]!);
          if (s === undefined) return send('NO (NONEXISTENT)\r\n');
          state.scripts.delete(args[0]!);
          state.scripts.set(args[1]!, s);
          if (state.active === args[0]) state.active = args[1]!;
          send('OK\r\n');
          return;
        }
        case 'HAVESPACE':
          send(Number(args[1]) > 1000 ? 'NO (QUOTA/MAXSIZE) "too big"\r\n' : 'OK\r\n');
          return;
        case 'LOGOUT':
          send('OK "bye"\r\n');
          sock.end();
          return;
        default:
          send('NO "unknown command"\r\n');
      }
    };
    // analyse : mot de commande, puis chaînes entre guillemets, nombres ou littéraux {n+}
    const pump = () => {
      for (;;) {
        const text = buf.toString('utf8');
        let i = 0;
        const args: string[] = [];
        const word = /^([A-Z]+)/.exec(text);
        if (!word) return;
        i = word[1]!.length;
        let complete = false;
        while (i <= text.length) {
          if (text.startsWith('\r\n', i)) {
            complete = true;
            i += 2;
            break;
          }
          if (text[i] === ' ') {
            i++;
            continue;
          }
          if (text[i] === '"') {
            let v = '';
            i++;
            while (i < text.length && text[i] !== '"') {
              if (text[i] === '\\') i++;
              v += text[i];
              i++;
            }
            i++;
            args.push(v);
            continue;
          }
          const m = /^\{(\d+)\+?\}\r\n/.exec(text.slice(i));
          if (m) {
            const start = Buffer.byteLength(text.slice(0, i + m[0].length));
            const n = Number(m[1]);
            if (buf.length < start + n) return;
            args.push(buf.subarray(start, start + n).toString('utf8'));
            i = buf.subarray(0, start + n).toString('utf8').length;
            continue;
          }
          const a = /^[^\s\r]+/.exec(text.slice(i));
          if (!a) break;
          args.push(a[0]);
          i += a[0].length;
        }
        if (!complete) return;
        buf = buf.subarray(Buffer.byteLength(text.slice(0, i)));
        handle(args, word[1]!);
      }
    };
    sock.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      pump();
    });
    sock.on('error', () => undefined);
  });
}

async function start(state: FakeState, opts: { user: string; pass: string; chunk?: number }) {
  const srv = fakeServer(state, opts);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  const transport = () => ({
    connect: () =>
      new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect({ host: '127.0.0.1', port }, () => resolve(s));
        s.once('error', reject);
      }),
    // STARTTLS simulé : le faux serveur continue en clair
    upgrade: async (s: import('node:stream').Duplex) => s,
  });
  return { srv, transport };
}

const servers: net.Server[] = [];
after(() => servers.forEach((s) => s.close()));

// ---------------------------------------------------------------- tests

test('lecteur de réponses : littéraux, codes, découpage arbitraire', async () => {
  const r = new ResponseReader(1 << 20);
  const raw = Buffer.from('"a b" ACTIVE\r\n{5}\r\nx\r\nyz\r\nNO (QUOTA/MAXSIZE) "trop gros"\r\n');
  for (let i = 0; i < raw.length; i += 3) r.push(raw.subarray(i, i + 3));
  const res = await r.readResponse();
  assert.equal(res.status, 'NO');
  assert.equal(res.code, 'QUOTA/MAXSIZE');
  assert.equal(res.message, 'trop gros');
  assert.deepEqual(res.lines[0], [{ t: 'str', v: 'a b' }, { t: 'atom', v: 'ACTIVE' }]);
  assert.deepEqual(res.lines[1], [{ t: 'str', v: 'x\r\nyz' }]);
});

test('client : STARTTLS, AUTHENTICATE PLAIN, toutes les commandes', async () => {
  const state: FakeState = { scripts: new Map([['old', 'keep;']]), active: 'old', log: [] };
  const { srv, transport } = await start(state, { user: 'u@x.fr', pass: 'p€ss', chunk: 7 });
  servers.push(srv);
  const c = new ManageSieveClient({ ...transport(), username: 'u@x.fr', password: 'p€ss' });
  const caps = await c.connect();
  assert.deepEqual(caps.sieve, ['fileinto', 'vacation', 'imap4flags', 'copy', 'mailboxid']);
  assert.equal(caps.maxRedirects, 4);
  assert.equal(caps.starttls, false, 'capacités relues après STARTTLS');
  assert.deepEqual(state.log.slice(0, 2), ['STARTTLS', 'AUTHENTICATE']);
  assert.deepEqual(await c.listScripts(), [{ name: 'old', active: true }]);
  assert.equal(await c.getScript('old'), 'keep;');
  const body = 'require "fileinto";\r\n# « accents » et "guillemets"\r\nfileinto "Spam";\r\n';
  await c.putScript('new one', body);
  assert.equal(await c.getScript('new one'), body);
  assert.equal(await c.checkScript(body), null);
  assert.equal(await c.checkScript('syntax error'), 'line 1: syntax error\nunexpected token');
  await c.setActive('new one');
  assert.equal(state.active, 'new one');
  await assert.rejects(c.deleteScript('new one'), /active/);
  await c.renameScript('old', 'older');
  await c.deleteScript('older');
  assert.equal(await c.haveSpace('x', 10), true);
  assert.equal(await c.haveSpace('x', 10_000), false);
  assert.equal((await c.capability()).implementation, 'Fake Sieve');
  await c.logout();
  assert.equal(c.connected, false);
  assert.ok(state.log.includes('LOGOUT'));
});

test('client : identifiants refusés → SieveAuthError', async () => {
  const state: FakeState = { scripts: new Map(), active: null, log: [] };
  const { srv, transport } = await start(state, { user: 'u', pass: 'right' });
  servers.push(srv);
  const c = new ManageSieveClient({ ...transport(), username: 'u', password: 'wrong' });
  await assert.rejects(c.connect(), SieveAuthError);
  assert.equal(c.connected, false);
});

test('façade : SieveScript/get, set (création + activation #voxel), validate, mise à jour, destruction, téléchargement', async () => {
  const state: FakeState = { scripts: new Map(), active: null, log: [] };
  const { srv, transport } = await start(state, { user: 'u', pass: 'p' });
  servers.push(srv);
  const uploads = new Map<string, Buffer>([
    ['U000000000000000000000001', Buffer.from('require "fileinto";\nfileinto "Junk";\n')],
    ['U000000000000000000000002', Buffer.from('syntax error')],
    ['U000000000000000000000003', Buffer.from('keep;\n')],
  ]);
  const f = new SieveFacade({ transport, username: 'u', password: 'p', loadUpload: async (id) => uploads.get(id) ?? null });
  assert.equal(await f.probe(), true);
  const cap = f.sessionCapability()!;
  assert.deepEqual(cap.account.sieveExtensions, ['copy', 'fileinto', 'imap4flags', 'mailboxid', 'vacation']);
  assert.equal(cap.account.maxNumberRedirects, 4);

  const empty = await f.get({ ids: null });
  assert.deepEqual(empty.list, []);

  assert.deepEqual(await f.validate({ blobId: 'U000000000000000000000001' }), { error: null });
  const bad = (await f.validate({ blobId: 'U000000000000000000000002' })) as { error: { type: string } };
  assert.equal(bad.error.type, 'invalidScript');

  const createdIds: Record<string, string> = {};
  const r = (await f.set(
    { create: { voxel: { name: 'voxel', blobId: 'U000000000000000000000001' } }, onSuccessActivateScript: '#voxel' },
    (id) => id,
    (cid, id) => (createdIds[cid] = id),
  )) as { created: Record<string, { id: string; isActive: boolean; blobId: string }>; oldState: string; newState: string };
  const id = r.created.voxel!.id;
  assert.equal(createdIds.voxel, id);
  assert.equal(r.created.voxel!.isActive, true);
  assert.notEqual(r.oldState, r.newState);
  assert.equal(state.active, 'voxel');

  const got = (await f.get({ ids: [id, 'nope'] })) as { list: Array<{ blobId: string; isActive: boolean; name: string }>; notFound: string[] };
  assert.equal(got.list[0]!.name, 'voxel');
  assert.equal(got.list[0]!.isActive, true);
  assert.deepEqual(got.notFound, ['nope']);
  assert.equal(await f.scriptContent(got.list[0]!.blobId), 'require "fileinto";\nfileinto "Junk";\n');
  assert.ok(SieveFacade.isScriptBlob(got.list[0]!.blobId));

  // nom réservé, doublon, script invalide
  const r2 = (await f.set(
    {
      create: {
        a: { name: 'vacation', blobId: 'U000000000000000000000003' },
        b: { name: 'voxel', blobId: 'U000000000000000000000003' },
        c: { name: 'x', blobId: 'U000000000000000000000002' },
      },
    },
    (x) => x,
    () => undefined,
  )) as { notCreated: Record<string, { type: string }> };
  assert.equal(r2.notCreated.a!.type, 'forbidden');
  assert.equal(r2.notCreated.b!.type, 'alreadyExists');
  assert.equal(r2.notCreated.c!.type, 'invalidScript');

  // mise à jour du contenu, puis destruction refusée tant qu'actif
  const u = (await f.set({ update: { [id]: { blobId: 'U000000000000000000000003' } } }, (x) => x, () => undefined)) as { updated: Record<string, { blobId: string }> };
  assert.equal(state.scripts.get('voxel'), 'keep;\n');
  assert.ok(u.updated[id]!.blobId);
  const d1 = (await f.set({ destroy: [id] }, (x) => x, () => undefined)) as { notDestroyed: Record<string, { type: string }> };
  assert.equal(d1.notDestroyed[id]!.type, 'scriptIsActive');
  const off = (await f.set({ onSuccessDeactivateScript: true }, (x) => x, () => undefined)) as { updated: Record<string, { isActive: boolean }> };
  assert.equal(off.updated[id]!.isActive, false);
  assert.equal(state.active, null);
  const d2 = (await f.set({ destroy: [id] }, (x) => x, () => undefined)) as { destroyed: string[] };
  assert.deepEqual(d2.destroyed, [id]);
  assert.equal(state.scripts.size, 0);

  const qr = (await f.query({})) as { ids: string[]; total: number };
  assert.equal(qr.total, 0);
  f.close();
});

test('façade : serveur injoignable → capacité absente, sans erreur', async () => {
  const f = new SieveFacade({
    transport: () => ({ connect: () => Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })) }),
    username: 'u',
    password: 'p',
    loadUpload: async () => null,
  });
  assert.equal(await f.probe(), false);
  assert.equal(f.sessionCapability(), null);
});
