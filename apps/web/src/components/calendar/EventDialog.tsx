/**
 * Dialogue d'événement : création et modification (titre, agenda, journée entière, début et fin avec
 * fuseau, récurrence, rappels, lieu, description, participants, disponibilité), suppression ; pour une occurrence
 * d'une série : « cet événement » ou « toute la série » (`askScope`).
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { create } from 'zustand';
import { Plus, Trash2, X } from 'lucide-react';
import type { CalendarEvent, CalendarEventCreate } from '@voxel/jmap';
import { occurrenceOf } from '@voxel/jmap/recurrence';
import type { Account } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { calKey, createEvent, deleteEvent, deleteOccurrence, updateOccurrence, updateSeries } from '@/lib/calendar';
import type { CalendarRow } from '@/lib/db';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { inputCls, Segmented } from '@/components/settings/ui';
import { confirmDialog } from '@/store/confirm';
import { browserTimeZone, firstDayOfWeek, timeZones } from './dates';
import { WEEKDAYS, eventOf, formOf, isEmail, validateForm, type EventForm, type RepeatKind } from './eventForm';
import { currentLocale } from '@/i18n';

// ------------------------------------------------------------------ « cet événement » ou « toute la série »

export type Scope = 'this' | 'all';
const useScopeStore = create<{ req: { kind: 'edit' | 'delete'; resolve: (s: Scope | null) => void } | null; set: (r: { kind: 'edit' | 'delete'; resolve: (s: Scope | null) => void } | null) => void }>()((set) => ({
  req: null,
  set: (req) => set({ req }),
}));

/** Demande la portée d'une modification d'occurrence ; `null` si annulé. */
export function askScope(kind: 'edit' | 'delete'): Promise<Scope | null> {
  return new Promise((resolve) => useScopeStore.getState().set({ kind, resolve }));
}

export function ScopeHost() {
  const { t } = useTranslation('calendar');
  const req = useScopeStore((s) => s.req);
  const set = useScopeStore((s) => s.set);
  const done = (s: Scope | null) => {
    req?.resolve(s);
    set(null);
  };
  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && done(null)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{req?.kind === 'delete' ? t('scope.deleteTitle') : t('scope.editTitle')}</DialogTitle>
          <DialogDescription>{t('scope.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button variant="outline" onClick={() => done('this')} autoFocus>
            {t('scope.this')}
          </Button>
          <Button variant="outline" onClick={() => done('all')}>
            {t('scope.all')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ dialogue

export interface EditTarget {
  account: Account;
  /** Série (null : création). */
  base: CalendarEvent | null;
  /** Occurrence ouverte (série récurrente). */
  recurrenceId: string | null;
  /** Formulaire de départ (création : plage cliquée ou glissée). */
  initial?: EventForm;
}

const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[120px_1fr] sm:items-center sm:gap-3">
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-text-2">
        {label}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function reminderLabel(m: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (m === 0) return t('reminders.atStart');
  if (m % 1440 === 0) return t('reminders.days', { count: m / 1440 });
  if (m % 60 === 0) return t('reminders.hours', { count: m / 60 });
  return t('reminders.minutes', { count: m });
}

export function EventDialog({
  target,
  onClose,
  accounts,
  calendars,
}: {
  target: EditTarget | null;
  onClose: () => void;
  accounts: Account[];
  calendars: CalendarRow[];
}) {
  const { t } = useTranslation('calendar');
  const id = useId();
  const lang = currentLocale();
  const tz = browserTimeZone();
  const zones = useMemo(() => timeZones(), []);
  const writable = calendars.filter((c) => c.calendar.myRights?.mayWriteAll !== false && c.calendar.myRights?.mayWriteOwn !== false);
  const [form, setForm] = useState<EventForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPerson, setNewPerson] = useState('');

  const source = useMemo<CalendarEventCreate | null>(() => {
    if (!target?.base) return null;
    return target.recurrenceId ? occurrenceOf(target.base, target.recurrenceId) : target.base;
  }, [target]);

  useEffect(() => {
    if (!target) {
      setForm(null);
      return;
    }
    setNewPerson('');
    if (target.initial) setForm(target.initial);
    else if (target.base && source) {
      const cal = Object.keys(target.base.calendarIds ?? {})[0] ?? '';
      const f = formOf(source, calKey(target.account.id, cal), tz);
      // occurrence : la répétition affichée est celle de la série
      if (target.recurrenceId) {
        const s = formOf(target.base, f.calendar, tz);
        Object.assign(f, { repeat: s.repeat, interval: s.interval, byDay: s.byDay, ends: s.ends, until: s.until, count: s.count });
      }
      setForm(f);
    }
  }, [target, source, tz]);

  if (!target || !form) return <Dialog open={false} />;
  const isNew = !target.base;
  const set = (p: Partial<EventForm>) => setForm({ ...form, ...p });
  const error = validateForm(form);
  const [accountId, calendarId] = [form.calendar.slice(0, form.calendar.indexOf(':')), form.calendar.slice(form.calendar.indexOf(':') + 1)];
  const account = accounts.find((a) => a.id === accountId) ?? target.account;
  const recurring = !!target.base?.recurrenceRules?.length || !!Object.keys(target.base?.recurrenceOverrides ?? {}).length;
  const weekdayFmt = new Intl.DateTimeFormat(lang, { weekday: 'narrow' });
  const weekdayLong = new Intl.DateTimeFormat(lang, { weekday: 'long' });

  const done = (queued: boolean, msg: string) => {
    toast.success(queued ? t('toast.queued') : msg);
    onClose();
  };

  const save = async () => {
    if (error || busy) return;
    setBusy(true);
    try {
      if (isNew) {
        const ev = eventOf(form, null, account.email);
        const r = await createEvent(account, calendarId, ev);
        done(r.queued, t('toast.created'));
        return;
      }
      const base = target.base!;
      const movedCalendar = !Object.keys(base.calendarIds ?? {}).includes(calendarId) || accountId !== target.account.id;
      if (accountId !== target.account.id) {
        // autre boîte : création là-bas puis suppression ici
        await createEvent(account, calendarId, { ...eventOf(form, { ...base, calendarIds: undefined }, account.email), uid: undefined });
        const r = await deleteEvent(target.account, base);
        done(r.queued, t('toast.saved'));
        return;
      }
      let scope: Scope = 'all';
      if (target.recurrenceId && recurring && !movedCalendar) {
        const s = await askScope('edit');
        if (!s) return;
        scope = s;
      }
      let r: { queued: boolean };
      if (scope === 'this' && target.recurrenceId) {
        r = await updateOccurrence(target.account, base, target.recurrenceId, eventOf(form, source, account.email));
      } else {
        // toute la série depuis une occurrence : le début de la série garde son jour, l'heure et la durée changent
        let next = eventOf(form, base, account.email);
        if (target.recurrenceId && base.start && next.start && !form.allDay) next = { ...next, start: `${base.start.slice(0, 10)}${next.start.slice(10)}` };
        else if (target.recurrenceId && base.start) next = { ...next, start: base.start };
        r = await updateSeries(target.account, base, { ...next, calendarIds: { [calendarId]: true } });
      }
      done(r.queued, t('toast.saved'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!target.base || busy) return;
    let scope: Scope = 'all';
    if (target.recurrenceId && recurring) {
      const s = await askScope('delete');
      if (!s) return;
      scope = s;
    } else if (!(await confirmDialog({ title: t('delete.title'), description: t('delete.description', { title: target.base.title || t('untitled') }), confirmLabel: t('delete.confirm'), destructive: true }))) return;
    setBusy(true);
    try {
      const r = scope === 'this' && target.recurrenceId ? await deleteOccurrence(target.account, target.base, target.recurrenceId) : await deleteEvent(target.account, target.base);
      done(r.queued, t('toast.deleted'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const addPerson = () => {
    const parts = newPerson
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!parts.length) return;
    set({ participants: [...new Set([...form.participants, ...parts])] });
    setNewPerson('');
  };

  const calendarOptions = writable.map((c) => {
    const a = accounts.find((x) => x.id === c.accountId);
    return { value: calKey(c.accountId, c.id), label: accounts.length > 1 ? `${c.calendar.name} — ${a?.email ?? ''}` : c.calendar.name };
  });
  if (!calendarOptions.some((o) => o.value === form.calendar)) {
    const c = calendars.find((x) => calKey(x.accountId, x.id) === form.calendar);
    if (c) calendarOptions.unshift({ value: form.calendar, label: c.calendar.name });
  }
  const errText = error && error !== 'endBeforeStart' ? t(`errors.${error}`) : error ? t('errors.endBeforeStart') : null;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{isNew ? t('dialog.newTitle') : t('dialog.editTitle')}</DialogTitle>
          <DialogDescription className="sr-only">{t('dialog.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            id={`${id}-title`}
            className={cn(inputCls, 'h-10 text-[15px] font-medium')}
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder={t('fields.titlePlaceholder')}
            aria-label={t('fields.title')}
            autoFocus
            dir="auto"
          />
          <Row label={t('fields.calendar')} htmlFor={`${id}-cal`}>
            <select id={`${id}-cal`} className={inputCls} value={form.calendar} onChange={(e) => set({ calendar: e.target.value })}>
              {calendarOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t('fields.allDay')} htmlFor={`${id}-allday`}>
            <input id={`${id}-allday`} type="checkbox" className="size-4 accent-[var(--voxel-accent)]" checked={form.allDay} onChange={(e) => set({ allDay: e.target.checked })} />
          </Row>
          <Row label={t('fields.start')} htmlFor={`${id}-sd`}>
            <div className="flex gap-2">
              <input id={`${id}-sd`} type="date" className={inputCls} value={form.startDate} onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                // la fin suit le début (même écart)
                const shift = (Date.parse(`${v}T00:00:00Z`) - Date.parse(`${form.startDate}T00:00:00Z`)) / 86_400_000;
                const end = new Date(Date.parse(`${form.endDate}T00:00:00Z`) + shift * 86_400_000).toISOString().slice(0, 10);
                set({ startDate: v, endDate: end });
              }} required />
              {!form.allDay && <input type="time" aria-label={t('fields.startTime')} className={cn(inputCls, 'w-32')} value={form.startTime} onChange={(e) => e.target.value && set({ startTime: e.target.value })} required />}
            </div>
          </Row>
          <Row label={t('fields.end')} htmlFor={`${id}-ed`}>
            <div className="flex gap-2">
              <input id={`${id}-ed`} type="date" className={inputCls} value={form.endDate} min={form.startDate} onChange={(e) => e.target.value && set({ endDate: e.target.value })} required aria-invalid={error === 'endBeforeStart' || undefined} />
              {!form.allDay && <input type="time" aria-label={t('fields.endTime')} className={cn(inputCls, 'w-32')} value={form.endTime} onChange={(e) => e.target.value && set({ endTime: e.target.value })} required aria-invalid={error === 'endBeforeStart' || undefined} />}
            </div>
          </Row>
          {!form.allDay && (
            <Row label={t('fields.timeZone')} htmlFor={`${id}-tz`}>
              <select id={`${id}-tz`} className={inputCls} value={form.timeZone} onChange={(e) => set({ timeZone: e.target.value })} dir="ltr">
                {(zones.includes(form.timeZone) ? zones : [form.timeZone, ...zones]).map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </Row>
          )}
          <Row label={t('fields.repeat')} htmlFor={`${id}-rep`}>
            <div className="space-y-2">
              <div className="flex gap-2">
                <select id={`${id}-rep`} className={inputCls} value={form.repeat} onChange={(e) => set({ repeat: e.target.value as RepeatKind })}>
                  {(['none', 'daily', 'weekly', 'monthly', 'yearly'] as const).map((k) => (
                    <option key={k} value={k}>
                      {t(`repeat.${k}`)}
                    </option>
                  ))}
                  {form.repeat === 'custom' && <option value="custom">{t('repeat.custom')}</option>}
                </select>
                {form.repeat !== 'none' && form.repeat !== 'custom' && (
                  <label className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-text-2">
                    {t('repeat.every')}
                    <input type="number" min={1} max={999} className={cn(inputCls, 'w-16')} value={form.interval} onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })} />
                  </label>
                )}
              </div>
              {form.repeat === 'weekly' && (
                <div role="group" aria-label={t('repeat.onDays')} className="flex flex-wrap gap-1">
                  {Array.from({ length: 7 }, (_, k) => (firstDayOfWeek(lang) + k) % 7).map((i) => {
                    const d = WEEKDAYS[i]!;
                    const on = form.byDay.includes(d);
                    const date = new Date(2023, 0, 1 + i);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        aria-label={weekdayLong.format(date)}
                        onClick={() => set({ byDay: on ? form.byDay.filter((x) => x !== d) : [...form.byDay, d] })}
                        className={cn('size-8 rounded-full text-[12px] font-medium voxel-transition focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none', on ? 'bg-voxel-accent text-white' : 'bg-black/[0.05] text-text-2 hover:text-text-1 dark:bg-white/[0.07]')}
                      >
                        {weekdayFmt.format(date)}
                      </button>
                    );
                  })}
                </div>
              )}
              {form.repeat !== 'none' && form.repeat !== 'custom' && (
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    value={form.ends}
                    onChange={(ends) => set({ ends })}
                    options={[
                      { value: 'never', label: t('repeat.never') },
                      { value: 'on', label: t('repeat.until') },
                      { value: 'after', label: t('repeat.after') },
                    ]}
                  />
                  {form.ends === 'on' && <input type="date" aria-label={t('repeat.untilDate')} className={cn(inputCls, 'w-auto')} min={form.startDate} value={form.until} onChange={(e) => set({ until: e.target.value })} aria-invalid={error === 'badUntil' || undefined} />}
                  {form.ends === 'after' && (
                    <label className="flex items-center gap-1.5 text-[12.5px] text-text-2">
                      <input type="number" min={1} max={999} className={cn(inputCls, 'w-20')} value={form.count} onChange={(e) => set({ count: Math.max(1, Number(e.target.value) || 1) })} />
                      {t('repeat.times')}
                    </label>
                  )}
                </div>
              )}
              {form.repeat === 'custom' && <p className="text-[12px] text-text-3">{t('repeat.customHint')}</p>}
            </div>
          </Row>
          <Row label={t('fields.reminders')}>
            <div className="flex flex-wrap items-center gap-1.5">
              {form.reminders.map((m, i) => (
                <span key={`${m}-${i}`} className="inline-flex h-7 items-center gap-1 rounded-full bg-black/[0.05] ps-2.5 pe-1 text-[12.5px] text-text-1 dark:bg-white/[0.07]">
                  {reminderLabel(m, t)}
                  <button type="button" aria-label={t('reminders.remove', { label: reminderLabel(m, t) })} onClick={() => set({ reminders: form.reminders.filter((_, j) => j !== i) })} className="flex size-5 items-center justify-center rounded-full text-text-3 hover:bg-black/[0.08] hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <select
                aria-label={t('reminders.add')}
                className={cn(inputCls, 'h-7 w-auto px-2 text-[12.5px]')}
                value=""
                onChange={(e) => e.target.value !== '' && set({ reminders: [...form.reminders, Number(e.target.value)].sort((a, b) => a - b) })}
              >
                <option value="">{t('reminders.add')}</option>
                {REMINDER_CHOICES.filter((m) => !form.reminders.includes(m)).map((m) => (
                  <option key={m} value={m}>
                    {reminderLabel(m, t)}
                  </option>
                ))}
              </select>
            </div>
          </Row>
          <Row label={t('fields.location')} htmlFor={`${id}-loc`}>
            <input id={`${id}-loc`} className={inputCls} value={form.location} onChange={(e) => set({ location: e.target.value })} dir="auto" />
          </Row>
          <Row label={t('fields.participants')} htmlFor={`${id}-ppl`}>
            <div className="space-y-1.5">
              {!!form.participants.length && (
                <ul className="flex flex-wrap gap-1.5">
                  {form.participants.map((p) => (
                    <li key={p} className={cn('inline-flex h-7 items-center gap-1 rounded-full ps-2.5 pe-1 text-[12.5px]', isEmail(p) ? 'bg-black/[0.05] text-text-1 dark:bg-white/[0.07]' : 'bg-danger/10 text-danger')} dir="ltr">
                      {p}
                      <button type="button" aria-label={t('participants.remove', { email: p })} onClick={() => set({ participants: form.participants.filter((x) => x !== p) })} className="flex size-5 items-center justify-center rounded-full text-text-3 hover:bg-black/[0.08] hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none">
                        <X className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <input
                  id={`${id}-ppl`}
                  type="email"
                  multiple
                  className={inputCls}
                  value={newPerson}
                  onChange={(e) => setNewPerson(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addPerson();
                    }
                  }}
                  onBlur={addPerson}
                  placeholder={t('participants.placeholder')}
                  dir="ltr"
                />
                <Button type="button" variant="outline" size="icon" aria-label={t('participants.add')} onClick={addPerson}>
                  <Plus />
                </Button>
              </div>
              {!!form.participants.length && account.protocol !== 'jmap' && <p className="text-[12px] text-text-3">{t('participants.noInvites')}</p>}
            </div>
          </Row>
          <Row label={t('fields.availability')}>
            <Segmented
              value={form.busy ? 'busy' : 'free'}
              onChange={(v) => set({ busy: v === 'busy' })}
              options={[
                { value: 'busy', label: t('availability.busy') },
                { value: 'free', label: t('availability.free') },
              ]}
            />
          </Row>
          <textarea
            className={cn(inputCls, 'h-24 resize-y py-2')}
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder={t('fields.description')}
            aria-label={t('fields.description')}
            dir="auto"
          />
          {errText && (
            <p role="alert" className="text-[12.5px] text-danger">
              {errText}
            </p>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            {!isNew ? (
              <Button type="button" variant="ghost" className="text-danger hover:text-danger" onClick={() => void remove()} disabled={busy}>
                <Trash2 />
                {t('actions.delete')}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" disabled={!!error || busy || !calendarId}>
                {isNew ? t('actions.create') : t('actions.save')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
