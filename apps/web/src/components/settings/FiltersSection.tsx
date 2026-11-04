/**
 * Paramètres → Filtres (`?settings=filters`) : filtres côté serveur dans le script Sieve géré,
 * avec la liste de blocage et le répondeur. Mode avancé : texte brut du script.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Code2, GripVertical, ListFilter, Loader2, PenLine, Plus, Trash2, X } from 'lucide-react';
import {
  actionSupported,
  FILTER_ACTIONS,
  FILTER_FIELDS,
  FILTERS_MAX,
  missingExtensions,
  SIZE_OPS,
  TEXT_OPS,
  type FilterAction,
  type FilterActionType,
  type FilterCondition,
  type SieveFilter,
} from '@voxel/jmap';
import { useAccounts } from '@/hooks/useData';
import { mailboxesQuery, mailboxLabel, type MailboxData } from '@/lib/mail';
import { mailboxPath, previewManaged, regenerateManaged, replaceForeign, saveManaged, saveRawScript, sieveErrorMessage, sieveQuery, takeOverVacation, type SieveState } from '@/lib/sieve';
import { confirmDialog } from '@/store/confirm';
import { newFilterId, useFilterDraft } from '@/store/filterDraft';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { tFast } from '@/lib/motion';
import { MailboxPicker, usePickedMailbox } from './MailboxPicker';
import { Field, SectionIntro, Segmented, inputCls } from './ui';

const smallInput = `${inputCls} h-8 text-[13px]`;

function emptyFilter(): SieveFilter {
  return { id: newFilterId(), name: '', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'move', mailboxId: '' }] };
}

/** Dossiers proposés comme cibles (chemin complet, rôles traduits). */
function folderOptions(data: MailboxData | undefined): Array<{ id: string; label: string }> {
  if (!data) return [];
  return data.mailboxes
    .map((m) => ({ id: m.id, label: m.role ? mailboxLabel(m) : mailboxPath(data, m.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ------------------------------------------------------------------ résumé lisible

function useSummary(data: MailboxData | undefined) {
  const { t } = useTranslation('settings');
  const folders = useMemo(() => new Map(folderOptions(data).map((f) => [f.id, f.label])), [data]);
  return (f: SieveFilter) => {
    const conds = f.conditions.map((c) =>
      t('filters.summaryCondition', {
        field: c.field === 'header' ? c.header || t('filters.fields.header') : t(`filters.fields.${c.field}`),
        op: t(`filters.ops.${c.op}`),
        value: c.field === 'size' ? c.value.replace(/K$/, ` ${t('filters.kb')}`).replace(/M$/, ` ${t('filters.mb')}`) : c.value,
      }),
    );
    const acts = f.actions.map((a) => {
      const base = t(`filters.actions.${a.type}`);
      if (a.type === 'move' || a.type === 'copy') return `${base} ${folders.get(a.mailboxId) ?? '?'}`;
      if (a.type === 'keyword') return `${base} ${a.keyword}`;
      if (a.type === 'forward') return `${base} ${a.to}`;
      return base;
    });
    const join = f.match === 'any' ? t('filters.or') : t('filters.and');
    return conds.length ? t('filters.summary', { conditions: conds.join(` ${join} `), actions: acts.join(', ') }) : t('filters.summaryAlways', { actions: acts.join(', ') });
  };
}

// ------------------------------------------------------------------ éditeur

function ConditionRow({ c, onChange, onRemove, canRemove }: { c: FilterCondition; onChange: (c: FilterCondition) => void; onRemove: () => void; canRemove: boolean }) {
  const { t } = useTranslation('settings');
  const isSize = c.field === 'size';
  const sizeNum = c.value.replace(/[KM]$/i, '');
  const sizeUnit = /M$/i.test(c.value) ? 'M' : 'K';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={c.field}
        onValueChange={(field) => {
          const f = field as FilterCondition['field'];
          if (f === 'size') onChange({ field: f, op: 'over', value: '1M' });
          else onChange({ field: f, op: (TEXT_OPS as string[]).includes(c.op) ? c.op : 'contains', value: isSize ? '' : c.value, ...(f === 'header' ? { header: c.header ?? '' } : {}) });
        }}
      >
        <SelectTrigger size="sm" className="w-[150px]" aria-label={t('filters.field')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FILTER_FIELDS.map((f) => (
            <SelectItem key={f} value={f}>
              {t(`filters.fields.${f}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {c.field === 'header' && (
        <input className={cn(smallInput, 'w-[130px]')} dir="ltr" value={c.header ?? ''} placeholder={t('filters.headerPlaceholder')} aria-label={t('filters.headerName')} onChange={(e) => onChange({ ...c, header: e.target.value })} />
      )}
      <Select value={c.op} onValueChange={(op) => onChange({ ...c, op: op as FilterCondition['op'] })}>
        <SelectTrigger size="sm" className="w-[150px]" aria-label={t('filters.operator')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(isSize ? SIZE_OPS : TEXT_OPS).map((o) => (
            <SelectItem key={o} value={o}>
              {t(`filters.ops.${o}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isSize ? (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            className={cn(smallInput, 'w-[90px]')}
            value={sizeNum}
            aria-label={t('filters.value')}
            onChange={(e) => onChange({ ...c, value: `${e.target.value.replace(/\D/g, '')}${sizeUnit}` })}
          />
          <Select value={sizeUnit} onValueChange={(u) => onChange({ ...c, value: `${sizeNum}${u}` })}>
            <SelectTrigger size="sm" className="w-[80px]" aria-label={t('filters.unit')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="K">{t('filters.kb')}</SelectItem>
              <SelectItem value="M">{t('filters.mb')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : (
        <input
          className={cn(smallInput, 'min-w-[140px] flex-1')}
          dir="auto"
          value={c.value}
          placeholder={c.op === 'matches' ? t('filters.matchesPlaceholder') : t('filters.valuePlaceholder')}
          aria-label={t('filters.value')}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        />
      )}
      <Button variant="ghost" size="icon-sm" aria-label={t('filters.removeCondition')} onClick={onRemove} disabled={!canRemove}>
        <X />
      </Button>
    </div>
  );
}

function ActionRow({
  a,
  folders,
  extensions,
  onChange,
  onRemove,
}: {
  a: FilterAction;
  folders: Array<{ id: string; label: string }>;
  extensions: string[];
  onChange: (a: FilterAction) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const make = (type: FilterActionType): FilterAction => {
    switch (type) {
      case 'move':
      case 'copy':
        return { type, mailboxId: a.type === 'move' || a.type === 'copy' ? a.mailboxId : '' };
      case 'keyword':
        return { type, keyword: '' };
      case 'forward':
        return { type, to: '', keepCopy: actionSupported('forward', extensions, true) };
      default:
        return { type };
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={a.type} onValueChange={(v) => onChange(make(v as FilterActionType))}>
        <SelectTrigger size="sm" className="w-[190px]" aria-label={t('filters.action')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FILTER_ACTIONS.map((type) => {
            const ok = actionSupported(type, extensions);
            return (
              <SelectItem key={type} value={type} disabled={!ok}>
                {t(`filters.actions.${type}`)}
                {!ok && <span className="ms-1 text-[11px] text-text-3">({t('filters.unsupported')})</span>}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {(a.type === 'move' || a.type === 'copy') && (
        <Select value={a.mailboxId} onValueChange={(mailboxId) => onChange({ ...a, mailboxId })}>
          <SelectTrigger size="sm" className="min-w-[180px] flex-1" aria-label={t('filters.folder')}>
            <SelectValue placeholder={t('filters.chooseFolder')} />
          </SelectTrigger>
          <SelectContent>
            {folders.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                <span dir="auto">{f.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {a.type === 'keyword' && (
        <input className={cn(smallInput, 'min-w-[140px] flex-1')} dir="ltr" value={a.keyword} placeholder="$label1" aria-label={t('filters.keyword')} onChange={(e) => onChange({ ...a, keyword: e.target.value })} />
      )}
      {a.type === 'forward' && (
        <>
          <input type="email" className={cn(smallInput, 'min-w-[180px] flex-1')} dir="ltr" value={a.to} placeholder={t('filters.forwardPlaceholder')} aria-label={t('filters.forwardTo')} onChange={(e) => onChange({ ...a, to: e.target.value })} />
          <label className={cn('flex items-center gap-1.5 text-[12.5px] text-text-2', !actionSupported('forward', extensions, true) && 'opacity-50')}>
            <Checkbox checked={a.keepCopy} disabled={!actionSupported('forward', extensions, true)} onCheckedChange={(v) => onChange({ ...a, keepCopy: v === true })} />
            {t('filters.keepCopy')}
          </label>
        </>
      )}
      <Button variant="ghost" size="icon-sm" aria-label={t('filters.removeAction')} onClick={onRemove}>
        <X />
      </Button>
    </div>
  );
}

function FilterEditor({
  accountId,
  state,
  data,
  initial,
  onClose,
  onSave,
}: {
  accountId: string;
  state: SieveState;
  data: MailboxData | undefined;
  initial: SieveFilter;
  onClose: () => void;
  onSave: (f: SieveFilter) => Promise<boolean>;
}) {
  const { t } = useTranslation('settings');
  const [f, setF] = useState<SieveFilter>(initial);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ text?: string; error?: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const folders = useMemo(() => folderOptions(data), [data]);
  const missing = missingExtensions(f, state.extensions);

  // aperçu du Sieve généré, recalculé à chaque modification (repliable)
  useEffect(() => {
    if (!showPreview) return;
    let live = true;
    const h = setTimeout(() => {
      previewManaged(accountId, { ...state.managed, filters: [{ ...f, enabled: true }] })
        .then((text) => live && setPreview({ text }))
        .catch((e) => live && setPreview({ error: sieveErrorMessage(e) }));
    }, 200);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [accountId, f, showPreview, state.managed]);

  const save = async () => {
    setBusy(true);
    const ok = await onSave({ ...f, name: f.name.trim() || t('filters.untitled') });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] w-[min(760px,94vw)] max-w-none overflow-y-auto sm:max-w-none">
        <DialogTitle>{initial.name ? t('filters.editTitle') : t('filters.newTitle')}</DialogTitle>
        <DialogDescription className="sr-only">{t('filters.editorDescription')}</DialogDescription>
        <div className="space-y-5">
          <Field label={t('filters.name')}>
            <input className={inputCls} dir="auto" autoFocus value={f.name} placeholder={t('filters.namePlaceholder')} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <span className="text-[12.5px] font-medium text-text-2">{t('filters.conditions')}</span>
              <Segmented
                value={f.match}
                onChange={(match) => setF({ ...f, match })}
                options={[
                  { value: 'all', label: t('filters.matchAll') },
                  { value: 'any', label: t('filters.matchAny') },
                ]}
              />
            </div>
            <div className="space-y-2">
              {f.conditions.map((c, i) => (
                <ConditionRow
                  key={i}
                  c={c}
                  canRemove
                  onChange={(nc) => setF({ ...f, conditions: f.conditions.map((x, j) => (j === i ? nc : x)) })}
                  onRemove={() => setF({ ...f, conditions: f.conditions.filter((_, j) => j !== i) })}
                />
              ))}
              {!f.conditions.length && <p className="text-[12.5px] text-text-3">{t('filters.noConditions')}</p>}
            </div>
            <Button variant="ghost" size="sm" className="mt-1.5" onClick={() => setF({ ...f, conditions: [...f.conditions, { field: 'subject', op: 'contains', value: '' }] })}>
              <Plus /> {t('filters.addCondition')}
            </Button>
          </div>
          <div>
            <div className="mb-2 text-[12.5px] font-medium text-text-2">{t('filters.actionsTitle')}</div>
            <div className="space-y-2">
              {f.actions.map((a, i) => (
                <ActionRow
                  key={i}
                  a={a}
                  folders={folders}
                  extensions={state.extensions}
                  onChange={(na) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? na : x)) })}
                  onRemove={() => setF({ ...f, actions: f.actions.filter((_, j) => j !== i) })}
                />
              ))}
            </div>
            <Button variant="ghost" size="sm" className="mt-1.5" onClick={() => setF({ ...f, actions: [...f.actions, { type: 'markRead' }] })}>
              <Plus /> {t('filters.addAction')}
            </Button>
          </div>
          {missing.length > 0 && <p className="text-[12.5px] text-danger">{t('filters.missingExtension', { ext: missing.join(', ') })}</p>}
          <div>
            <button
              type="button"
              aria-expanded={showPreview}
              onClick={() => setShowPreview((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded text-[12.5px] text-text-2 voxel-transition hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none"
            >
              <Code2 className="size-3.5" /> {showPreview ? t('filters.hidePreview') : t('filters.showPreview')}
            </button>
            <AnimatePresence initial={false}>
              {showPreview && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tFast} className="overflow-hidden">
                  {preview?.error ? (
                    <p className="mt-2 text-[12.5px] text-danger">{preview.error}</p>
                  ) : (
                    <pre dir="ltr" className="mt-2 max-h-56 overflow-auto rounded-lg border border-line bg-black/[0.03] p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-text-2 dark:bg-white/[0.04]">
                      {preview?.text ?? '…'}
                    </pre>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t('filters.cancel')}
            </Button>
            <Button onClick={save} disabled={busy || missing.length > 0 || !f.actions.length}>
              {busy && <Loader2 className="animate-spin" />}
              {t('filters.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ mode avancé

function AdvancedEditor({ accountId, state, onDone }: { accountId: string; state: SieveState; onDone: () => void }) {
  const { t } = useTranslation('settings');
  const [text, setText] = useState(state.text ?? '');
  const [busy, setBusy] = useState(false);
  const readOnly = state.mode === 'foreign';
  useEffect(() => setText(state.text ?? ''), [state.text]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await saveRawScript(accountId, text);
      toast.success(r.pendingActivation ? t('filters.savedPending') : t('filters.rawSaved'));
    } catch (e) {
      toast.error(t('filters.saveFailed'), { description: sieveErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const backToManaged = async () => {
    const ok = await confirmDialog({ title: t('filters.backToManagedTitle'), description: t('filters.backToManagedText'), confirmLabel: t('filters.backToManaged') });
    if (!ok) return;
    setBusy(true);
    try {
      await regenerateManaged(accountId);
      toast.success(t('filters.regenerated'));
      onDone();
    } catch (e) {
      toast.error(t('filters.saveFailed'), { description: sieveErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const replace = async () => {
    const ok = await confirmDialog({ title: t('filters.replaceTitle'), description: t('filters.replaceText'), confirmLabel: t('filters.replace'), destructive: true });
    if (!ok) return;
    setBusy(true);
    try {
      await navigator.clipboard?.writeText(state.text ?? '').catch(() => undefined);
      await replaceForeign(accountId);
      toast.success(t('filters.replaced'));
      onDone();
    } catch (e) {
      toast.error(t('filters.saveFailed'), { description: sieveErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] leading-relaxed text-text-2">{readOnly ? t('filters.foreignText') : t('filters.advancedHint')}</p>
      <textarea
        dir="ltr"
        spellCheck={false}
        readOnly={readOnly}
        aria-label={t('filters.rawLabel')}
        className={cn(inputCls, 'h-[340px] resize-y py-2 font-mono text-[12px] leading-relaxed')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        {readOnly ? (
          <Button onClick={replace} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {t('filters.replace')}
          </Button>
        ) : (
          <>
            <Button onClick={save} disabled={busy || text === state.text}>
              {busy && <Loader2 className="animate-spin" />}
              {t('filters.validateSave')}
            </Button>
            {(state.mode === 'manual' || state.mode === 'corrupted') && (
              <Button variant="outline" onClick={backToManaged} disabled={busy}>
                {t('filters.backToManaged')}
              </Button>
            )}
          </>
        )}
        <div className="flex-1" />
        {!readOnly && (
          <Button variant="ghost" onClick={onDone}>
            {t('filters.closeAdvanced')}
          </Button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ section

export function FiltersSection() {
  const { t } = useTranslation('settings');
  const { data: all } = useAccounts();
  const accounts = (all ?? []).filter((a) => a.capabilities?.sieve);
  const [accountId, setAccountId] = usePickedMailbox(accounts);
  const { data: state, isLoading, error } = useQuery({ ...sieveQuery(accountId), enabled: !!accountId });
  const { data: mbData } = useQuery({ ...mailboxesQuery(accountId), enabled: !!accountId });
  const [editing, setEditing] = useState<SieveFilter | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const draft = useFilterDraft((s) => s.draft);
  const setDraft = useFilterDraft((s) => s.set);
  const summary = useSummary(mbData);
  const dragFrom = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  // « Créer un filtre… » depuis un message : ouvre l'éditeur prérempli
  useEffect(() => {
    if (!draft) return;
    if (draft.accountId !== accountId) setAccountId(draft.accountId);
    else if (state) {
      setEditing(draft.filter);
      setDraft(null);
    }
  }, [draft, accountId, state, setAccountId, setDraft]);

  const filters = state?.managed.filters ?? [];
  const editable = !!state && (state.mode === 'managed' || state.mode === 'none');

  const persist = async (next: SieveFilter[], okMsg?: string): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await saveManaged(accountId, (m) => ({ ...m, filters: next }));
      if (r.pendingActivation) toast.warning(t('filters.savedPending'));
      else if (okMsg) toast.success(okMsg);
      return true;
    } catch (e) {
      toast.error(t('filters.saveFailed'), { description: sieveErrorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= filters.length || from === to) return;
    const next = filters.slice();
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    void persist(next);
  };

  const remove = async (f: SieveFilter) => {
    const ok = await confirmDialog({ title: t('filters.deleteTitle', { name: f.name }), description: t('filters.deleteText'), confirmLabel: t('filters.delete'), destructive: true });
    if (ok) void persist(filters.filter((x) => x.id !== f.id), t('filters.deleted'));
  };

  const takeOver = async () => {
    setBusy(true);
    try {
      await takeOverVacation(accountId);
      toast.success(t('sieve.takenOver'));
    } catch (e) {
      toast.error(t('filters.saveFailed'), { description: sieveErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!accounts.length) return <p className="text-[13px] text-text-2">{t('blocked.unsupported')}</p>;

  return (
    <div className="max-w-[720px]">
      <SectionIntro>{t('filters.intro')}</SectionIntro>
      <MailboxPicker accounts={accounts} value={accountId} onChange={setAccountId} label={t('filters.mailbox')} />
      {isLoading || !state ? (
        error ? (
          <p className="text-[13px] text-danger">{sieveErrorMessage(error)}</p>
        ) : (
          <div className="space-y-2">
            <div className="voxel-skeleton h-14" />
            <div className="voxel-skeleton h-14" />
          </div>
        )
      ) : (
        <div className="space-y-4">
          <SieveBanners state={state} busy={busy} onTakeOver={takeOver} />
          {advanced || state.mode === 'foreign' ? (
            <AdvancedEditor accountId={accountId} state={state} onDone={() => setAdvanced(false)} />
          ) : (
            <>
              {(state.mode === 'manual' || state.mode === 'corrupted') && (
                <p className="rounded-lg border border-line bg-black/[0.02] p-3 text-[12.5px] leading-relaxed text-text-2 dark:bg-white/[0.03]">
                  {state.mode === 'manual' ? t('filters.manualMode') : t('filters.corrupted')}
                </p>
              )}
              {filters.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-6 py-10 text-center">
                  <ListFilter className="size-6 text-text-3" />
                  <p className="text-[13px] text-text-2">{t('filters.empty')}</p>
                </div>
              ) : (
                <ul className="space-y-1.5" aria-label={t('filters.listLabel')}>
                  {filters.map((f, i) => (
                    <li
                      key={f.id}
                      draggable={editable}
                      onDragStart={(e: DragEvent) => {
                        dragFrom.current = i;
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', f.id);
                      }}
                      onDragOver={(e) => {
                        if (dragFrom.current === null) return;
                        e.preventDefault();
                        setDropAt(i);
                      }}
                      onDragLeave={() => setDropAt((d) => (d === i ? null : d))}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = dragFrom.current;
                        dragFrom.current = null;
                        setDropAt(null);
                        if (from !== null) move(from, i);
                      }}
                      onDragEnd={() => {
                        dragFrom.current = null;
                        setDropAt(null);
                      }}
                      onKeyDown={(e) => {
                        if (!editable || !e.altKey) return;
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          move(i, i - 1);
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          move(i, i + 1);
                        }
                      }}
                      className={cn(
                        'group flex items-center gap-2 rounded-xl border border-line bg-panel p-2.5 voxel-transition',
                        dropAt === i && 'ring-2 ring-voxel-accent',
                        !f.enabled && 'opacity-60',
                      )}
                    >
                      {editable && <GripVertical aria-hidden className="size-4 shrink-0 cursor-grab text-text-3" />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium text-text-1" dir="auto">
                          {f.name || t('filters.untitled')}
                        </div>
                        <div className="truncate text-[12px] text-text-2" dir="auto">
                          {summary(f)}
                        </div>
                      </div>
                      {editable && (
                        <>
                          <Button variant="ghost" size="icon-sm" aria-label={t('filters.moveUp')} title={t('filters.moveUpHint')} disabled={busy || i === 0} onClick={() => move(i, i - 1)}>
                            <ArrowUp />
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label={t('filters.moveDown')} title={t('filters.moveDownHint')} disabled={busy || i === filters.length - 1} onClick={() => move(i, i + 1)}>
                            <ArrowDown />
                          </Button>
                          <Switch
                            checked={f.enabled}
                            disabled={busy || (!f.enabled && missingExtensions(f, state.extensions).length > 0)}
                            aria-label={t('filters.enabled', { name: f.name })}
                            onCheckedChange={(enabled) => void persist(filters.map((x) => (x.id === f.id ? { ...x, enabled } : x)))}
                            className="data-[state=checked]:bg-voxel-accent"
                          />
                          <Button variant="ghost" size="icon-sm" aria-label={t('filters.edit', { name: f.name })} onClick={() => setEditing(f)}>
                            <PenLine />
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label={t('filters.delete')} className="hover:text-danger" onClick={() => void remove(f)}>
                            <Trash2 />
                          </Button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {editable && (
                  <Button onClick={() => setEditing(emptyFilter())} disabled={busy || filters.length >= FILTERS_MAX}>
                    <Plus /> {t('filters.new')}
                  </Button>
                )}
                <div className="flex-1" />
                <Button variant="ghost" className="text-text-2" onClick={() => setAdvanced(true)}>
                  <Code2 /> {t('filters.advanced')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {editing && state && (
        <FilterEditor
          accountId={accountId}
          state={state}
          data={mbData}
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(f) => {
            const exists = filters.some((x) => x.id === f.id);
            return persist(exists ? filters.map((x) => (x.id === f.id ? f : x)) : [...filters, f], t('filters.saved'));
          }}
        />
      )}
    </div>
  );
}

/** Messages communs aux sections qui écrivent le script géré (filtres, répondeur). */
export function SieveBanners({ state, busy, onTakeOver }: { state: SieveState; busy: boolean; onTakeOver: () => void }) {
  const { t } = useTranslation('settings');
  if (state.activeOther === 'vacation' && state.jmapVacationEnabled) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-voxel-accent-soft/50 p-3 text-[12.5px] leading-relaxed text-text-1">
        <span className="min-w-0 flex-1">{t('sieve.vacationActive')}</span>
        {state.extensions.includes('vacation') && (
          <Button size="sm" onClick={onTakeOver} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {t('sieve.takeOver')}
          </Button>
        )}
      </div>
    );
  }
  if (state.activeOther && state.activeOther !== 'vacation' && state.mode !== 'foreign') {
    return <p className="rounded-lg border border-line p-3 text-[12.5px] text-text-2">{t('sieve.otherActive', { name: state.activeOther })}</p>;
  }
  return null;
}
