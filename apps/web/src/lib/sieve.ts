/**
 * Script Sieve géré côté webmail (`MANAGED_SCRIPT_NAME`) : liste de blocage, répondeur et filtres
 * vivent dans le même script ; le générateur pur est dans `@voxel/jmap` (`sieve-managed.ts`).
 *
 * Enregistrement : blob → `SieveScript/validate` → `SieveScript/set` ; activation prudente (on ne
 * remplace jamais le script actif de quelqu'un d'autre, sauf demande explicite de l'utilisateur).
 */
import {
  blocklistActivation,
  buildManagedScript,
  CAP,
  EMPTY_MANAGED,
  hasManagedMarkers,
  MANAGED_SCRIPT_NAME,
  ManagedSieveError,
  parseManagedScript,
  sameManagedScript,
  VACATION_SCRIPT_NAME,
  type ManagedSieve,
  type ManagedVacation,
  type SieveAccountCapability,
  type SieveScript,
} from '@voxel/jmap';
import i18n from '@/i18n';
import { errorMessage } from './api';
import { jmap } from './jmap';
import { accountsQuery, getMailboxData, roleId, type MailboxData } from './mail';
import { queryClient } from './queryClient';

/**
 * - `none` : aucun script géré (état géré vide) ;
 * - `managed` : notre script, texte identique à celui que le générateur produirait ;
 * - `manual` : notre script, modifié à la main (marqueurs présents, texte différent) ;
 * - `foreign` : notre script sans marqueur, ou script actif d'un autre outil (lecture seule) ;
 * - `corrupted` : marqueurs présents mais illisibles.
 */
export type SieveMode = 'none' | 'managed' | 'manual' | 'foreign' | 'corrupted';

export interface SieveState {
  supported: boolean;
  mode: SieveMode;
  managed: ManagedSieve;
  scriptId: string | null;
  /** Notre script est le script actif. */
  active: boolean;
  /** Nom d'un AUTRE script actif (`vacation` ou autre), sinon null. */
  activeOther: string | null;
  /** Texte de notre script, ou du script étranger actif (mode `foreign`). */
  text: string | null;
  extensions: string[];
  maxSize: number | null;
  /** Le répondeur JMAP (`VacationResponse`) est activé. */
  jmapVacationEnabled: boolean;
}

export const sieveKey = (accountId: string) => ['sieve', accountId] as const;

const NONE: SieveState = {
  supported: false,
  mode: 'none',
  managed: EMPTY_MANAGED,
  scriptId: null,
  active: false,
  activeOther: null,
  text: null,
  extensions: [],
  maxSize: null,
  jmapVacationEnabled: false,
};

async function sieveCap(accountId: string, jmapAccountId: string): Promise<SieveAccountCapability | null> {
  const s = await jmap(accountId).getSession();
  return (s.accounts[jmapAccountId]?.accountCapabilities[CAP.sieve] as SieveAccountCapability | undefined) ?? null;
}

async function supported(accountId: string): Promise<boolean> {
  const mb = (await queryClient.fetchQuery(accountsQuery)).find((m) => m.id === accountId);
  return !!mb?.capabilities?.sieve;
}

async function listScripts(accountId: string, aid: string): Promise<SieveScript[]> {
  return (await jmap(accountId).call('SieveScript/get', { accountId: aid, ids: null })).list;
}

async function scriptText(accountId: string, aid: string, s: SieveScript): Promise<string> {
  return (await jmap(accountId).download(aid, s.blobId, `${s.name ?? 'script'}.sieve`, 'application/sieve')).text();
}

/** Chemin complet d'un dossier (« Parent/Enfant »), pour `fileinto` sans `mailboxid`. */
export function mailboxPath(data: MailboxData, id: string): string {
  const parts: string[] = [];
  let cur = data.mailboxes.find((m) => m.id === id);
  for (let i = 0; cur && i < 20; i++) {
    parts.unshift(cur.name);
    cur = cur.parentId ? data.mailboxes.find((m) => m.id === cur!.parentId) : undefined;
  }
  return parts.join('/');
}

/** Options du générateur pour cette boîte (dossiers, adresses des identités, extensions). */
async function buildOptions(accountId: string, data: MailboxData, cap: SieveAccountCapability | null) {
  const junkId = roleId(data, 'junk');
  const junk = data.mailboxes.find((m) => m.id === junkId);
  let addresses: string[] = [];
  try {
    const ids = await jmap(accountId).call('Identity/get', { accountId: data.jmapAccountId, ids: null });
    addresses = ids.list.map((i) => i.email).filter((e) => !e.startsWith('*'));
  } catch {
    /* pas d'identités : l'adresse de la boîte suffit */
  }
  const mb = (await queryClient.fetchQuery(accountsQuery)).find((m) => m.id === accountId);
  if (mb) addresses.push(mb.email);
  return {
    extensions: cap?.sieveExtensions ?? [],
    ...(junk ? { junkName: mailboxPath(data, junk.id), junkId: junk.id } : {}),
    mailboxes: Object.fromEntries(data.mailboxes.map((m) => [m.id, mailboxPath(data, m.id)])),
    vacationAddresses: addresses,
    maxSize: cap?.maxSizeScript ?? null,
  };
}

/**
 * Script géré enregistré sous un autre nom (marqueurs présents, nom d'une version précédente) : repris sous
 * `MANAGED_SCRIPT_NAME`, texte régénéré, activation inchangée. `true` si un script a été repris.
 */
async function adoptManagedScript(accountId: string, data: MailboxData, cap: SieveAccountCapability | null, scripts: SieveScript[]): Promise<boolean> {
  const aid = data.jmapAccountId;
  for (const s of scripts) {
    if (s.name === VACATION_SCRIPT_NAME) continue;
    try {
      const managed = parseManagedScript(await scriptText(accountId, aid, s));
      if (!managed) continue;
      const text = buildManagedScript(managed, await buildOptions(accountId, data, cap));
      const c = jmap(accountId);
      const { blobId } = await c.upload(aid, new Blob([text], { type: 'application/sieve' }));
      const r = await c.call('SieveScript/set', { accountId: aid, update: { [s.id]: { name: MANAGED_SCRIPT_NAME, blobId } } });
      return !r.notUpdated?.[s.id];
    } catch {
      /* script illisible ou refusé par le serveur : laissé tel quel */
    }
  }
  return false;
}

export async function fetchSieveState(accountId: string): Promise<SieveState> {
  if (!(await supported(accountId))) return NONE;
  const data = await getMailboxData(accountId);
  const aid = data.jmapAccountId;
  const cap = await sieveCap(accountId, aid);
  let scripts = await listScripts(accountId, aid);
  if (!scripts.some((s) => s.name === MANAGED_SCRIPT_NAME) && (await adoptManagedScript(accountId, data, cap, scripts))) {
    scripts = await listScripts(accountId, aid);
  }
  const act = blocklistActivation(scripts);
  const ours = scripts.find((s) => s.name === MANAGED_SCRIPT_NAME);
  let jmapVacationEnabled = false;
  if (act.activeOther === VACATION_SCRIPT_NAME) {
    try {
      const v = await jmap(accountId).call('VacationResponse/get', { accountId: aid, ids: ['singleton'] });
      jmapVacationEnabled = !!v.list[0]?.isEnabled;
    } catch {
      jmapVacationEnabled = true;
    }
  }
  const base: SieveState = {
    ...NONE,
    supported: true,
    scriptId: act.ours,
    active: act.active,
    activeOther: act.activeOther,
    extensions: cap?.sieveExtensions ?? [],
    maxSize: cap?.maxSizeScript ?? null,
    jmapVacationEnabled,
  };
  if (!ours) {
    // script actif d'un autre outil (hors « vacation ») : affiché en lecture seule
    const other = scripts.find((s) => s.isActive && s.name !== VACATION_SCRIPT_NAME);
    if (other) return { ...base, mode: 'foreign', text: await scriptText(accountId, aid, other) };
    return base;
  }
  const text = await scriptText(accountId, aid, ours);
  const managed = parseManagedScript(text);
  if (!managed) return { ...base, text, mode: hasManagedMarkers(text) ? 'corrupted' : 'foreign' };
  let regenerated: string | null = null;
  try {
    regenerated = buildManagedScript(managed, await buildOptions(accountId, data, cap));
  } catch {
    regenerated = null;
  }
  return { ...base, text, managed, mode: regenerated !== null && sameManagedScript(regenerated, text) ? 'managed' : 'manual' };
}

export const sieveQuery = (accountId: string) => ({
  queryKey: sieveKey(accountId),
  queryFn: () => fetchSieveState(accountId),
  staleTime: 60_000,
});

/** Envoie un texte de script (validé d'abord) ; `activate` : 'auto' (sans remplacer le script actif d'un autre) ou 'force'. */
async function putScript(accountId: string, text: string, activate: 'auto' | 'force' = 'auto'): Promise<{ pendingActivation: boolean }> {
  const c = jmap(accountId);
  const data = await getMailboxData(accountId);
  const aid = data.jmapAccountId;
  const cap = await sieveCap(accountId, aid);
  const blob = new Blob([text], { type: 'application/sieve' });
  if (cap?.maxSizeScript && blob.size >= cap.maxSizeScript) throw new ManagedSieveError('too_large');
  const { blobId } = await c.upload(aid, blob);
  const v = await c.call('SieveScript/validate', { accountId: aid, blobId });
  if (v.error) throw new SieveInvalidError(v.error.description || v.error.type);
  const scripts = await listScripts(accountId, aid);
  const act = blocklistActivation(scripts);
  const doActivate = !act.active && (activate === 'force' || act.canActivate);
  const r = await c.call('SieveScript/set', {
    accountId: aid,
    ...(act.ours ? { update: { [act.ours]: { blobId } } } : { create: { voxel: { name: MANAGED_SCRIPT_NAME, blobId } } }),
    ...(doActivate ? { onSuccessActivateScript: act.ours ?? '#voxel' } : {}),
  });
  const err = r.notCreated?.voxel ?? (act.ours ? r.notUpdated?.[act.ours] : undefined);
  if (err) throw new Error(err.description || err.type);
  await invalidateSieve(accountId);
  return { pendingActivation: !act.active && !doActivate };
}

/** Le serveur a refusé le script (`SieveScript/validate`) ; `message` vient du serveur. */
export class SieveInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SieveInvalidError';
  }
}

export async function invalidateSieve(accountId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: sieveKey(accountId) }),
    queryClient.invalidateQueries({ queryKey: ['blocklist', accountId] }),
  ]);
}

/**
 * Modifie l'état géré et enregistre le script régénéré. Toujours relu juste avant (pas d'écrasement d'une
 * modification faite ailleurs entre-temps).
 */
export async function saveManaged(
  accountId: string,
  update: (m: ManagedSieve) => ManagedSieve,
  activate: 'auto' | 'force' = 'auto',
  allowManual = false,
): Promise<{ pendingActivation: boolean }> {
  const state = await queryClient.fetchQuery({ ...sieveQuery(accountId), staleTime: 0 });
  // script retouché à la main : seul « Revenir au mode géré » le régénère (ex. « Bloquer » depuis le lecteur l'écraserait)
  if (state.mode === 'manual' && !allowManual) throw new ManagedSieveError('manual_mode');
  const base = state.mode === 'managed' || state.mode === 'manual' ? state.managed : EMPTY_MANAGED;
  const next = update(base);
  const data = await getMailboxData(accountId);
  const opts = await buildOptions(accountId, data, await sieveCap(accountId, data.jmapAccountId));
  const text = buildManagedScript(next, opts);
  return putScript(accountId, text, activate);
}

/** Aperçu du script généré (éditeur de filtres) ; lève ManagedSieveError si une règle n'est pas enregistrable. */
export async function previewManaged(accountId: string, next: ManagedSieve): Promise<string> {
  const data = await getMailboxData(accountId);
  return buildManagedScript(next, await buildOptions(accountId, data, await sieveCap(accountId, data.jmapAccountId)));
}

/** Mode avancé : enregistre le texte brut (validé par le serveur). Le script passe en mode manuel. */
export function saveRawScript(accountId: string, text: string): Promise<{ pendingActivation: boolean }> {
  return putScript(accountId, text, 'auto');
}

/** Revenir au mode géré : régénère le script depuis ses marqueurs. */
export async function regenerateManaged(accountId: string): Promise<{ pendingActivation: boolean }> {
  return saveManaged(accountId, (m) => m, 'auto', true);
}

/**
 * « Remplacer par les filtres de Voxel » (script étranger) : notre script est créé vide et activé
 * à la place, après confirmation de l'utilisateur. Renvoie l'ancien texte (copié dans le presse-papiers).
 */
export async function replaceForeign(accountId: string): Promise<void> {
  const data = await getMailboxData(accountId);
  const opts = await buildOptions(accountId, data, await sieveCap(accountId, data.jmapAccountId));
  await putScript(accountId, buildManagedScript(EMPTY_MANAGED, opts), 'force');
}

/**
 * « Reprendre le répondeur dans Voxel » : texte et dates de `VacationResponse` copiés dans notre bloc,
 * `VacationResponse` désactivé, notre script activé.
 */
export async function takeOverVacation(accountId: string): Promise<void> {
  const c = jmap(accountId);
  const data = await getMailboxData(accountId);
  const aid = data.jmapAccountId;
  const v = (await c.call('VacationResponse/get', { accountId: aid, ids: ['singleton'] })).list[0];
  const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : undefined);
  const vacation: ManagedVacation = {
    enabled: !!v?.isEnabled,
    subject: v?.subject ?? '',
    text: v?.textBody ?? '',
    days: 7,
    ...(day(v?.fromDate) ? { start: day(v?.fromDate) } : {}),
    ...(day(v?.toDate) ? { end: day(v?.toDate) } : {}),
  };
  // le générateur vérifie d'abord que le répondeur est possible (extensions) : rien n'est coupé sinon
  await previewManaged(accountId, { ...EMPTY_MANAGED, vacation });
  await c.call('VacationResponse/set', { accountId: aid, update: { singleton: { isEnabled: false } } });
  await saveManaged(accountId, (m) => ({ ...m, vacation }), 'force');
  await queryClient.invalidateQueries({ queryKey: ['vacation', accountId] });
}

/** Le répondeur passe-t-il par le script géré pour cette boîte (extension `vacation`) ? */
export function sieveVacationAvailable(state: SieveState | undefined): boolean {
  return !!state?.supported && state.extensions.includes('vacation');
}

/** Message lisible pour une erreur du script géré. */
export function sieveErrorMessage(e: unknown): string {
  if (e instanceof ManagedSieveError) {
    switch (e.code) {
      case 'too_many':
        return i18n.t('settings:blocked.tooMany');
      case 'too_large':
        return i18n.t('settings:blocked.tooLarge');
      case 'no_junk':
        return i18n.t('settings:blocked.noJunk');
      default:
        return i18n.t(`settings:sieveErrors.${e.code}`, { detail: e.detail ?? '' });
    }
  }
  if (e instanceof SieveInvalidError) return i18n.t('settings:sieveErrors.invalid', { message: e.message });
  return errorMessage(e);
}
