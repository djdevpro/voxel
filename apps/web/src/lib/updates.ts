/**
 * Mises à jour de Voxel Desktop : le cœur Rust lit `latest.json` de la dernière release GitHub et n'installe qu'un
 * fichier signé par la clé de Voxel. Recherche 30 s après le démarrage puis toutes les 6 heures ; une version
 * trouvée s'annonce dans un toast « Installer et redémarrer ». Fermé, ce toast ne revient pas pour cette version,
 * sauf recherche demandée dans les paramètres. Avant l'installation, les messages en attente partent et le cache est
 * enregistré, comme quand on quitte. Sur le web, rien de ce module ne s'exécute.
 */
import { toast } from 'sonner';
import i18n from '@/i18n';
import { desktopUpdateCheck, desktopUpdateInstall, isDesktop, type DesktopUpdate } from './platform';
import { flushPersistedCache } from './queryClient';
import { flushPendingSends } from './sendQueue';

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 3600_000;
const TOAST_ID = 'voxel-update';
const DISMISSED_KEY = 'voxel.updateDismissed';

let installing = false;

function percent(ratio: number): string {
  return new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 0 }).format(ratio);
}

/** Télécharge, installe et relance ; en cas d'échec, le toast le dit et l'appli continue. */
export async function installUpdate(update: DesktopUpdate): Promise<void> {
  if (installing) return;
  installing = true;
  toast.loading(i18n.t('common:update.downloading', { version: update.version }), { id: TOAST_ID, duration: Infinity });
  try {
    flushPersistedCache();
    await flushPendingSends();
    await desktopUpdateInstall((ratio) => {
      const text = i18n.t('common:update.downloading', { version: update.version });
      toast.loading(ratio === null ? text : `${text} ${percent(ratio)}`, { id: TOAST_ID, duration: Infinity });
    });
  } catch (e) {
    installing = false;
    toast.error(i18n.t('common:update.failed'), { id: TOAST_ID, duration: 8000, description: (e as Error)?.message || String(e) });
  }
}

function announce(update: DesktopUpdate): void {
  toast(i18n.t('common:update.available', { version: update.version }), {
    id: TOAST_ID,
    duration: Infinity,
    action: {
      label: i18n.t('common:update.install'),
      // le même toast montre ensuite le téléchargement : sonner ne doit pas le fermer après le clic
      onClick: (e) => {
        e.preventDefault();
        void installUpdate(update);
      },
    },
    onDismiss: () => {
      try {
        localStorage.setItem(DISMISSED_KEY, update.version);
      } catch {
        /* stockage indisponible : le toast reviendra */
      }
    },
  });
}

/**
 * Cherche une mise à jour. `manual` (paramètres) : annonce aussi une version déjà écartée, et dit quand Voxel est à
 * jour ou que la recherche échoue ; sinon silencieux. Renvoie la version trouvée.
 */
export async function checkForUpdate(opts: { manual?: boolean } = {}): Promise<DesktopUpdate | null> {
  if (!isDesktop || installing) return null;
  let update: DesktopUpdate | null;
  try {
    update = await desktopUpdateCheck();
  } catch (e) {
    if (opts.manual) toast.error(i18n.t('common:update.checkFailed'), { description: (e as Error)?.message || String(e) });
    return null;
  }
  if (!update) {
    if (opts.manual) toast(i18n.t('common:update.upToDate'));
    return null;
  }
  let dismissed: string | null = null;
  try {
    dismissed = localStorage.getItem(DISMISSED_KEY);
  } catch {
    dismissed = null;
  }
  if (opts.manual || dismissed !== update.version) announce(update);
  return update;
}

/** Recherches automatiques du bureau (appelé une fois au démarrage). */
export function scheduleUpdateChecks(): void {
  if (!isDesktop) return;
  setTimeout(() => void checkForUpdate(), FIRST_CHECK_MS);
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
}
