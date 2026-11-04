/**
 * Rappels de l'agenda : quand l'appli est ouverte, toutes les 30 s, les alertes des occurrences en
 * cache (Dexie) arrivées à échéance déclenchent une notification du navigateur (`Notification`, si l'utilisateur
 * l'a permise), sinon un toast. Chaque rappel n'est montré qu'une fois (mémoire locale de l'appareil).
 */
import { useEffect } from 'react';
import { toast } from 'sonner';
import { durationSeconds } from '@voxel/jmap';
import type { Account } from '@/lib/api';
import i18n, { currentLocale } from '@/i18n';
import { goCalendar } from '@/nav/nav';

const CHECK_MS = 30_000;
/** Au démarrage : rappels échus depuis moins de 10 min encore montrés. */
const CATCH_UP_MS = 10 * 60_000;
const FIRED_KEY = 'voxel.calendar.fired';
const MAX_FIRED = 500;

function readFired(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FIRED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeFired(list: string[]) {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(list.slice(-MAX_FIRED)));
  } catch {
    /* stockage indisponible */
  }
}

export function useReminders(accounts: Account[] | undefined) {
  const ids = (accounts ?? []).filter((a) => a.capabilities.calendars).map((a) => a.id);
  const key = ids.join(',');
  useEffect(() => {
    if (!ids.length) return;
    let last = Date.now() - CATCH_UP_MS;
    let stopped = false;
    const check = async () => {
      const now = Date.now();
      const since = last;
      last = now;
      try {
        // chargé à la demande : le développement des récurrences (ical.js) ne pèse pas sur l'ouverture
        const [{ db }, { occurrencesOf }] = await Promise.all([import('@/lib/db'), import('@/lib/calendar')]);
        // occurrences qui commencent dans les 8 jours (rappels jusqu'à une semaine avant) ou ont commencé il y a peu
        const from = since - 2 * 86_400_000;
        const to = now + 8 * 86_400_000;
        const accountsSet = new Set(ids);
        const rows = await db.events.where('start').below(to).filter((r) => accountsSet.has(r.accountId) && r.end > from).toArray();
        const occ = occurrencesOf(rows, from, to, new Set(), new Map());
        const fired = readFired();
        const seen = new Set(fired);
        for (const o of occ) {
          for (const [aid, a] of Object.entries(o.event.alerts ?? {})) {
            if (a.acknowledged) continue;
            const tr = a.trigger as { '@type': string; offset?: string; relativeTo?: string; when?: string };
            let at: number;
            if (tr['@type'] === 'AbsoluteTrigger' && tr.when) at = Date.parse(tr.when);
            else if (tr['@type'] === 'OffsetTrigger') {
              at = (tr.relativeTo === 'end' ? o.end : o.start) + durationSeconds(tr.offset) * 1000;
            } else continue;
            if (!(at > since && at <= now)) continue;
            const k = `${o.key}:${aid}:${at}`;
            if (seen.has(k)) continue;
            seen.add(k);
            fired.push(k);
            notify(o.event.title || i18n.t('calendar:untitled'), o.start, o.allDay);
          }
        }
        writeFired(fired);
      } catch {
        /* cache indisponible : prochain passage */
      }
    };
    const notify = (title: string, start: number, allDay: boolean) => {
      const lang = currentLocale();
      const when = allDay ? new Intl.DateTimeFormat(lang, { dateStyle: 'full' }).format(start) : new Intl.DateTimeFormat(lang, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(start);
      const body = i18n.t('calendar:reminder.body', { when });
      const open = () => {
        const d = new Date(start);
        goCalendar('day', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      };
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const n = new Notification(title, { body, tag: `voxel-reminder:${title}:${start}`, icon: '/icon-192.png' });
          n.onclick = () => {
            window.focus();
            open();
            n.close();
          };
          return;
        } catch {
          /* repli : toast */
        }
      }
      toast(title, { description: body, action: { label: i18n.t('calendar:reminder.open'), onClick: open }, duration: 15_000 });
    };
    void check();
    const iv = setInterval(() => !stopped && void check(), CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
