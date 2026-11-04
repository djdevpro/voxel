/**
 * Expéditeurs bloqués : script Sieve géré sur le serveur.
 * Les messages des expéditeurs bloqués vont dans Spam côté serveur, même webmail fermé.
 */
import {
  BlocklistError,
  blocklistActivation,
  cleanBlocklist,
  normalizeAddress,
  normalizeDomain,
  type Blocklist,
} from '@voxel/jmap';
import { jmap } from './jmap';
import { accountsQuery, getMailboxData, roleId } from './mail';
import { queryClient } from './queryClient';
import { invalidateAccount } from './actions';
import { fetchSieveState, saveManaged, sieveErrorMessage, sieveKey } from './sieve';

export interface BlocklistState {
  supported: boolean; // capabilities.sieve ET dossier de rôle junk présent
  list: Blocklist; // vide si aucun script
  scriptId: string | null; // id de notre script s'il existe
  active: boolean; // notre script est le script actif
  activeOther: string | null; // nom d'un AUTRE script actif ('vacation' ou autre), sinon null
  corrupted: boolean; // notre script existe mais ses marqueurs sont illisibles (ou absents)
}

export const blocklistKey = (accountId: string) => ['blocklist', accountId] as const;

const EMPTY: Blocklist = { addresses: [], domains: [] };

async function sieveSupported(accountId: string): Promise<boolean> {
  const mb = (await queryClient.fetchQuery(accountsQuery)).find((m) => m.id === accountId);
  return !!mb?.capabilities?.sieve;
}

/** Vue « liste de blocage » du script géré (même script que le répondeur et les filtres). */
export async function fetchBlocklist(accountId: string): Promise<BlocklistState> {
  const none: BlocklistState = { supported: false, list: EMPTY, scriptId: null, active: false, activeOther: null, corrupted: false };
  if (!(await sieveSupported(accountId))) return none;
  const data = await getMailboxData(accountId);
  if (!roleId(data, 'junk')) return none;
  const s = await fetchSieveState(accountId);
  queryClient.setQueryData(sieveKey(accountId), s);
  const ours = s.scriptId !== null;
  const corrupted = ours && (s.mode === 'corrupted' || s.mode === 'foreign');
  return { supported: true, list: corrupted ? EMPTY : s.managed.blocklist, scriptId: s.scriptId, active: s.active, activeOther: s.activeOther, corrupted };
}

export const blocklistQuery = (accountId: string) => ({
  queryKey: blocklistKey(accountId),
  queryFn: () => fetchBlocklist(accountId),
  staleTime: 60_000,
});

/** Enregistre la liste : le répondeur et les filtres du script géré sont conservés. */
export async function saveBlocklist(accountId: string, list: Blocklist): Promise<{ pendingActivation: boolean }> {
  const data = await getMailboxData(accountId);
  if (!roleId(data, 'junk')) throw new BlocklistError('no_junk');
  return saveManaged(accountId, (m) => ({ ...m, blocklist: cleanBlocklist(list) }));
}

type Entry = { address?: string; domain?: string };

async function currentList(accountId: string): Promise<Blocklist> {
  const s = await queryClient.fetchQuery({ ...blocklistQuery(accountId), staleTime: 0 });
  return s.corrupted ? EMPTY : s.list;
}

function matches(email: string | undefined, entry: { address?: string; domain?: string }): boolean {
  const e = (email ?? '').toLowerCase();
  if (entry.address) return e === entry.address;
  if (entry.domain) {
    const d = e.slice(e.lastIndexOf('@') + 1);
    return d === entry.domain || d.endsWith(`.${entry.domain}`);
  }
  return false;
}

export async function blockSender(accountId: string, entry: Entry): Promise<{ pendingActivation: boolean; moved: number }> {
  const address = entry.address ? normalizeAddress(entry.address) : null;
  const domain = entry.domain ? normalizeDomain(entry.domain) : null;
  if (!address && !domain) throw new Error('invalid');
  const list = await currentList(accountId);
  const next = cleanBlocklist({
    addresses: address ? [...list.addresses, address] : list.addresses,
    domains: domain ? [...list.domains, domain] : list.domains,
  });
  const { pendingActivation } = await saveBlocklist(accountId, next);

  // déplace les messages déjà présents en Réception
  const data = await getMailboxData(accountId);
  const inbox = roleId(data, 'inbox');
  const junk = roleId(data, 'junk');
  let moved = 0;
  if (inbox && junk) {
    const c = jmap(accountId);
    const aid = data.jmapAccountId;
    const q = await c.call('Email/query', { accountId: aid, filter: { inMailbox: inbox, from: (address ?? domain)! }, limit: 200 });
    if (q.ids.length) {
      const g = await c.call('Email/get', { accountId: aid, ids: q.ids, properties: ['from'] });
      const ids = g.list.filter((e) => (e.from ?? []).some((f) => matches(f.email, address ? { address } : { domain: domain! }))).map((e) => e.id);
      if (ids.length) {
        const patch = { mailboxIds: { [junk]: true }, 'keywords/$junk': true, 'keywords/$notjunk': null };
        const r = await c.call('Email/set', { accountId: aid, update: Object.fromEntries(ids.map((id) => [id, patch])) });
        moved = Object.keys(r.updated ?? {}).length;
        invalidateAccount(accountId);
      }
    }
  }
  return { pendingActivation, moved };
}

export async function unblock(accountId: string, entry: Entry): Promise<void> {
  const address = entry.address ? normalizeAddress(entry.address) : null;
  const domain = entry.domain ? normalizeDomain(entry.domain) : null;
  const list = await currentList(accountId);
  await saveBlocklist(accountId, {
    addresses: list.addresses.filter((a) => a !== address),
    domains: list.domains.filter((d) => d !== domain),
  });
}

/** Après la coupure du répondeur : Stalwart ne réactive pas notre script, on le fait. */
export async function reactivateBlocklistIfNeeded(accountId: string): Promise<void> {
  try {
    if (!(await sieveSupported(accountId))) return;
    const data = await getMailboxData(accountId);
    const c = jmap(accountId);
    const scripts = (await c.call('SieveScript/get', { accountId: data.jmapAccountId, ids: null })).list;
    let act = blocklistActivation(scripts);
    if (!act.ours || act.active) return;
    if (act.activeOther === 'vacation') {
      const v = await c.call('VacationResponse/get', { accountId: data.jmapAccountId, ids: ['singleton'] });
      act = blocklistActivation(scripts, !!v.list[0]?.isEnabled);
    }
    if (act.canActivate) await c.call('SieveScript/set', { accountId: data.jmapAccountId, onSuccessActivateScript: act.ours });
  } catch (e) {
    console.warn('reactivateBlocklistIfNeeded', e);
  } finally {
    void queryClient.invalidateQueries({ queryKey: blocklistKey(accountId) });
    void queryClient.invalidateQueries({ queryKey: sieveKey(accountId) });
  }
}

/** Message lisible pour une erreur de la liste de blocage. */
export function blocklistErrorMessage(e: unknown): string {
  return sieveErrorMessage(e);
}
