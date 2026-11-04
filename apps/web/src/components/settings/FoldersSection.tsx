/**
 * Paramètres → Dossiers (`?settings=folders`) : abonnements (« Afficher »), imbrication
 * (« Déplacer dans… » ou glisser-déposer sur un autre dossier), ordre (`sortOrder`), vider corbeille et indésirables.
 * Le dossier caché des réglages synchronisés n'apparaît jamais (retiré de `MailboxData`).
 */
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, CornerDownRight, Folder, Trash2 } from 'lucide-react';
import type { Mailbox } from '@voxel/jmap';
import { useAccounts } from '@/hooks/useData';
import { mailboxesQuery, mailboxLabel, type MailboxData } from '@/lib/mail';
import { compareMailboxes, isRoleMailbox, moveMailboxTo, moveTargets, reorderSiblings, setSubscribed } from '@/lib/folders';
import { mailboxPath } from '@/lib/sieve';
import { errorMessage } from '@/lib/api';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { ROLE_ICONS } from '@/components/sidebar/Sidebar';
import type { SystemRole } from '@/store/ui';
import { cn } from '@/lib/utils';
import { MailboxPicker, usePickedMailbox } from './MailboxPicker';
import { SectionIntro } from './ui';
import { confirmEmptyFolder } from './emptyFolder';

const ROOT = '__root__';
const DND_FOLDER = 'application/x-voxel-folder';

interface Row {
  m: Mailbox;
  depth: number;
  siblings: Mailbox[];
}

/** Arbre aplati, frères triés (rôles d'abord, puis ordre, puis nom). */
function flatten(data: MailboxData): Row[] {
  const ids = new Set(data.mailboxes.map((m) => m.id));
  const parentOf = (m: Mailbox) => (m.parentId && ids.has(m.parentId) ? m.parentId : null);
  const out: Row[] = [];
  const walk = (pid: string | null, depth: number) => {
    const kids = data.mailboxes.filter((m) => parentOf(m) === pid).sort(compareMailboxes);
    for (const m of kids) {
      out.push({ m, depth, siblings: kids });
      if (depth < 12) walk(m.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function FoldersSection() {
  const { t } = useTranslation('settings');
  const { data: all } = useAccounts();
  const accounts = all ?? [];
  const [accountId, setAccountId] = usePickedMailbox(accounts);
  const { data, isLoading } = useQuery({ ...mailboxesQuery(accountId), enabled: !!accountId });
  const rows = useMemo(() => (data ? flatten(data) : []), [data]);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast.error(t('folders.failed'), { description: errorMessage(e) });
    }
  };

  const reorder = (row: Row, dir: -1 | 1) => {
    const custom = row.siblings.filter((s) => !isRoleMailbox(s));
    const i = custom.findIndex((s) => s.id === row.m.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= custom.length) return;
    const next = custom.map((s) => s.id);
    [next[i], next[j]] = [next[j]!, next[i]!];
    void run(() => reorderSiblings(accountId, next));
  };

  const drop = (targetId: string | null) => {
    const id = dragging.current;
    dragging.current = null;
    setDropOn(null);
    if (!id || id === targetId) return;
    void run(() => moveMailboxTo(accountId, id, targetId));
  };

  if (!accounts.length) return null;

  return (
    <div className="max-w-[760px]">
      <SectionIntro>{t('folders.intro')}</SectionIntro>
      <MailboxPicker accounts={accounts} value={accountId} onChange={setAccountId} label={t('folders.mailbox')} />
      {isLoading || !data ? (
        <div className="space-y-2">
          <div className="voxel-skeleton h-9" />
          <div className="voxel-skeleton h-9" />
          <div className="voxel-skeleton h-9" />
        </div>
      ) : (
        <>
          <div
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DND_FOLDER)) return;
              e.preventDefault();
              setDropOn(ROOT);
            }}
            onDragLeave={() => setDropOn((d) => (d === ROOT ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              drop(null);
            }}
            className={cn('mb-2 rounded-lg border border-dashed border-line px-3 py-1.5 text-[12px] text-text-3', dropOn === ROOT && 'border-voxel-accent bg-voxel-accent-soft text-text-1')}
          >
            {t('folders.dropRoot')}
          </div>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label={t('folders.listLabel')}>
            {rows.map((row) => {
              const { m, depth } = row;
              const role = isRoleMailbox(m);
              const Icon = role ? ROLE_ICONS[m.role as SystemRole] : Folder;
              const custom = row.siblings.filter((s) => !isRoleMailbox(s));
              const idx = custom.findIndex((s) => s.id === m.id);
              const targets = role ? [] : moveTargets(data, m.id);
              return (
                <li
                  key={m.id}
                  draggable={!role}
                  onDragStart={(e) => {
                    dragging.current = m.id;
                    e.dataTransfer.setData(DND_FOLDER, m.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    dragging.current = null;
                    setDropOn(null);
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(DND_FOLDER) || dragging.current === m.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setDropOn(m.id);
                  }}
                  onDragLeave={() => setDropOn((d) => (d === m.id ? null : d))}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    drop(m.id);
                  }}
                  className={cn('flex flex-wrap items-center gap-2 bg-panel px-3 py-2 voxel-transition', dropOn === m.id && 'bg-voxel-accent-soft ring-1 ring-voxel-accent ring-inset')}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2" style={{ paddingInlineStart: depth * 16 }}>
                    {depth > 0 && <CornerDownRight className="size-3.5 shrink-0 text-text-3 rtl:-scale-x-100" />}
                    <Icon className="size-4 shrink-0 text-text-3" />
                    <span className="truncate text-[13px] text-text-1" dir="auto">
                      {mailboxLabel(m)}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-text-3 tabular">{m.totalEmails || ''}</span>
                  </div>
                  <label className={cn('flex items-center gap-1.5 text-[12px] text-text-2', role && 'opacity-50')}>
                    <Checkbox
                      checked={role || m.isSubscribed !== false}
                      disabled={role}
                      aria-label={t('folders.show', { name: mailboxLabel(m) })}
                      onCheckedChange={(v) => void run(() => setSubscribed(accountId, m.id, v === true))}
                    />
                    {t('folders.showShort')}
                  </label>
                  {!role && (
                    <>
                      <Select
                        value=""
                        onValueChange={(v) => void run(() => moveMailboxTo(accountId, m.id, v === ROOT ? null : v))}
                      >
                        <SelectTrigger size="sm" className="w-[150px] text-[12.5px]" aria-label={t('folders.moveInto', { name: m.name })}>
                          <SelectValue placeholder={t('folders.moveIntoShort')} />
                        </SelectTrigger>
                        <SelectContent>
                          {m.parentId && <SelectItem value={ROOT}>{t('folders.root')}</SelectItem>}
                          {targets.map((x) => (
                            <SelectItem key={x.id} value={x.id}>
                              <span dir="auto">{x.role ? mailboxLabel(x) : mailboxPath(data, x.id)}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="icon-sm" aria-label={t('folders.up', { name: m.name })} disabled={idx <= 0} onClick={() => reorder(row, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={t('folders.down', { name: m.name })} disabled={idx < 0 || idx >= custom.length - 1} onClick={() => reorder(row, 1)}>
                        <ArrowDown />
                      </Button>
                    </>
                  )}
                  {(m.role === 'trash' || m.role === 'junk') && (
                    <Button variant="outline" size="sm" disabled={!m.totalEmails} onClick={() => void confirmEmptyFolder(accountId, m.id)}>
                      <Trash2 /> {t('folders.empty')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
