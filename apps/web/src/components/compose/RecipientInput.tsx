import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Users, X } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { cardDisplayName, expandGroup, foldText, isValidEmail, parseAddressList, type EmailAddress } from '@voxel/jmap';
import { db, type CardRow } from '@/lib/db';
import { cn } from '@/lib/utils';
import { tFast } from '@/lib/motion';
import { SenderAvatar } from '@/components/common/bits';
import { displayName } from '@/lib/format';
import { useTranslation } from 'react-i18next';

/** Suggestion : une adresse (fiche de contact ou adresse vue) ou un groupe (développé en destinataires). */
interface Suggestion {
  key: string;
  name: string | null;
  email: string;
  /** groupe : ses destinataires */
  members?: EmailAddress[];
}

/**
 * Suggestions : carnets d'adresses d'abord (fiches et groupes), puis adresses vues.
 * Taper le nom d'un groupe propose de l'insérer ; il est développé en destinataires.
 */
async function suggest(q: string, taken: Set<string>): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const seen = new Set(taken);
  const f = foldText(q);
  try {
    const rows = await db.cards.filter((r) => r.search.includes(f)).limit(60).toArray();
    const byAccount = new Map<string, CardRow[]>();
    for (const r of rows) {
      if (r.kind === 'group') {
        let all = byAccount.get(r.accountId);
        if (!all) byAccount.set(r.accountId, (all = await db.cards.where('accountId').equals(r.accountId).toArray()));
        const members = expandGroup(r.card, all.filter((x) => x.kind !== 'group').map((x) => x.card)).filter((m) => !taken.has(m.email.toLowerCase()));
        if (members.length) out.push({ key: `g:${r.accountId}:${r.id}`, name: cardDisplayName(r.card), email: '', members: members.map((m) => ({ name: m.name || null, email: m.email })) });
        continue;
      }
      const name = cardDisplayName(r.card) || null;
      const nameHit = !!name && foldText(name).includes(f);
      for (const email of r.emails) {
        if (seen.has(email) || (!nameHit && !email.includes(f))) continue;
        seen.add(email);
        out.push({ key: email, name, email });
      }
    }
  } catch {
    /* table absente : adresses vues seulement */
  }
  try {
    const recent = await db.contacts
      .filter((c) => c.email.includes(q) || (c.name?.toLowerCase().includes(q) ?? false))
      .limit(40)
      .toArray();
    recent.sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
    for (const r of recent) {
      if (seen.has(r.email)) continue;
      seen.add(r.email);
      out.push({ key: r.email, name: r.name, email: r.email });
    }
  } catch {
    /* ignoré */
  }
  return out.slice(0, 8);
}

/** Champ de destinataires à chips avec auto-complétion (carnets d'adresses, adresses vues). */
export function RecipientInput({
  label,
  value,
  onChange,
  autoFocus,
  trailing,
  onSubmit,
}: {
  label: string;
  value: EmailAddress[];
  onChange: (v: EmailAddress[]) => void;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
  onSubmit?: () => void;
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const q = text.trim().toLowerCase();
  const { t } = useTranslation('compose');

  const suggestions = useLiveQuery(
    async () => (q ? suggest(q, new Set(value.map((v) => v.email.toLowerCase()))) : []),
    [q, value.length],
    [] as Suggestion[],
  );

  const add = (list: EmailAddress[]) => {
    const next = [...value];
    for (const a of list) {
      if (!a.email) continue;
      if (next.some((v) => v.email.toLowerCase() === a.email.toLowerCase())) continue;
      next.push(a);
    }
    onChange(next);
    setText('');
    setHi(0);
  };

  const commitText = () => {
    if (!text.trim()) return false;
    add(parseAddressList(text));
    return true;
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const sugg = suggestions ?? [];
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      commitText();
      setTimeout(() => onSubmit?.(), 0);
      return;
    }
    if (e.key === 'ArrowDown' && sugg.length) {
      e.preventDefault();
      setHi((h) => (h + 1) % sugg.length);
    } else if (e.key === 'ArrowUp' && sugg.length) {
      e.preventDefault();
      setHi((h) => (h - 1 + sugg.length) % sugg.length);
    } else if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (sugg.length && focused && (e.key === 'Enter' || e.key === 'Tab')) {
        e.preventDefault();
        const s = sugg[hi]!;
        add(s.members ?? [{ name: s.name, email: s.email }]);
      } else if (text.trim()) {
        e.preventDefault();
        commitText();
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const chips = useMemo(() => value.map((a) => ({ a, valid: isValidEmail(a.email) })), [value]);

  return (
    <div className="relative flex min-h-10 items-start gap-2 border-b border-line px-4 py-1.5" onClick={() => input.current?.focus()}>
      <span className="mt-[5px] w-8 shrink-0 text-[13px] text-text-3">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <AnimatePresence initial={false}>
          {chips.map(({ a, valid }) => (
            <motion.span
              key={a.email}
              layout
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={tFast}
              title={a.email}
              className={cn(
                'inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-full border pe-1 ps-0.5 text-[12.5px]',
                valid ? 'border-line bg-muted/70 text-text-1' : 'border-danger/40 bg-danger/10 text-danger',
              )}
            >
              <SenderAvatar name={displayName(a)} email={a.email} size={20} />
              <span className="truncate" dir="auto">{a.name || a.email}</span>
              <button
                type="button"
                aria-label={t('remove', { name: a.email })}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((v) => v !== a));
                }}
                className="flex size-[18px] items-center justify-center rounded-full text-text-3 hover:bg-black/10 hover:text-text-1 dark:hover:bg-white/10"
              >
                <X className="size-3" />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        <input
          ref={input}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v) && v.trim().length > 1) {
              add(parseAddressList(v));
              return;
            }
            setText(v);
            setHi(0);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setTimeout(() => setFocused(false), 120);
            commitText();
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (/[,;\n]/.test(t)) {
              e.preventDefault();
              add(parseAddressList(t.replace(/\n/g, ',')));
            }
          }}
          onKeyDown={onKey}
          aria-label={t('recipients.label', { field: label })}
          className="h-7 min-w-[120px] flex-1 bg-transparent text-[13.5px] text-text-1 outline-none"
        />
      </div>
      {trailing}
      <AnimatePresence>
        {focused && (suggestions?.length ?? 0) > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={tFast}
            role="listbox"
            className="absolute top-full end-3 start-12 z-40 mt-1 overflow-hidden rounded-xl border border-(--voxel-float-border) bg-popover p-1 shadow-(--voxel-float-shadow)"
          >
            {suggestions!.map((s, i) => (
              <button
                key={s.key}
                type="button"
                role="option"
                aria-selected={i === hi}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHi(i)}
                onClick={() => add(s.members ?? [{ name: s.name, email: s.email }])}
                className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start', i === hi ? 'bg-accent' : '')}
              >
                {s.members ? (
                  <span aria-hidden className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-voxel-accent-soft text-text-2">
                    <Users className="size-3.5" />
                  </span>
                ) : (
                  <SenderAvatar name={s.name ?? s.email} email={s.email} size={26} />
                )}
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="block truncate text-[13px] font-medium text-text-1">{s.name || s.email}</span>
                  {s.members ? (
                    <span className="block truncate text-[11.5px] text-text-3">{t('contacts:compose.group', { count: s.members.length })}</span>
                  ) : (
                    s.name && <span className="block truncate text-[11.5px] text-text-3">{s.email}</span>
                  )}
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
