import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Search, X, CornerDownLeft, Sparkles, MessagesSquare, History, type LucideIcon } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useUi, type SearchChip } from '@/store/ui';
import { useNav } from '@/nav/useNav';
import { applySearch } from '@/nav/nav';
import { queryFromSearch } from '@/nav/model';
import { OPERATORS, canonicalKey, chipLabel, operatorLabel, parseQuery } from '@/lib/search';
import { useTranslation } from 'react-i18next';
import { db } from '@/lib/db';
import { cn } from '@/lib/utils';
import { tFast } from '@/lib/motion';
import { Kbd } from '@/components/common/bits';
import { prefetchAiChat, useAiChat } from '@/store/aiChat';

/**
 * Recherche avec chips (`from:`, `to:`, `has:attachment`, `is:unread`, `before:`…).
 * Mode IA (`onAsk` défini) : pas de recherche pendant la frappe ; Entrée demande à l'assistant, Alt+Entrée recherche.
 */
export function SearchBar({
  className,
  autoFocus,
  placement = 'top',
  onAsk,
}: {
  className?: string;
  autoFocus?: boolean;
  placement?: 'top' | 'bottom';
  onAsk?: (text: string) => void;
}) {
  const aiMode = !!onAsk;
  const chatStarted = useAiChat((s) => s.started && !s.open);
  const openChat = useAiChat((s) => s.openChat);
  const nav = useNav();
  const search = nav.search;
  const tick = useUi((s) => s.searchFocusTick);
  /** dernière requête écrite dans l'URL par cette barre (évite d'écraser la saisie en cours) */
  const lastApplied = useRef<string | null>(null);
  const searching = nav.q.length > 0;
  /** Écrit la recherche dans l'URL : push pour entrer en recherche, replace ensuite (frappe, retouches). */
  const setSearch = (s: { chips: SearchChip[]; text: string }, opts: { replace?: boolean } = {}) => {
    lastApplied.current = queryFromSearch(s);
    applySearch(s, { replace: opts.replace ?? searching });
  };
  const [chips, setChips] = useState<SearchChip[]>(search.chips);
  const [text, setText] = useState(search.text);
  const [focused, setFocused] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { t, i18n } = useTranslation(['mail', 'ai-chat']);

  // l'URL a changé ailleurs (Retour, lien, palette) : la barre suit
  useEffect(() => {
    if (lastApplied.current !== null && lastApplied.current === nav.q) return;
    lastApplied.current = null;
    setChips(search.chips);
    setText(search.text);
  }, [search, nav.q]);

  // Frappe : la recherche s'applique après un court délai, en remplaçant l'entrée d'historique
  useEffect(() => {
    if (!focused || aiMode) return;
    const current = text.split(/\s+/).pop() ?? '';
    if (/^[^:\s]+:$/.test(current)) return; // opérateur en cours de saisie (« from: »)
    const parsed = parseQuery(text);
    const next = { chips: [...chips, ...parsed.chips], text: parsed.text };
    const q = queryFromSearch(next);
    if (q === nav.q) return;
    const id = setTimeout(() => {
      lastApplied.current = q;
      applySearch(next, { replace: true });
    }, 450);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, chips, focused, aiMode]);
  useEffect(() => {
    if (tick) input.current?.focus();
  }, [tick]);

  // Suggestions : opérateurs ou contacts selon le mot en cours
  const current = text.split(/\s+/).pop() ?? '';
  const opMatch = current.match(/^([^:\s]+):(.*)$/);
  const contactPrefix = opMatch && ['from', 'to'].includes(canonicalKey(opMatch[1]!) ?? '') ? opMatch[2]!.toLowerCase() : null;
  const contacts = useLiveQuery(
    async () => {
      if (contactPrefix === null) return [];
      try {
        const all = await db.contacts.orderBy('count').reverse().limit(400).toArray();
        return all.filter((c) => !contactPrefix || c.email.includes(contactPrefix) || c.name?.toLowerCase().includes(contactPrefix)).slice(0, 6);
      } catch {
        return [];
      }
    },
    [contactPrefix],
    [],
  );

  type Sugg = { label: string; hint?: string; icon?: LucideIcon; action?: boolean; apply: () => void };
  const freeText = parseQuery(text).text;
  const suggestions: Sugg[] = useMemo(() => {
    const out: Sugg[] = [];
    if (aiMode && freeText && !opMatch) {
      out.push({ label: t('ai-chat:bar.ask', { text: freeText }), hint: '↵', icon: Sparkles, action: true, apply: () => ask() });
      out.push({ label: t('ai-chat:bar.search', { text: freeText }), hint: 'Alt ↵', icon: Search, action: true, apply: () => submitAndBlur() });
    }
    if (opMatch) {
      const key = canonicalKey(opMatch[1]!);
      const op = OPERATORS.find((o) => o.key === key);
      if (op?.values)
        for (const v of op.values.filter((v) => v.startsWith(opMatch[2]!.toLowerCase())))
          out.push({ label: chipLabel({ key: op.key, value: v }), hint: `${op.key}:${v}`, apply: () => commitChip({ key: op.key, value: v }) });
      if (contactPrefix !== null)
        for (const c of contacts ?? [])
          out.push({ label: c.name ? `${c.name}` : c.email, hint: c.name ? c.email : undefined, apply: () => commitChip({ key: key!, value: c.email }) });
    } else if (!current) {
      for (const op of OPERATORS.slice(0, 7))
        out.push({
          label: operatorLabel(op.key),
          hint: op.hint,
          apply: () => {
            setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${op.key}:`);
            input.current?.focus();
          },
        });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opMatch?.[0], current, contacts, contactPrefix, i18n.resolvedLanguage, aiMode, freeText, text, chips]);

  useEffect(() => setHi(0), [suggestions.length]);

  function commitChip(chip: SearchChip) {
    const words = text.split(/\s+/);
    words.pop();
    const nextChips = [...chips.filter((c) => !(c.key === chip.key && c.value === chip.value)), chip];
    setChips(nextChips);
    const nextText = words.join(' ');
    setText(nextText ? nextText + ' ' : '');
    input.current?.focus();
  }

  function submit() {
    const parsed = parseQuery(text);
    const all = [...chips, ...parsed.chips];
    setChips(all);
    setText(parsed.text);
    setSearch({ chips: all, text: parsed.text });
  }

  function submitAndBlur() {
    submit();
    input.current?.blur();
  }

  /** Mode IA : envoie la saisie complète (chips comprises, telle que tapée) à l'assistant, puis vide la barre. */
  function ask() {
    const full = [queryFromSearch({ chips, text: '' }), text.trim()].filter(Boolean).join(' ');
    if (!full || !onAsk) return;
    setText('');
    setChips([]);
    input.current?.blur();
    onAsk(full);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      setHi((h) => (h + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      setHi((h) => (h - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Tab' && suggestions.length && focused && (opMatch || !current)) {
      e.preventDefault();
      suggestions[hi]?.apply();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (opMatch && suggestions[hi] && !text.endsWith(' ') && !e.altKey) suggestions[hi]!.apply();
      else if (!aiMode || e.altKey || !freeText) submitAndBlur();
      else {
        const s = suggestions[hi];
        if (s?.action) s.apply();
        else ask();
      }
    } else if (e.key === 'Escape') {
      if (text || chips.length) {
        setText('');
        setChips([]);
        setSearch({ chips: [], text: '' });
      } else input.current?.blur();
    } else if (e.key === 'Backspace' && !text && chips.length) {
      setChips(chips.slice(0, -1));
    } else if (e.key === ' ') {
      const m = current.match(/^([^:\s]+):("[^"]+"|\S+)$/);
      if (m && canonicalKey(m[1]!)) {
        e.preventDefault();
        commitChip({ key: canonicalKey(m[1]!)!, value: m[2]!.replace(/^"|"$/g, '') });
      }
    }
  }

  const active = chips.length > 0 || text.length > 0;
  const bottom = placement === 'bottom';
  const applied = search.chips.length > 0 || search.text.length > 0;

  return (
    <div className={cn('relative', className)}>
      <div
        onClick={() => input.current?.focus()}
        className={cn(
          'flex min-h-9 flex-wrap items-center gap-1 rounded-[10px] border px-2.5 py-1 voxel-transition',
          focused ? 'border-voxel-accent bg-panel shadow-[0_0_0_3px_var(--voxel-accent-soft)]' : 'border-transparent bg-black/[0.04] hover:bg-black/[0.06] dark:bg-white/[0.05] dark:hover:bg-white/[0.07]',
        )}
      >
        {aiMode && chatStarted && (
          <button
            type="button"
            aria-label={t('ai-chat:bar.resume')}
            title={t('ai-chat:bar.resume')}
            onClick={(e) => {
              e.stopPropagation();
              openChat();
            }}
            className="-ms-1 me-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-voxel-accent-strong outline-none hover:bg-voxel-accent-soft focus-visible:ring-2 focus-visible:ring-voxel-accent"
          >
            <History className="size-3.5" />
          </button>
        )}
        {aiMode ? <Sparkles className="me-1 size-4 shrink-0 text-voxel-accent-strong" /> : <Search className="me-1 size-4 shrink-0 text-text-3" />}
        <AnimatePresence initial={false}>
          {chips.map((c) => (
            <motion.span
              key={`${c.key}:${c.value}`}
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={tFast}
              className="inline-flex h-6 items-center gap-1 rounded-md bg-voxel-accent-soft pe-1 ps-2 text-[12px] font-medium text-voxel-accent-strong"
            >
              {chipLabel(c)}
              <button
                type="button"
                aria-label={t('search.removeFilter')}
                onClick={(e) => {
                  e.stopPropagation();
                  const next = chips.filter((x) => x !== c);
                  setChips(next);
                  if (applied) setSearch({ chips: next, text });
                }}
                className="flex size-4 items-center justify-center rounded opacity-60 hover:bg-black/10 hover:opacity-100"
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
          onChange={(e) => setText(e.target.value)}
          onFocus={() => {
            setFocused(true);
            // mode IA : moteur de discussion préchargé dès l'intention
            if (aiMode) prefetchAiChat();
          }}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={onKey}
          placeholder={chips.length ? '' : aiMode ? t('ai-chat:bar.placeholder') : t('search.placeholder')}
          aria-label={t('search.label')}
          className="h-7 min-w-[80px] flex-1 bg-transparent text-[13.5px] text-text-1 outline-none placeholder:text-text-3"
        />
        {active ? (
          <button
            type="button"
            aria-label={t('search.clear')}
            onClick={(e) => {
              e.stopPropagation();
              setText('');
              setChips([]);
              setSearch({ chips: [], text: '' });
            }}
            className="flex size-6 items-center justify-center rounded-md text-text-3 hover:bg-black/[0.06] hover:text-text-1 dark:hover:bg-white/[0.08]"
          >
            <X className="size-3.5" />
          </button>
        ) : focused ? null : aiMode ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openChat();
            }}
            onMouseEnter={prefetchAiChat}
            onFocus={prefetchAiChat}
            className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-text-2 outline-none voxel-transition hover:bg-black/[0.06] hover:text-text-1 focus-visible:ring-2 focus-visible:ring-voxel-accent dark:hover:bg-white/[0.08]"
          >
            <MessagesSquare className="size-3.5" />
            {t('ai-chat:bar.openChat')}
          </button>
        ) : (
          <Kbd className="hidden md:inline-flex">/</Kbd>
        )}
      </div>
      <AnimatePresence>
        {focused && suggestions.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: bottom ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: bottom ? 4 : -4 }}
            transition={tFast}
            className={cn('absolute inset-x-0 z-30 overflow-hidden', bottom ? 'bottom-full mb-1.5' : 'top-full mt-1.5', ' rounded-xl border border-(--voxel-float-border) bg-popover p-1 shadow-(--voxel-float-shadow)')}
            role="listbox"
          >
            {suggestions.map((s, i) => (
              <Fragment key={`${s.label}-${i}`}>
              {!opMatch && !s.action && (i === 0 || suggestions[i - 1]?.action) && (
                <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">{t('search.filters')}</div>
              )}
              <button
                type="button"
                role="option"
                aria-selected={i === hi}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHi(i)}
                onClick={s.apply}
                className={cn('flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-start text-[13px]', i === hi ? 'bg-accent text-text-1' : 'text-text-2')}
              >
                {s.icon && <s.icon className={cn('size-3.5 shrink-0', s.icon === Sparkles ? 'text-voxel-accent-strong' : 'text-text-3')} />}
                <span className={cn('font-medium', s.action && 'min-w-0 truncate')} dir={s.action ? 'auto' : undefined}>
                  {s.label}
                </span>
                {s.action ? (
                  s.hint && <span className="ms-auto shrink-0 font-mono text-[11.5px] text-text-3" dir="ltr">{s.hint}</span>
                ) : (
                  <>
                    {s.hint && <span className="truncate font-mono text-[11.5px] text-text-3" dir="ltr">{s.hint}</span>}
                    {i === hi && <CornerDownLeft className="ms-auto size-3.5 text-text-3 rtl:-scale-x-100" />}
                  </>
                )}
              </button>
              </Fragment>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
