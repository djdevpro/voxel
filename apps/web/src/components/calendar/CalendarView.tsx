/**
 * Écran Agenda : `/calendar/:view/:date?event=` (`view` ∈ month, week, day, agenda).
 * Bureau : agendas (couleur, case de visibilité, export) | barre (Aujourd'hui, précédent, suivant, vues) et vue.
 * Mobile : la liste des agendas passe dans un dialogue. Données : cache Dexie (`lib/calendar.ts`), plages lues à
 * l'affichage ; développement des récurrences côté client.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarDays, ChevronLeft, ChevronRight, Download, Layers, Plus, Upload, X } from 'lucide-react';
import { formatDuration } from '@voxel/jmap';
import { useAccounts } from '@/hooks/useData';
import { useLocalState } from '@/hooks/useLocalState';
import { useNav } from '@/nav/useNav';
import { CALENDAR_VIEWS, goCalendar, goHref, rememberCalendarView, todayIso, type CalendarViewKind } from '@/nav/nav';
import { calKey, DEFAULT_CALENDAR_COLOR, eventsOfCalendar, exportEvents, loadRange, patchEvent, syncCalendar, updateOccurrence, useCalendars, useOccurrences, type Occ } from '@/lib/calendar';
import type { Account } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import type { CalendarRow } from '@/lib/db';
import { cn } from '@/lib/utils';
import { currentLocale } from '@/i18n';
import { useDirection } from '@/hooks/useDirection';
import { AccountDot, EmptyState, IconButton } from '@/components/common/bits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { browserTimeZone, dateOf, firstDayOfWeek, periodTitle, shiftDate, viewRange } from './dates';
import { askScope, EventDialog, ScopeHost, type EditTarget } from './EventDialog';
import { emptyForm, shiftedStart as shiftedStartLocal } from './eventForm';
import { ImportIcsDialog } from './ImportIcsDialog';
import { AgendaView, MonthView, TimeGridView } from './views';

/** Boîtes qui annoncent l'agenda. */
export function useCalendarAccounts(): Account[] {
  const { data } = useAccounts();
  return useMemo(() => (data ?? []).filter((a) => a.capabilities.calendars), [data]);
}

const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

/** `?event=` : `<adresse>~<id>[~<occurrence>]`. */
const eventParam = (a: Account, o: Occ) => [a.email, o.base.id, o.recurrenceId ?? ''].join('~').replace(/~$/, '');

function CalendarList({
  accounts,
  calendars,
  hidden,
  toggle,
  onExport,
}: {
  accounts: Account[];
  calendars: CalendarRow[];
  hidden: string[];
  toggle: (k: string) => void;
  onExport: (c: CalendarRow) => void;
}) {
  const { t } = useTranslation('calendar');
  return (
    <div className="space-y-4">
      {accounts.map((a) => {
        const cals = calendars.filter((c) => c.accountId === a.id);
        return (
          <section key={a.id} aria-label={a.email}>
            {accounts.length > 1 && (
              <h3 className="mb-1 flex items-center gap-1.5 px-2 text-[11.5px] font-medium tracking-wide text-text-3 uppercase">
                <AccountDot color={a.color} />
                <span className="truncate">{a.displayName || a.email}</span>
              </h3>
            )}
            {!cals.length && <p className="px-2 text-[12.5px] text-text-3">{t('calendars.none')}</p>}
            <ul>
              {cals.map((c) => {
                const k = calKey(c.accountId, c.id);
                const on = !hidden.includes(k);
                const color = c.calendar.color || DEFAULT_CALENDAR_COLOR;
                return (
                  <li key={k} className="group flex items-center gap-1 rounded-md pe-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]">
                    <label className="flex h-[30px] min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-[13.5px] text-text-1">
                      <input type="checkbox" checked={on} onChange={() => toggle(k)} className="peer sr-only" />
                      <span
                        aria-hidden
                        className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border-2 voxel-transition peer-focus-visible:ring-2 peer-focus-visible:ring-voxel-accent"
                        style={{ borderColor: color, background: on ? color : 'transparent' }}
                      >
                        {on && <svg viewBox="0 0 12 12" className="size-3 text-white"><path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                      </span>
                      <span className="truncate" dir="auto">
                        {c.calendar.name}
                      </span>
                    </label>
                    <IconButton label={t('calendars.export', { name: c.calendar.name })} size="sm" onClick={() => onExport(c)} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                      <Download />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export default function CalendarView({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation('calendar');
  const nav = useNav();
  const accounts = useCalendarAccounts();
  const ids = useMemo(() => accounts.map((a) => a.id), [accounts]);
  const calendars = useCalendars(ids) ?? [];
  const [hidden, setHidden] = useLocalState<string[]>('voxel.calendar.hidden', []);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const lang = currentLocale();
  const dir = useDirection();
  const firstDay = firstDayOfWeek(lang);
  const view: CalendarViewKind = nav.calendar?.view ?? 'month';
  const date = nav.calendar?.date ?? todayIso();
  const { days, from, to } = useMemo(() => viewRange(view, date, firstDay), [view, date, firstDay]);
  const occurrences = useOccurrences(ids, from, to, hiddenSet);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const tz = browserTimeZone();

  // plages : lecture à l'affichage (et après une relecture complète du cache)
  const [reset, setReset] = useState(0);
  useEffect(() => {
    const on = () => setReset((n) => n + 1);
    window.addEventListener('voxel:calendar-reset', on);
    return () => window.removeEventListener('voxel:calendar-reset', on);
  }, []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all(ids.map((id) => loadRange(id, from, to).catch(() => undefined))).finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [ids.join(','), from, to, reset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    for (const id of ids) void syncCalendar(id);
  }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (v: CalendarViewKind, d: string, replace = false) => {
    rememberCalendarView(v);
    goCalendar(v, d, { replace });
  };
  const defaultCalendar = (): string => {
    const writable = calendars.filter((c) => !hiddenSet.has(calKey(c.accountId, c.id)) && c.calendar.myRights?.mayWriteAll !== false);
    const c = writable.find((x) => x.calendar.isDefault) ?? writable[0] ?? calendars[0];
    return c ? calKey(c.accountId, c.id) : '';
  };
  const create = (startMs: number, endMs: number, allDay: boolean) => {
    const cal = defaultCalendar();
    const account = accounts.find((a) => cal.startsWith(`${a.id}:`)) ?? accounts[0];
    if (!account) return;
    setEdit({ account, base: null, recurrenceId: null, initial: emptyForm(cal, startMs, endMs, allDay, tz) });
  };
  const createNow = () => {
    const d = dateOf(date);
    const now = new Date();
    const h = view === 'month' || view === 'agenda' ? 9 : now.getHours() + 1;
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.min(h, 23));
    create(s.getTime(), s.getTime() + 3600_000, false);
  };
  const open = (o: Occ) => {
    const a = accounts.find((x) => x.id === o.accountId);
    if (!a) return;
    goCalendar(view, date, { event: eventParam(a, o) });
  };

  // événement ouvert d'après l'URL (lien partageable)
  useEffect(() => {
    const p = nav.calendar?.event;
    if (!p) {
      if (edit?.base) setEdit(null);
      return;
    }
    const [email, id, rid] = p.split('~');
    const a = accounts.find((x) => x.email.toLowerCase() === email?.toLowerCase());
    const o = (occurrences ?? []).find((x) => x.accountId === a?.id && x.base.id === id && (x.recurrenceId ?? '') === (rid ?? ''));
    if (a && o) setEdit({ account: a, base: o.base, recurrenceId: o.recurrenceId });
    else if (a && id) {
      // occurrence hors de la plage affichée : la série seule
      void import('@/lib/db').then(({ db }) =>
        db.events.get([a.id, id]).then((row) => row && setEdit({ account: a, base: row.event, recurrenceId: rid || null })),
      );
    }
  }, [nav.calendar?.event, occurrences === undefined, accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeEdit = () => {
    if (nav.calendar?.event) goCalendar(view, date, { replace: true });
    setEdit(null);
  };

  /** Déplacement à la souris : toute la série (non récurrent) ou au choix pour une occurrence. */
  const move = async (o: Occ, deltaMin: number) => {
    const a = accounts.find((x) => x.id === o.accountId);
    if (!a || o.pending) return;
    try {
      let scope: 'this' | 'all' = 'all';
      if (o.recurrenceId) {
        const s = await askScope('edit');
        if (!s) return;
        scope = s;
      }
      if (scope === 'this' && o.recurrenceId) await updateOccurrence(a, o.base, o.recurrenceId, { ...o.event, start: shiftedStartLocal(o.event.start!, deltaMin) });
      else await patchEvent(a, o.base, { start: shiftedStartLocal(o.base.start!, deltaMin) });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const resize = async (o: Occ, newEnd: number) => {
    const a = accounts.find((x) => x.id === o.accountId);
    if (!a || o.pending) return;
    const duration = formatDuration(Math.max(15 * 60, Math.round((newEnd - o.start) / 1000)));
    try {
      let scope: 'this' | 'all' = 'all';
      if (o.recurrenceId) {
        const s = await askScope('edit');
        if (!s) return;
        scope = s;
      }
      if (scope === 'this' && o.recurrenceId) await updateOccurrence(a, o.base, o.recurrenceId, { ...o.event, duration });
      else await patchEvent(a, o.base, { duration });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const exportCal = async (c: CalendarRow) => {
    try {
      await loadRange(c.accountId, Date.now() - 5 * 365 * 86_400_000, Date.now() + 5 * 365 * 86_400_000).catch(() => undefined);
      const list = await eventsOfCalendar(c.accountId, c.id);
      await exportEvents(list, `${c.calendar.name || 'calendar'}.ics`);
      toast.success(t('toast.exported', { count: list.length }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // raccourcis de l'écran : t, j / k (ou n / p), m / w / d / a, c
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || edit || importOpen) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]')) return;
      const k = e.key;
      const views: Record<string, CalendarViewKind> = { m: 'month', w: 'week', d: 'day', a: 'agenda' };
      if (k === 't') go(view, todayIso());
      else if (k === 'j' || k === 'n') go(view, shiftDate(view, date, 1));
      else if (k === 'k' || k === 'p') go(view, shiftDate(view, date, -1));
      else if (views[k]) go(views[k], date);
      else if (k === 'c') createNow();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  });

  const toggle = (k: string) => setHidden((h) => (h.includes(k) ? h.filter((x) => x !== k) : [...h, k]));
  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const props = { days, occurrences: occurrences ?? [], lang, firstDay, onOpen: open, onCreate: create, onGoDay: (iso: string) => go('day', iso) };

  if (!accounts.length) {
    return <EmptyState icon={<CalendarDays />} title={t('unavailable.title')} description={t('unavailable.description')} className="flex-1" />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {!mobile && (
        <aside aria-label={t('calendars.title')} className="flex w-[232px] shrink-0 flex-col gap-3 border-e border-line p-3">
          <Button onClick={createNow} className="justify-start">
            <Plus />
            {t('actions.new')}
          </Button>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <h2 className="mb-1.5 px-2 text-[12px] font-semibold text-text-2">{t('calendars.title')}</h2>
            <CalendarList accounts={accounts} calendars={calendars} hidden={hidden} toggle={toggle} onExport={(c) => void exportCal(c)} />
          </div>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)} className="justify-start">
            <Upload />
            {t('import.open')}
          </Button>
        </aside>
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-busy={loading || undefined}>
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <Button variant="outline" size="sm" onClick={() => go(view, todayIso())} aria-keyshortcuts="t">
            {t('actions.today')}
          </Button>
          <div className="flex">
            <IconButton label={t('actions.previous')} shortcut="K" onClick={() => go(view, shiftDate(view, date, -1))}>
              <Prev />
            </IconButton>
            <IconButton label={t('actions.next')} shortcut="J" onClick={() => go(view, shiftDate(view, date, 1))}>
              <Next />
            </IconButton>
          </div>
          <h1 className={cn("min-w-0 flex-1 truncate text-[16px] font-semibold text-text-1 first-letter:uppercase", mobile && "order-[-9998] basis-[calc(100%-3rem)]")} aria-live="polite">
            {periodTitle(view, date, lang, firstDay)}
          </h1>
          <nav aria-label={t('views.label')} className="inline-flex rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.06]">
            {CALENDAR_VIEWS.map((v) => (
              <a
                key={v}
                href={`/calendar/${v}/${date}`}
                aria-current={v === view ? 'page' : undefined}
                aria-keyshortcuts={v[0]}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  go(v, date);
                }}
                className={cn('flex h-7 items-center rounded-md px-2.5 text-[12.5px] font-medium voxel-transition focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none', v === view ? 'bg-panel text-text-1 shadow-soft' : 'text-text-2 hover:text-text-1')}
              >
                {t(`views.${v}`)}
              </a>
            ))}
          </nav>
          {mobile && (
            <>
              <IconButton label={t('calendars.title')} onClick={() => setListOpen(true)}>
                <Layers />
              </IconButton>
              <IconButton label={t('actions.new')} onClick={createNow}>
                <Plus />
              </IconButton>
              <IconButton label={t('actions.backToMail')} onClick={() => goHref('/')} className="order-first">
                <X />
              </IconButton>
            </>
          )}
        </header>
        {view === 'month' ? (
          <MonthView {...props} month={dateOf(date).getMonth()} />
        ) : view === 'agenda' ? (
          <AgendaView {...props} />
        ) : (
          <TimeGridView {...props} onMove={(o, d) => void move(o, d)} onResize={(o, e) => void resize(o, e)} />
        )}
      </main>
      <EventDialog target={edit} onClose={closeEdit} accounts={accounts} calendars={calendars} />
      <ImportIcsDialog open={importOpen} onOpenChange={setImportOpen} accounts={accounts} calendars={calendars} />
      <ScopeHost />
      {mobile && (
        <Dialog open={listOpen} onOpenChange={setListOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('calendars.title')}</DialogTitle>
              <DialogDescription className="sr-only">{t('calendars.description')}</DialogDescription>
            </DialogHeader>
            <CalendarList accounts={accounts} calendars={calendars} hidden={hidden} toggle={toggle} onExport={(c) => void exportCal(c)} />
            <Button variant="outline" onClick={() => (setListOpen(false), setImportOpen(true))} className="justify-start">
              <Upload />
              {t('import.open')}
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}


