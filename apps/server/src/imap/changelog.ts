/**
 * Journal des changements d'emails de la façade IMAP (mémoire uniquement) : permet à Email/changes de renvoyer
 * created / updated / destroyed depuis un état récent, au lieu de toujours répondre cannotCalculateChanges.
 *
 * Principe : chaque relevé des dossiers (LIST + STATUS, déclenché par IDLE EXISTS/EXPUNGE/FETCH, le relevé
 * périodique du push ou une lecture du client) donne un état `e…`. Quand cet état change, on compare l'instantané
 * précédent au nouveau, dossier par dossier, en ne visitant que les dossiers dont l'empreinte a bougé :
 * - créations : UID dans [ancien UIDNEXT, nouvel UIDNEXT[ (UID SEARCH) ;
 * - suppressions : seulement si le compte de messages ne s'explique pas par les créations ; on compare alors
 *   l'ensemble des UID connus à l'instant précédent à l'ensemble courant (UID SEARCH ALL) ;
 * - changements de mots-clés : CONDSTORE (FETCH FLAGS CHANGEDSINCE <ancien HIGHESTMODSEQ>) ; sans CONDSTORE,
 *   seuls les cas où le nombre de non-lus s'explique par les créations sont calculables.
 * Tout ce qui ne se calcule pas de façon sûre (UIDVALIDITY changée, dossier inconnu trop gros, ensemble d'UID
 * non connu…) remet le journal à zéro : les états antérieurs deviennent inconnus ⇒ cannotCalculateChanges,
 * comme après un redémarrage. Le front sait repartir d'un état neuf.
 */
import type { ImapFlow } from 'imapflow';
import type { Folder } from './folders.js';
import type { ImapPool } from './pool.js';
import { encodeEmailId } from './util.js';

interface FolderSnap {
  id: string;
  path: string;
  uidValidity: bigint;
  uidNext: number;
  messages: number;
  unseen: number;
  highestModseq: bigint | null;
  /** UID présents à cet instant, quand on les connaît (nécessaire pour calculer des suppressions). */
  uids: Set<number> | null;
}

interface Snapshot {
  state: string;
  folders: Map<string, FolderSnap>;
}

interface Entry {
  from: string;
  to: string;
  created: string[];
  updated: string[];
  destroyed: string[];
}

export interface ChangesResult {
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

/** Changement non calculable de façon sûre. */
class Uncomputable extends Error {}

export class ChangeLog {
  private head: Snapshot | null = null;
  private entries: Entry[] = [];
  private queue: Promise<void> = Promise.resolve();
  private active = false;
  private pendingList: Folder[] | null = null;

  constructor(
    private readonly pool: ImapPool,
    private readonly stateOf: (list: Folder[]) => string,
    /** Nombre d'étapes conservées. */
    private readonly maxEntries = 200,
    /** Au-delà, on ne mémorise pas l'ensemble des UID d'un dossier (ses suppressions ne seront pas calculables). */
    private readonly maxTrackedMessages = 20_000,
  ) {}

  /**
   * Active le journal (abonné au push ou premier Email/changes). Tant qu'il est inactif, aucun coût IMAP :
   * une boîte utilisée seulement par un appel MCP ponctuel ne fait pas de relevé d'UID.
   */
  activate(): void {
    if (this.active) return;
    this.active = true;
    if (this.pendingList) this.observe(this.pendingList);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Nouveau relevé des dossiers (appelé à chaque LIST/STATUS). */
  observe(list: Folder[]): void {
    if (!this.active) {
      this.pendingList = list;
      return;
    }
    this.pendingList = null;
    const state = this.stateOf(list);
    this.queue = this.queue.then(() => this.advance(list, state)).catch(() => undefined);
  }

  /** Attend que tous les relevés observés soient intégrés. */
  async settle(): Promise<void> {
    await this.queue;
  }

  private snapshot(list: Folder[], state: string): Snapshot {
    const folders = new Map<string, FolderSnap>();
    for (const f of list) {
      folders.set(f.id, {
        id: f.id,
        path: f.path,
        uidValidity: f.uidValidity,
        uidNext: f.uidNext,
        messages: f.messages,
        unseen: f.unseen,
        highestModseq: f.highestModseq,
        uids: null,
      });
    }
    return { state, folders };
  }

  private async advance(list: Folder[], state: string): Promise<void> {
    if (!this.head) {
      const snap = this.snapshot(list, state);
      await this.prime(snap);
      this.head = snap;
      return;
    }
    if (state === this.head.state) return;
    const next = this.snapshot(list, state);
    let entry: Entry | null = null;
    try {
      entry = await this.diff(this.head, next);
    } catch {
      entry = null;
    }
    if (!entry) {
      // Rupture : les anciens états ne sont plus calculables ; on repart de cet instantané.
      this.entries = [];
      await this.prime(next, this.head);
    } else {
      this.entries.push(entry);
      if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this.head = next;
  }

  /** Mémorise les UID des dossiers qui n'en ont pas encore (reprend ceux d'un instantané précédent inchangé). */
  private async prime(snap: Snapshot, previous?: Snapshot): Promise<void> {
    for (const f of snap.folders.values()) {
      const old = previous?.folders.get(f.id);
      if (old?.uids && stampOf(old) === stampOf(f)) {
        f.uids = old.uids;
        continue;
      }
      if (f.messages === 0) {
        f.uids = new Set();
        continue;
      }
      if (f.messages > this.maxTrackedMessages) continue;
      try {
        f.uids = await this.pool.withMailbox(f.path, (c) => allUids(c, f.uidNext), true);
      } catch {
        f.uids = null;
      }
    }
  }

  private async diff(prev: Snapshot, next: Snapshot): Promise<Entry | null> {
    const created: string[] = [];
    const updated: string[] = [];
    const destroyed: string[] = [];
    try {
      for (const old of prev.folders.values()) {
        const cur = next.folders.get(old.id);
        if (cur) continue;
        // Dossier supprimé (ou renommé hors de notre vue) : tous ses messages disparaissent.
        if (old.messages === 0) continue;
        if (!old.uids) throw new Uncomputable();
        for (const uid of old.uids) destroyed.push(encodeEmailId(old.id, old.uidValidity, uid));
      }
      for (const cur of next.folders.values()) {
        const old = prev.folders.get(cur.id);
        if (!old) {
          // Nouveau dossier.
          if (cur.messages === 0) {
            cur.uids = new Set();
            continue;
          }
          if (cur.messages > this.maxTrackedMessages) throw new Uncomputable();
          const uids = await this.pool.withMailbox(cur.path, (c) => allUids(c, cur.uidNext), true);
          cur.uids = uids;
          for (const uid of uids) created.push(encodeEmailId(cur.id, cur.uidValidity, uid));
          continue;
        }
        if (stampOf(old) === stampOf(cur)) {
          cur.uids = old.uids;
          continue;
        }
        await this.diffFolder(old, cur, created, updated, destroyed);
      }
    } catch (e) {
      if (e instanceof Uncomputable) return null;
      throw e;
    }
    return { from: prev.state, to: next.state, created, updated, destroyed };
  }

  private async diffFolder(old: FolderSnap, cur: FolderSnap, created: string[], updated: string[], destroyed: string[]): Promise<void> {
    if (old.uidValidity !== cur.uidValidity || !old.uidNext || !cur.uidNext || cur.uidNext < old.uidNext) throw new Uncomputable();
    const useModseq = old.highestModseq != null && cur.highestModseq != null;
    await this.pool.withMailbox(
      cur.path,
      async (c) => {
        // Créations : UID attribués depuis le relevé précédent et encore présents.
        let fresh: number[] = [];
        if (cur.uidNext > old.uidNext) {
          const found = await c.search({ uid: `${old.uidNext}:${cur.uidNext - 1}` }, { uid: true });
          fresh = (found || []).filter((u) => u >= old.uidNext && u < cur.uidNext);
        }
        // Suppressions : seulement si le compte ne s'explique pas par les créations.
        const lost = old.messages + fresh.length - cur.messages;
        let gone: number[] = [];
        if (lost < 0) throw new Uncomputable();
        if (lost > 0) {
          if (!old.uids) throw new Uncomputable();
          const now = await allUids(c, cur.uidNext);
          gone = [...old.uids].filter((u) => !now.has(u));
          cur.uids = now;
        } else if (old.uids) {
          cur.uids = new Set(old.uids);
          for (const u of fresh) cur.uids.add(u);
        } else if (cur.messages <= this.maxTrackedMessages) {
          cur.uids = await allUids(c, cur.uidNext);
        }
        const freshSet = new Set(fresh);
        const goneSet = new Set(gone);
        // Mots-clés.
        if (useModseq) {
          if (cur.messages > 0 && cur.highestModseq! > old.highestModseq!) {
            for await (const m of c.fetch('1:*', { uid: true, flags: true }, { uid: false, changedSince: old.highestModseq! })) {
              if (!m.uid || m.uid >= cur.uidNext || freshSet.has(m.uid) || goneSet.has(m.uid)) continue;
              updated.push(encodeEmailId(cur.id, cur.uidValidity, m.uid));
            }
          }
        } else {
          // Sans CONDSTORE : calculable seulement si les non-lus s'expliquent par les créations (aucune suppression).
          let unseenFresh = 0;
          if (fresh.length) {
            const seen = await c.search({ uid: fresh.join(','), seen: false }, { uid: true });
            unseenFresh = (seen || []).length;
          }
          if (gone.length || cur.unseen - old.unseen !== unseenFresh) throw new Uncomputable();
        }
        for (const u of fresh) created.push(encodeEmailId(cur.id, cur.uidValidity, u));
        for (const u of gone) destroyed.push(encodeEmailId(cur.id, cur.uidValidity, u));
      },
      true,
    );
  }

  /**
   * Changements depuis `since` (null : état inconnu, trop ancien ou antérieur au démarrage ⇒ cannotCalculateChanges).
   * Les étapes sont fusionnées : créé puis détruit dans la fenêtre ⇒ absent ; créé puis modifié ⇒ créé.
   */
  async changes(since: string, maxChanges: number | null): Promise<ChangesResult | null> {
    await this.settle();
    const head = this.head;
    if (!head) return null;
    if (since === head.state) return { oldState: since, newState: since, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
    let start = -1;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.from === since) {
        start = i;
        break;
      }
    }
    if (start < 0) return null;
    const created = new Set<string>();
    const updated = new Set<string>();
    const destroyed = new Set<string>();
    let newState = since;
    for (let i = start; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      const size = created.size + updated.size + destroyed.size + e.created.length + e.updated.length + e.destroyed.length;
      if (maxChanges && size > maxChanges && newState !== since) break;
      if (maxChanges && size > maxChanges) return null;
      for (const id of e.created) created.add(id);
      for (const id of e.updated) if (!created.has(id)) updated.add(id);
      for (const id of e.destroyed) {
        if (created.delete(id)) continue;
        updated.delete(id);
        destroyed.add(id);
      }
      newState = e.to;
    }
    return {
      oldState: since,
      newState,
      hasMoreChanges: newState !== head.state,
      created: [...created],
      updated: [...updated],
      destroyed: [...destroyed],
    };
  }
}

function stampOf(f: FolderSnap): string {
  return `${f.uidValidity}|${f.uidNext}|${f.messages}|${f.unseen}|${f.highestModseq ?? ''}`;
}

/** UID présents dans le dossier sélectionné, bornés à l'instantané (UID < uidNext). */
async function allUids(c: ImapFlow, uidNext: number): Promise<Set<number>> {
  const found = await c.search({ all: true }, { uid: true });
  return new Set((found || []).filter((u) => !uidNext || u < uidNext));
}
