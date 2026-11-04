/**
 * Vues de l'agenda : mois, semaine / jour (grille horaire : créer en glissant, déplacer et
 * redimensionner à la souris), liste. Chaque événement est un bouton (ouvert au clavier par Entrée).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Repeat } from 'lucide-react';
import type { Occ } from '@/lib/calendar';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/common/bits';
import { addDays, DAY_MS, fmtTime, fmtTimeRange, hourLabel, isoOf, minutesInDay, sameDay, weekdayNames } from './dates';

const HOUR_PX = 48;
const SNAP = 15;

export interface ViewProps {
  days: Date[];
  occurrences: Occ[];
  lang: string;
  firstDay: number;
  onOpen: (o: Occ) => void;
  onCreate: (startMs: number, endMs: number, allDay: boolean) => void;
  onGoDay: (iso: string) => void;
}

const isRecurring = (o: Occ) => o.recurrenceId !== null;

function occLabel(o: Occ, lang: string, t: (k: string, opt?: Record<string, unknown>) => string): string {
  const title = o.event.title || t('untitled');
  return o.allDay ? `${title}, ${t('fields.allDay')}` : `${title}, ${fmtTimeRange(o.start, o.end, lang)}`;
}

/** Occurrences qui touchent un jour (journée entière ou heures). */
function onDay(list: Occ[], day: Date): Occ[] {
  const a = day.getTime();
  const b = addDays(day, 1).getTime();
  return list.filter((o) => (o.end > a && o.start < b) || (o.start === o.end && o.start >= a && o.start < b));
}

function Chip({ o, lang, onOpen, compact }: { o: Occ; lang: string; onOpen: (o: Occ) => void; compact?: boolean }) {
  const { t } = useTranslation('calendar');
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(o);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={occLabel(o, lang, t)}
      className={cn(
        'flex w-full min-w-0 items-center gap-1 truncate rounded-[5px] px-1.5 text-start text-[11.5px] leading-[18px] voxel-transition focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none',
        o.allDay ? 'text-white hover:brightness-110' : 'text-text-1 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
        o.pending && 'opacity-60',
      )}
      style={o.allDay ? { background: o.color } : undefined}
    >
      {!o.allDay && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: o.color }} />}
      {!o.allDay && !compact && <span className="shrink-0 text-text-3 tabular-nums" dir="ltr">{fmtTime(o.start, lang)}</span>}
      <span className="truncate" dir="auto">{o.event.title || t('untitled')}</span>
    </button>
  );
}

// ------------------------------------------------------------------ mois

export function MonthView({ days, occurrences, lang, firstDay, onOpen, onCreate, onGoDay, month }: ViewProps & { month: number }) {
  const { t } = useTranslation('calendar');
  const names = weekdayNames(lang, firstDay, 'short');
  const today = new Date();
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const selRef = useRef(sel);

  /** Sélection de jours (clic : un créneau de 9 h ; glisser sur plusieurs jours : journée entière). */
  const beginSel = (i: number) => {
    selRef.current = { a: i, b: i };
    setSel(selRef.current);
    const at = (e: PointerEvent) => {
      const el = document.elementsFromPoint(e.clientX, e.clientY).find((n) => (n as HTMLElement).dataset?.monthIndex !== undefined) as HTMLElement | undefined;
      if (!el || !selRef.current) return;
      const b = Number(el.dataset.monthIndex);
      if (b !== selRef.current.b) {
        selRef.current = { ...selRef.current, b };
        setSel(selRef.current);
      }
    };
    const up = (e: PointerEvent) => {
      at(e);
      window.removeEventListener('pointermove', at);
      window.removeEventListener('pointerup', up);
      const s = selRef.current;
      selRef.current = null;
      setSel(null);
      if (!s) return;
      const lo = Math.min(s.a, s.b);
      const hi = Math.max(s.a, s.b);
      if (lo === hi) {
        const d = days[lo]!;
        onCreate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9).getTime(), new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10).getTime(), false);
      } else onCreate(days[lo]!.getTime(), addDays(days[hi]!, 1).getTime(), true);
    };
    window.addEventListener('pointermove', at);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b border-line" aria-hidden>
        {names.map((n) => (
          <div key={n} className="px-2 py-1.5 text-[11.5px] font-medium tracking-wide text-text-3 uppercase">
            {n}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6" role="grid" aria-label={t('views.month')}>
        {days.map((d, i) => {
          const list = onDay(occurrences, d);
          const inMonth = d.getMonth() === month;
          const isToday = sameDay(d, today);
          const lo = sel ? Math.min(sel.a, sel.b) : -1;
          const hi = sel ? Math.max(sel.a, sel.b) : -1;
          return (
            <div
              key={i}
              role="gridcell"
              data-month-index={i}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                beginSel(i);
              }}
              className={cn(
                'flex min-h-[84px] min-w-0 flex-col gap-0.5 border-e border-b border-line p-1 select-none',
                !inMonth && 'bg-black/[0.015] dark:bg-white/[0.015]',
                i >= lo && i <= hi && 'bg-voxel-accent-soft',
              )}
            >
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onGoDay(isoOf(d))}
                aria-label={new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long' }).format(d)}
                aria-current={isToday ? 'date' : undefined}
                className={cn(
                  'flex size-6 items-center justify-center self-start rounded-full text-[12px] tabular-nums voxel-transition hover:bg-black/[0.06] focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none dark:hover:bg-white/[0.08]',
                  isToday ? 'bg-voxel-accent font-semibold text-white hover:bg-voxel-accent' : inMonth ? 'text-text-1' : 'text-text-3',
                )}
              >
                {new Intl.NumberFormat(lang).format(d.getDate())}
              </button>
              {list.slice(0, 3).map((o) => (
                <Chip key={o.key} o={o} lang={lang} onOpen={onOpen} compact />
              ))}
              {list.length > 3 && (
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onGoDay(isoOf(d))}
                  className="self-start rounded px-1.5 text-[11.5px] text-text-2 hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none"
                >
                  {t('more', { count: list.length - 3 })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ semaine / jour

interface Placed {
  o: Occ;
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

/** Disposition des événements d'une colonne : voies côte à côte pour les chevauchements. */
function layoutDay(list: Occ[], day: Date): Placed[] {
  const items = list
    .filter((o) => !o.allDay)
    .map((o) => ({ o, s: minutesInDay(o.start, day), e: Math.max(minutesInDay(o.end, day), minutesInDay(o.start, day) + 20) }))
    .sort((a, b) => a.s - b.s || b.e - a.e);
  const out: Placed[] = [];
  let cluster: Array<{ o: Occ; s: number; e: number; lane: number }> = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) out.push({ o: c.o, top: (c.s * HOUR_PX) / 60, height: Math.max(18, ((c.e - c.s) * HOUR_PX) / 60 - 2), lane: c.lane, lanes });
    cluster = [];
  };
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => c.e > it.s).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ ...it, lane });
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return out;
}

type Drag =
  | { kind: 'create'; day: number; a: number; b: number }
  | { kind: 'move'; o: Occ; day: number; offset: number; start: number; moved: boolean; origDay: number }
  | { kind: 'resize'; o: Occ; day: number; end: number; moved: boolean };

export function TimeGridView({
  days,
  occurrences,
  lang,
  onOpen,
  onCreate,
  onGoDay,
  onMove,
  onResize,
}: ViewProps & { onMove: (o: Occ, deltaMinutes: number) => void; onResize: (o: Occ, newEnd: number) => void }) {
  const { t } = useTranslation('calendar');
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(iv);
  }, []);
  const today = new Date(now);
  const placed = useMemo(() => days.map((d) => layoutDay(onDay(occurrences, d), d)), [days, occurrences]);
  const allDay = useMemo(() => days.map((d) => onDay(occurrences, d).filter((o) => o.allDay)), [days, occurrences]);

  // première ouverture : défilement vers 7 h (ou l'heure actuelle si elle est affichée)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const showNow = days.some((d) => sameDay(d, new Date()));
    const h = showNow ? Math.max(0, new Date().getHours() - 1) : 7;
    el.scrollTop = h * HOUR_PX;
  }, [days.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Jour et minutes sous le pointeur (colonnes repérées par `data-day-index`, RTL compris). */
  const pointAt = (x: number, y: number): { day: number; min: number } | null => {
    const el = document.elementsFromPoint(x, y).find((n) => (n as HTMLElement).dataset?.dayIndex !== undefined) as HTMLElement | undefined;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const raw = ((y - rect.top) / HOUR_PX) * 60;
    const min = Math.min(24 * 60, Math.max(0, Math.round(raw / SNAP) * SNAP));
    return { day: Number(el.dataset.dayIndex), min };
  };

  /** Démarre un glisser : écouteurs posés tout de suite (un relâchement rapide n'est pas perdu). */
  const begin = (first: Drag) => {
    const update = (d: Drag | null) => {
      dragRef.current = d;
      setDrag(d);
    };
    update(first);
    const move = (e: PointerEvent) => {
      const p = pointAt(e.clientX, e.clientY);
      const d = dragRef.current;
      if (!p || !d) return;
      if (d.kind === 'create') update({ ...d, b: p.min, day: d.day });
      else if (d.kind === 'move') {
        const start = Math.max(0, Math.min(24 * 60 - SNAP, p.min - d.offset));
        if (start !== d.start || p.day !== d.day) update({ ...d, start, day: p.day, moved: true });
      } else {
        const end = Math.max(p.min, minutesInDay(d.o.start, days[d.day]!) + SNAP);
        if (end !== d.end) update({ ...d, end, moved: true });
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    const cancel = () => {
      cleanup();
      update(null);
    };
    const up = (e: PointerEvent) => {
      move(e);
      cleanup();
      const d = dragRef.current;
      update(null);
      if (!d) return;
      const day = days[d.day]!;
      if (d.kind === 'create') {
        const lo = Math.min(d.a, d.b);
        let hi = Math.max(d.a, d.b);
        if (hi - lo < SNAP) hi = lo + 60;
        onCreate(day.getTime() + lo * 60_000, day.getTime() + hi * 60_000, false);
      } else if (d.kind === 'move') {
        if (!d.moved) return onOpen(d.o);
        const newStart = day.getTime() + d.start * 60_000;
        const delta = Math.round((newStart - d.o.start) / 60_000);
        if (delta) onMove(d.o, delta);
      } else {
        if (!d.moved) return;
        onResize(d.o, day.getTime() + d.end * 60_000);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const startCreate = (e: RPointerEvent, dayIndex: number) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const p = pointAt(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    begin({ kind: 'create', day: dayIndex, a: p.min, b: p.min + SNAP });
  };

  const hours = Array.from({ length: 24 }, (_, h) => h);
  const cols = `56px repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* en-têtes des jours et journée entière */}
      <div className="grid border-b border-line" style={{ gridTemplateColumns: cols }}>
        <div className="flex items-end justify-end pe-1.5 pb-1.5 text-end text-[10px] leading-tight text-text-3">{t('fields.allDay')}</div>
        {days.map((d, i) => {
          const isToday = sameDay(d, today);
          return (
            <div key={i} className="min-w-0 border-s border-line px-1 pt-1.5 pb-1">
              <button
                type="button"
                onClick={() => onGoDay(isoOf(d))}
                aria-current={isToday ? 'date' : undefined}
                className="flex w-full items-baseline gap-1.5 rounded-md px-1 text-start voxel-transition hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none dark:hover:bg-white/[0.05]"
              >
                <span className="text-[11.5px] text-text-3 uppercase">{new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(d)}</span>
                <span className={cn('flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[14px] font-medium tabular-nums', isToday ? 'bg-voxel-accent text-white' : 'text-text-1')}>
                  {new Intl.NumberFormat(lang).format(d.getDate())}
                </span>
              </button>
              <div className="mt-1 flex min-h-5 flex-col gap-0.5">
                {allDay[i]!.map((o) => (
                  <Chip key={o.key} o={o} lang={lang} onOpen={onOpen} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {/* grille horaire */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: cols, height: 24 * HOUR_PX }}>
          <div className="relative" aria-hidden>
            {hours.map((h) => (
              <div key={h} className="absolute end-2 -translate-y-1/2 text-[10.5px] text-text-3 tabular-nums" style={{ top: h * HOUR_PX }}>
                {h ? hourLabel(h, lang) : ''}
              </div>
            ))}
          </div>
          {days.map((d, i) => {
            const isToday = sameDay(d, today);
            const ghost =
              drag && drag.day === i
                ? drag.kind === 'create'
                  ? { top: (Math.min(drag.a, drag.b) * HOUR_PX) / 60, height: Math.max(SNAP, Math.abs(drag.b - drag.a)) * (HOUR_PX / 60), color: undefined as string | undefined }
                  : drag.kind === 'move' && drag.moved
                    ? { top: (drag.start * HOUR_PX) / 60, height: Math.max(18, ((drag.o.end - drag.o.start) / 60_000) * (HOUR_PX / 60)), color: drag.o.color }
                    : drag.kind === 'resize' && drag.moved
                      ? { top: (minutesInDay(drag.o.start, d) * HOUR_PX) / 60, height: ((drag.end - minutesInDay(drag.o.start, d)) * HOUR_PX) / 60, color: drag.o.color }
                      : null
                : null;
            return (
              <div
                key={i}
                data-day-index={i}
                onPointerDown={(e) => startCreate(e, i)}
                className={cn('relative border-s border-line select-none', isToday && 'bg-voxel-accent-softer')}
                style={{ backgroundImage: `repeating-linear-gradient(to bottom, var(--voxel-line) 0, var(--voxel-line) 1px, transparent 1px, transparent ${HOUR_PX}px)` }}
              >
                {placed[i]!.map((p) => {
                  const hidden = drag && drag.kind !== 'create' && drag.moved && drag.o.key === p.o.key;
                  return (
                    <div
                      key={p.o.key}
                      className={cn('absolute overflow-hidden rounded-[6px] border-s-[3px] text-[11.5px] leading-tight shadow-soft voxel-transition', hidden && 'opacity-30', p.o.pending && 'opacity-60')}
                      style={{
                        top: p.top,
                        height: p.height,
                        insetInlineStart: `calc(${(p.lane / p.lanes) * 100}% + 2px)`,
                        width: `calc(${100 / p.lanes}% - 4px)`,
                        borderColor: p.o.color,
                        background: `color-mix(in srgb, ${p.o.color} 16%, var(--voxel-panel))`,
                      }}
                    >
                      <button
                        type="button"
                        aria-label={occLabel(p.o, lang, t)}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          if (e.button !== 0 || e.pointerType === 'touch') return;
                          const pt = pointAt(e.clientX, e.clientY);
                          if (!pt) return;
                          begin({ kind: 'move', o: p.o, day: i, origDay: i, offset: pt.min - minutesInDay(p.o.start, d), start: minutesInDay(p.o.start, d), moved: false });
                        }}
                        onClick={(e) => {
                          // clic clavier (Entrée / Espace) : le pointeur gère déjà le clic souris
                          if (e.detail === 0) onOpen(p.o);
                          else if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === 'touch') onOpen(p.o);
                        }}
                        className="flex h-full w-full cursor-grab flex-col items-start px-1.5 py-0.5 text-start text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none active:cursor-grabbing"
                      >
                        <span className="flex w-full items-center gap-1 truncate font-medium">
                          {isRecurring(p.o) && <Repeat aria-hidden className="size-3 shrink-0 text-text-3" />}
                          <span className="truncate" dir="auto">{p.o.event.title || t('untitled')}</span>
                        </span>
                        {p.height > 30 && <span className="truncate text-[10.5px] text-text-2 tabular-nums" dir="ltr">{fmtTimeRange(p.o.start, p.o.end, lang)}</span>}
                      </button>
                      <div
                        aria-hidden
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          if (e.button !== 0) return;
                          begin({ kind: 'resize', o: p.o, day: i, end: minutesInDay(p.o.end, d), moved: false });
                        }}
                        className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                      />
                    </div>
                  );
                })}
                {ghost && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0.5 rounded-[6px] border border-voxel-accent bg-voxel-accent-soft"
                    style={{ top: ghost.top, height: ghost.height, ...(ghost.color ? { borderColor: ghost.color, background: `color-mix(in srgb, ${ghost.color} 22%, transparent)` } : {}) }}
                  />
                )}
                {isToday && (
                  <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-danger" style={{ top: (minutesInDay(now, d) * HOUR_PX) / 60 }}>
                    <span className="absolute -start-1 -top-[3px] size-2 rounded-full bg-danger" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ liste

export function AgendaView({ days, occurrences, lang, onOpen, onGoDay }: ViewProps) {
  const { t } = useTranslation('calendar');
  const groups = days.map((d) => ({ d, list: onDay(occurrences, d) })).filter((g) => g.list.length);
  if (!groups.length) return <EmptyState icon={<CalendarDays />} title={t('empty.title')} description={t('empty.range')} className="flex-1" />;
  const today = new Date();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ol className="mx-auto max-w-3xl px-4 py-3">
        {groups.map(({ d, list }) => (
          <li key={d.getTime()} className="flex gap-4 border-b border-line py-3 last:border-b-0">
            <button
              type="button"
              onClick={() => onGoDay(isoOf(d))}
              aria-current={sameDay(d, today) ? 'date' : undefined}
              className="flex w-16 shrink-0 flex-col items-center rounded-lg py-1 voxel-transition hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none dark:hover:bg-white/[0.05]"
            >
              <span className={cn('text-[22px] leading-none font-semibold tabular-nums', sameDay(d, today) ? 'text-voxel-accent-strong' : 'text-text-1')}>{new Intl.NumberFormat(lang).format(d.getDate())}</span>
              <span className="mt-1 text-[11px] text-text-3 uppercase">{new Intl.DateTimeFormat(lang, { weekday: 'short', month: 'short' }).format(d)}</span>
            </button>
            <ul className="min-w-0 flex-1 space-y-1">
              {list.map((o) => (
                <li key={o.key}>
                  <button
                    type="button"
                    onClick={() => onOpen(o)}
                    className={cn('flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-start voxel-transition hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:outline-none dark:hover:bg-white/[0.05]', o.pending && 'opacity-60')}
                  >
                    <span aria-hidden className="h-8 w-1 shrink-0 rounded-full" style={{ background: o.color }} />
                    <span className="w-28 shrink-0 text-[12.5px] text-text-2 tabular-nums">
                      {o.allDay || (o.start <= d.getTime() && o.end >= d.getTime() + DAY_MS) ? t('fields.allDay') : <span dir="ltr">{fmtTimeRange(o.start, o.end, lang)}</span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 truncate text-[13.5px] font-medium text-text-1">
                        {isRecurring(o) && <Repeat aria-label={t('repeating')} className="size-3.5 shrink-0 text-text-3" />}
                        <span className="truncate" dir="auto">
                          {o.event.title || t('untitled')}
                        </span>
                      </span>
                      {Object.values(o.event.locations ?? {})[0]?.name && (
                        <span className="block truncate text-[12px] text-text-3" dir="auto">
                          {Object.values(o.event.locations ?? {})[0]?.name}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
