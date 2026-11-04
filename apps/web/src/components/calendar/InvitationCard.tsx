/**
 * Carte d'invitation dans le lecteur : un message avec une partie `text/calendar` (`METHOD:REQUEST`)
 * affiche titre, date, organisateur et conflit éventuel, avec Accepter / Peut-être / Refuser (boîte JMAP : réponse
 * envoyée par le serveur si `sendSchedulingMessages` est accepté, sinon seulement l'ajout, et la carte le dit).
 * Boîte IMAP (passerelle sans iTIP) : seulement « Ajouter à l'agenda ».
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarCheck, CalendarDays, CalendarPlus, CircleAlert } from 'lucide-react';
import { eventLocation, eventSpan, findParticipant, organizerOf, type ParticipationStatus } from '@voxel/jmap';
import type { Account } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { conflictsOf, readInvitation, respondToInvitation, useEventByUid, type Invitation } from '@/lib/calendar';
import { goCalendar } from '@/nav/nav';
import { currentLocale } from '@/i18n';
import { Button } from '@/components/ui/button';
import { isoOf } from './dates';

export default function InvitationCard({ account, jmapAccountId, blobId }: { account: Account; jmapAccountId: string; blobId: string }) {
  const { t } = useTranslation('calendar');
  const lang = currentLocale();
  const [inv, setInv] = useState<Invitation | null | undefined>(undefined);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const existing = useEventByUid(account.id, inv?.event.uid);

  useEffect(() => {
    let alive = true;
    readInvitation(account, jmapAccountId, blobId)
      .then((r) => alive && setInv(r))
      .catch(() => alive && setInv(null));
    return () => {
      alive = false;
    };
  }, [account, jmapAccountId, blobId]);

  const span = inv?.event.start ? eventSpan(inv.event) : null;
  useEffect(() => {
    if (!span || !inv) return;
    let alive = true;
    void conflictsOf(account.id, span.start, span.end, inv.event.uid).then((list) => alive && setConflict(list[0]?.event.title || (list.length ? t('untitled') : null)));
    return () => {
      alive = false;
    };
  }, [inv, account.id, span?.start, span?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  if (inv === undefined) return <div className="voxel-skeleton mx-4 my-2 h-24 rounded-xl md:mx-5" aria-label={t('invite.loading')} />;
  if (!inv || !span) return null;
  const ev = inv.event;
  const org = organizerOf(ev);
  const canReply = account.protocol === 'jmap' && !!findParticipant(ev, account.email) && inv.method !== 'cancel' && inv.method !== 'reply';
  const mine = existing ? findParticipant(existing.event, account.email)?.[1].participationStatus : undefined;
  const when = ev.showWithoutTime
    ? new Intl.DateTimeFormat(lang, { dateStyle: 'full' }).formatRange?.(span.start, Math.max(span.start, span.end - 1)) ?? new Intl.DateTimeFormat(lang, { dateStyle: 'full' }).format(span.start)
    : new Intl.DateTimeFormat(lang, { dateStyle: 'full', timeStyle: 'short' }).formatRange?.(span.start, span.end) ?? new Intl.DateTimeFormat(lang, { dateStyle: 'full', timeStyle: 'short' }).format(span.start);
  const location = eventLocation(ev);

  const respond = async (status: ParticipationStatus | null) => {
    setBusy(true);
    try {
      const r = await respondToInvitation(account, inv, status);
      const msg = r.queued ? t('toast.queued') : status && canReply ? (r.sent ? t('invite.replySent') : t('invite.replyNotSent')) : t('invite.added');
      setNote(msg);
      toast.success(msg);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t('invite.label')} className="mx-4 my-2 rounded-xl border border-line bg-panel p-4 shadow-soft md:mx-5">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-voxel-accent-soft text-voxel-accent-strong">
          <CalendarDays className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11.5px] font-medium tracking-wide text-text-3 uppercase">{inv.method === 'cancel' ? t('invite.cancelled') : inv.method === 'reply' ? t('invite.reply') : t('invite.label')}</p>
          <h3 className="truncate text-[15px] font-semibold text-text-1" dir="auto">
            {ev.title || t('untitled')}
          </h3>
          <p className="text-[13px] text-text-2 first-letter:uppercase">{when}</p>
          {location && (
            <p className="truncate text-[12.5px] text-text-3" dir="auto">
              {location}
            </p>
          )}
          {org && <p className="text-[12.5px] text-text-3">{t('invite.organizer', { name: org.name ? `${org.name} <${org.email}>` : org.email })}</p>}
          {conflict && inv.method !== 'cancel' && (
            <p className="mt-1 flex items-center gap-1 text-[12.5px] text-flag">
              <CircleAlert className="size-3.5" />
              <span className="truncate">{t('invite.conflict', { title: conflict })}</span>
            </p>
          )}
          {existing && (
            <p className="mt-1 flex items-center gap-1 text-[12.5px] text-text-2">
              <CalendarCheck className="size-3.5" />
              {mine ? t('invite.inCalendarStatus', { status: t(`status.${mine}`) }) : t('invite.inCalendar')}
            </p>
          )}
        </div>
      </div>
      {inv.method !== 'cancel' && inv.method !== 'reply' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canReply ? (
            <>
              <Button size="sm" onClick={() => void respond('accepted')} disabled={busy} aria-pressed={mine === 'accepted'}>
                {t('invite.accept')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void respond('tentative')} disabled={busy} aria-pressed={mine === 'tentative'}>
                {t('invite.maybe')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void respond('declined')} disabled={busy} aria-pressed={mine === 'declined'}>
                {t('invite.decline')}
              </Button>
            </>
          ) : (
            !existing && (
              <Button size="sm" onClick={() => void respond(null)} disabled={busy}>
                <CalendarPlus />
                {t('invite.add')}
              </Button>
            )
          )}
          <Button size="sm" variant="ghost" onClick={() => goCalendar('day', isoOf(new Date(span.start)))}>
            {t('invite.show')}
          </Button>
        </div>
      )}
      {!canReply && account.protocol !== 'jmap' && inv.method === 'request' && <p className="mt-2 text-[12px] text-text-3">{t('invite.imapNote')}</p>}
      {note && (
        <p role="status" className="mt-2 text-[12.5px] text-text-2">
          {note}
        </p>
      )}
    </section>
  );
}
