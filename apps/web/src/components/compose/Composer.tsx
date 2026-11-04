import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  ChevronDown,
  Clock,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Send,
  Trash2,
  X,
  Type,
  ExternalLink,
  Upload,
  File as FileIcon,
  FileText,
  SlidersHorizontal,
  Settings2,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { isValidEmail, textToHtml, type ComposeAttachment, type Identity } from '@voxel/jmap';
import { useUi, type ComposerState } from '@/store/ui';
import { useSettings } from '@/store/settings';
import { useAccount, useAccounts, useIdentities, useMailboxData } from '@/hooks/useData';
import { pickIdentity } from '@/lib/mail';
import { saveDraft, destroyDraft, uploadAttachment } from '@/lib/send';
import { scheduleSend } from '@/lib/sendQueue';
import { db } from '@/lib/db';
import { fileSize, shortDateTime } from '@/lib/format';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { RecipientInput } from './RecipientInput';
import { RichEditor, Toolbar as ToolbarLazy, type EditorHandle } from './Editor';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { templatesQuery } from '@/lib/templates';
import { openSettings } from '@/nav/nav';
import { currentLocale, LANGUAGES } from '@/i18n';
import { IconButton, AccountDot } from '@/components/common/bits';
import { cn } from '@/lib/utils';
import { tBase, tFast } from '@/lib/motion';
import { confirmDialog } from '@/store/confirm';
import { MOD } from '@/components/rail/AccountRail';
import { useAiEnabled, useAiReady } from '@/lib/ai/store';
import { useDictation } from '@/hooks/useDictation';
import { AiComposeMenu, isAiShortcut } from '@/components/ai/compose/AiComposeMenu';
import { AiSuggestionPanel } from '@/components/ai/compose/AiSuggestionPanel';
import { DictationButton, DictationPill } from '@/components/ai/compose/DictationButton';
import { useAiWriting } from '@/components/ai/compose/useAiWriting';

function signatureHtml(i: Identity | undefined): string {
  if (!i) return '';
  if (i.htmlSignature?.trim()) return i.htmlSignature;
  if (i.textSignature?.trim()) return textToHtml(i.textSignature);
  return '';
}

function titleOf(s: ComposerState): string {
  if (s.subject.trim()) return s.subject;
  switch (s.mode) {
    case 'reply':
    case 'replyAll':
      return i18n.t('compose:title.reply');
    case 'forward':
      return i18n.t('compose:title.forward');
    default:
      return i18n.t('compose:title.new');
  }
}

const PRIORITIES = ['high', 'normal', 'low'] as const;

interface Uploading {
  id: string;
  name: string;
  size: number;
}

/** Raccourci d'insertion d'une réponse type : Alt+T (touche physique, indépendante de la disposition). */
function isTemplateShortcut(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyT';
}

/** Nom d'une langue dans la langue de l'interface (sans texte en dur). */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([currentLocale()], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function nextMorning(daysAhead: number, weekday?: number): Date {
  const d = new Date();
  if (weekday !== undefined) {
    const diff = (weekday + 7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + diff);
  } else d.setDate(d.getDate() + daysAhead);
  d.setHours(8, 0, 0, 0);
  return d;
}

export function Composer({ state, floating }: { state: ComposerState; floating?: boolean }) {
  const update = useUi((s) => s.updateComposer);
  const close = useUi((s) => s.closeComposer);
  const { data: accounts } = useAccounts();
  const account = useAccount(state.accountId);
  const { data: identities } = useIdentities(state.accountId);
  const { data: mbData } = useMailboxData(state.accountId);
  const defaults = useSettings((s) => s.defaultIdentity);
  const identity = useMemo(
    () => identities?.find((i) => i.id === state.identityId) ?? pickIdentity(identities, defaults, state.accountId, account?.email),
    [identities, state.identityId, defaults, state.accountId, account?.email],
  );
  const editorRef = useRef<EditorHandle>(null);
  const htmlRef = useRef(state.html);
  const draftIdRef = useRef(state.draftEmailId);
  const [showCc, setShowCc] = useState(state.cc.length > 0);
  const [showBcc, setShowBcc] = useState(state.bcc.length > 0);
  const [showQuote, setShowQuote] = useState(state.mode === 'forward');
  const [toolbar, setToolbar] = useState(true);
  const [, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [dragOver, setDragOver] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const { data: templates } = useQuery(templatesQuery(state.accountId));
  const lang = state.lang ?? currentLocale();
  // ------- IA : rédaction assistée et dictée
  const aiEnabled = useAiEnabled();
  const aiWriting = useAiReady('writing');
  const writing = useAiWriting({ editor: () => editorRef.current?.editor, state });
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const dictation = useDictation({
    language: lang,
    onFinal: (text) => editorRef.current?.editor?.chain().focus().insertContent({ type: 'text', text: `${text} ` }).run(),
  });
  useEffect(() => {
    if (dictation.error) toast.error(dictation.error);
  }, [dictation.error]);
  const inlineImages = useRef(new Map<string, string>()); // objectURL -> cid
  const fileInput = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const localTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closed = useRef(false);
  const { t } = useTranslation('compose');
  const stateRef = useRef(state);
  stateRef.current = state;

  const signature = state.signature ? signatureHtml(identity) : '';

  // ------- brouillons : Dexie immédiat + JMAP (anti-rebond 2 s)
  const persistLocal = useCallback(() => {
    clearTimeout(localTimer.current);
    localTimer.current = setTimeout(() => {
      if (closed.current) return;
      const s = stateRef.current;
      // garde le contenu dans le store : survit aux remontages (fenêtre ↔ en ligne)
      if (s.html !== htmlRef.current) useUi.getState().updateComposer(s.id, { html: htmlRef.current });
      if (!hasContentRef.current()) {
        void db.drafts.delete(s.id).catch(() => undefined);
        return;
      }
      void db.drafts.put({ id: s.id, accountId: s.accountId, data: { ...s, html: htmlRef.current, draftEmailId: draftIdRef.current }, updatedAt: Date.now() }).catch(() => undefined);
    }, 250);
  }, []);

  const hasContent = () => {
    const s = stateRef.current;
    const text = htmlRef.current.replace(/<[^>]+>/g, '').trim();
    if (text || s.attachments.some((a) => a.disposition !== 'inline')) return true;
    // une réponse sans texte n'est pas un brouillon
    return s.mode === 'new' && !!(s.subject.trim() || s.to.length);
  };

  const hasContentRef = useRef(hasContent);
  hasContentRef.current = hasContent;

  const buildHtml = useCallback(
    (forSend: boolean) => {
      let html = editorRef.current?.getHTML() ?? htmlRef.current;
      if (forSend) for (const [url, cid] of inlineImages.current) html = html.split(url).join(`cid:${cid}`);
      const s = stateRef.current;
      const sig = s.signature ? signatureHtml(identity) : '';
      if (sig) html += `<div class="voxel-signature"><br>-- <br>${sig}</div>`;
      if (s.quoteHtml) html += `<br><div class="voxel-quoted">${s.quoteHtml}</div>`;
      return html;
    },
    [identity],
  );

  const saveRemote = useCallback(async () => {
    if (closed.current || !hasContent()) return;
    setSaveStatus('saving');
    const s = stateRef.current;
    try {
      const id = await saveDraft({
        accountId: s.accountId,
        identity,
        to: s.to,
        cc: s.cc,
        bcc: s.bcc,
        subject: s.subject,
        html: buildHtml(true),
        attachments: s.attachments,
        inReplyTo: s.inReplyTo,
        references: s.references,
        previousDraftId: draftIdRef.current,
        priority: s.priority,
        requestReceipt: s.requestReceipt,
      });
      if (closed.current) {
        // fermé pendant l'enregistrement : on nettoie
        if (id && id !== draftIdRef.current) void destroyDraft(s.accountId, id);
        return;
      }
      draftIdRef.current = id;
      update(s.id, { draftEmailId: id });
      setSaveStatus('saved');
    } catch {
      setSaveStatus('idle');
    }
  }, [identity, buildHtml, update]);

  const saveRemoteRef = useRef(saveRemote);
  saveRemoteRef.current = saveRemote;
  const scheduleSave = useCallback(() => {
    persistLocal();
    clearTimeout(saveTimer.current);
    // toujours la dernière version (identité chargée après coup…)
    saveTimer.current = setTimeout(() => void saveRemoteRef.current(), 2000);
  }, [persistLocal]);

  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    clearTimeout(localTimer.current);
  }, []);

  // change de champ → enregistrement
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    scheduleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.to, state.cc, state.bcc, state.subject, state.attachments, state.identityId, state.signature, state.priority, state.requestReceipt, state.lang]);

  // ------- pièces jointes
  const addFiles = useCallback(
    async (files: File[], inline = false) => {
      for (const f of files) {
        const up: Uploading = { id: Math.random().toString(36).slice(2), name: f.name, size: f.size };
        setUploading((u) => [...u, up]);
        try {
          const a = await uploadAttachment(stateRef.current.accountId, f);
          let att: ComposeAttachment = a;
          if (inline && f.type.startsWith('image/')) {
            const cid = `${up.id}@voxel`;
            att = { ...a, cid, disposition: 'inline' };
            const url = URL.createObjectURL(f);
            inlineImages.current.set(url, cid);
            editorRef.current?.insertImage(url);
          }
          update(stateRef.current.id, { attachments: [...stateRef.current.attachments, att] });
        } catch (e) {
          toast.error(i18n.t('compose:toasts.attachFailed', { name: f.name }), { description: (e as Error).message });
        } finally {
          setUploading((u) => u.filter((x) => x.id !== up.id));
        }
      }
    },
    [update],
  );

  const sendRef = useRef<(d?: Date) => void>(() => undefined);
  const onPasteFiles = useCallback((files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    if (imgs.length) void addFiles(imgs, true);
    if (others.length) void addFiles(others, false);
  }, [addFiles]);

  // ------- envoi
  const send = useCallback(
    async (sendAt?: Date) => {
      const s = stateRef.current;
      if (closed.current) return;
      if (uploading.length) return toast(i18n.t('compose:toasts.uploading'));
      if (!identity) return toast.error(i18n.t('compose:toasts.noIdentity'));
      const all = [...s.to, ...s.cc, ...s.bcc];
      if (!all.length) return toast.error(i18n.t('compose:toasts.noRecipient'));
      const bad = all.find((a) => !isValidEmail(a.email));
      if (bad) return toast.error(i18n.t('compose:toasts.invalidAddress', { email: bad.email }));
      if (!s.subject.trim()) {
        const ok = await confirmDialog({ title: i18n.t('compose:confirm.noSubject'), confirmLabel: i18n.t('compose:send') });
        if (!ok) return;
      }
      const html = buildHtml(true);
      closed.current = true;
      clearTimeout(saveTimer.current);
      clearTimeout(localTimer.current);
      const restore: ComposerState = { ...s, html: editorRef.current?.getHTML() ?? htmlRef.current, draftEmailId: draftIdRef.current, minimized: false };
      // Le brouillon local reste jusqu'à l'envoi effectif (supprimé par scheduleSend) : si l'onglet
      // est fermé pendant le délai d'annulation, la fenêtre est rouverte au prochain chargement.
      await db.drafts
        .put({ id: s.id, accountId: s.accountId, data: { ...restore, inline: undefined }, updatedAt: Date.now() })
        .catch(() => undefined);
      close(s.id);
      scheduleSend(
        {
          accountId: s.accountId,
          identity,
          to: s.to,
          cc: s.cc,
          bcc: s.bcc,
          subject: s.subject,
          html,
          attachments: s.attachments,
          inReplyTo: s.inReplyTo,
          references: s.references,
          draftEmailId: draftIdRef.current,
          sendAt: sendAt?.toISOString(),
          priority: s.priority,
          requestReceipt: s.requestReceipt,
        },
        restore,
      );
    },
    [identity, buildHtml, uploading.length, close],
  );

  sendRef.current = (d?: Date) => void send(d);

  const discard = async () => {
    closed.current = true;
    clearTimeout(saveTimer.current);
    clearTimeout(localTimer.current);
    const s = stateRef.current;
    await db.drafts.delete(s.id).catch(() => undefined);
    if (draftIdRef.current && s.mode !== 'draft') void destroyDraft(s.accountId, draftIdRef.current);
    else if (draftIdRef.current && s.mode === 'draft') {
      const ok = await confirmDialog({ title: i18n.t('compose:confirm.deleteDraft'), confirmLabel: i18n.t('common:actions.delete'), destructive: true });
      if (!ok) {
        closed.current = false;
        return;
      }
      void destroyDraft(s.accountId, draftIdRef.current);
    }
    close(s.id);
    if (hasContent()) toast(i18n.t('compose:toasts.draftDeleted'));
  };

  const closeKeep = async () => {
    // fermeture : enregistre le brouillon s'il y a du contenu
    clearTimeout(saveTimer.current);
    if (hasContent()) {
      await saveRemote();
      toast(i18n.t('compose:toasts.draftSaved'));
    }
    closed.current = true;
    await db.drafts.delete(stateRef.current.id).catch(() => undefined);
    close(stateRef.current.id);
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragOver(false);
    void addFiles([...e.dataTransfer.files]);
  };

  // ------- réponses types : insertion au curseur, objet repris s'il est vide
  const insertTemplate = (id: string) => {
    const tpl = templates?.find((x) => x.id === id);
    if (!tpl) return;
    editorRef.current?.insertHtml(tpl.html);
    if (tpl.subject && !stateRef.current.subject.trim()) update(stateRef.current.id, { subject: tpl.subject });
  };

  const sendLabel = t('send');
  const canSchedule = !!mbData?.canSchedule;
  const accountSwitch = (accounts?.length ?? 0) > 1 && state.mode === 'new';

  return (
    <div
      className={cn('relative flex min-h-0 flex-col bg-panel', floating ? 'h-full' : 'rounded-xl border border-line shadow-soft')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={onDrop}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.defaultPrevented) {
          e.preventDefault();
          void send();
        }
        if (isTemplateShortcut(e) && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          setTemplatesOpen(true);
          return;
        }
        if (aiWriting && isAiShortcut(e) && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          setAiMenuOpen(true);
          return;
        }
        if (e.key === 'Escape' && floating) {
          e.stopPropagation();
          update(state.id, { minimized: true });
        }
      }}
    >
      {!floating && (
        <div className="flex h-10 items-center gap-2 border-b border-line px-4 text-[12.5px] text-text-2">
          <span className="font-medium text-text-1">{state.mode === 'forward' ? t('inline.forward') : state.mode === 'replyAll' ? t('inline.replyAll') : t('inline.reply')}</span>
          <div className="flex-1" />
          <IconButton label={t('inline.openWindow')} size="sm" onClick={() => update(state.id, { inline: undefined })}>
            <ExternalLink />
          </IconButton>
          <IconButton label={t('inline.discard')} size="sm" onClick={discard}>
            <X />
          </IconButton>
        </div>
      )}

      {/* De */}
      {(identities?.length ?? 0) > 0 && (
        <div className="flex h-10 items-center gap-2 border-b border-line px-4">
          <span className="w-8 shrink-0 text-[13px] text-text-3">{t('fields.from')}</span>
          {accountSwitch && (
            <Select value={state.accountId} onValueChange={(v) => update(state.id, { accountId: v, identityId: undefined })}>
              <SelectTrigger size="sm" className="h-7 w-auto gap-1.5 border-0 bg-transparent px-1.5 text-[13px] shadow-none hover:bg-accent focus-visible:ring-0" aria-label={t('fields.account')}>
                <AccountDot color={account?.color ?? '#999'} />
              </SelectTrigger>
              <SelectContent>
                {accounts!.map((a) => (
                  <SelectItem key={a.id} value={a.id} className="text-[13px]">
                    <AccountDot color={a.color} /> {a.displayName || a.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={identity?.id ?? ''} onValueChange={(v) => update(state.id, { identityId: v })}>
            <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 justify-start gap-1 border-0 bg-transparent px-1.5 text-[13px] text-text-1 shadow-none hover:bg-accent focus-visible:ring-0 [&>svg]:ms-auto" aria-label={t('fields.identity')}>
              <SelectValue placeholder={t('fields.identityPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {identities!.map((i) => (
                <SelectItem key={i.id} value={i.id} className="text-[13px]">
                  <span dir="auto">{i.name ? `${i.name} <${i.email}>` : i.email}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <RecipientInput
        label={t('fields.to')}
        value={state.to}
        onChange={(to) => update(state.id, { to })}
        autoFocus={state.mode === 'new' || state.mode === 'forward'}
        onSubmit={() => void send()}
        trailing={
          <div className="mt-[3px] flex shrink-0 gap-0.5 text-[12.5px] text-text-3">
            {!showCc && (
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-text-1" onClick={() => setShowCc(true)}>
                {t('fields.cc')}
              </button>
            )}
            {!showBcc && (
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-text-1" onClick={() => setShowBcc(true)}>
                {t('fields.bcc')}
              </button>
            )}
          </div>
        }
      />
      <AnimatePresence initial={false}>
        {showCc && (
          <motion.div key="cc" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tFast}>
            <RecipientInput label={t('fields.cc')} value={state.cc} onChange={(cc) => update(state.id, { cc })} autoFocus={state.cc.length === 0} />
          </motion.div>
        )}
        {showBcc && (
          <motion.div key="bcc" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tFast}>
            <RecipientInput label={t('fields.bcc')} value={state.bcc} onChange={(bcc) => update(state.id, { bcc })} autoFocus={state.bcc.length === 0} />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex h-10 items-center border-b border-line px-4">
        <input
          value={state.subject}
          onChange={(e) => update(state.id, { subject: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={t('fields.subject')}
          aria-label={t('fields.subject')}
          dir="auto"
          spellCheck
          lang={lang}
          className="h-full flex-1 bg-transparent text-[13.5px] font-medium text-text-1 outline-none placeholder:font-normal placeholder:text-text-3"
        />
      </div>

      {/* corps */}
      <div className={cn('flex min-h-0 flex-col px-4 pt-3', floating && 'flex-1')}>
        <RichEditor
          handleRef={editorRef}
          initialHtml={state.html}
          autoFocus={state.mode === 'reply' || state.mode === 'replyAll' || state.mode === 'draft'}
          onChange={(h) => {
            htmlRef.current = h;
            scheduleSave();
          }}
          onPasteFiles={onPasteFiles}
          onSubmit={() => sendRef.current()}
          minHeight={floating ? 120 : 110}
          lang={lang}
          className={cn(floating && 'min-h-0 flex-1')}
          toolbar={false}
        />
        <div className={cn(floating ? 'max-h-[40%] shrink-0 overflow-y-auto' : '')}>
          {/* signature */}
          <AnimatePresence initial={false}>
            {signature && (
              <motion.div
                key={identity?.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tBase}
                className="group/sig relative mt-3 border-t border-dashed border-line pt-2.5"
              >
                <div className="voxel-prose voxel-sig" dir="auto" dangerouslySetInnerHTML={{ __html: signature }} />
                <button
                  type="button"
                  aria-label={t('signature.remove')}
                  onClick={() => update(state.id, { signature: false })}
                  className="absolute top-2 end-0 flex size-6 items-center justify-center rounded text-text-3 opacity-0 voxel-transition group-hover/sig:opacity-100 hover:bg-accent hover:text-text-1"
                >
                  <X className="size-3.5" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          {!state.signature && signatureHtml(identity) && (
            <button type="button" onClick={() => update(state.id, { signature: true })} className="mt-2 text-[12px] text-text-3 hover:text-text-1">
              + {t('signature.add')}
            </button>
          )}
          {/* citation */}
          {state.quoteHtml && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowQuote((v) => !v)}
                aria-label={showQuote ? t('quote.hide') : t('quote.show')}
                className="flex h-5 items-center rounded-md bg-muted px-2 text-text-3 voxel-transition hover:bg-accent hover:text-text-1"
              >
                <MoreHorizontal className="size-4" />
              </button>
              <AnimatePresence initial={false}>
                {showQuote && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tBase} className="overflow-hidden">
                    <div className="voxel-prose mt-2 max-h-72 overflow-y-auto rounded-lg border-s-2 border-line-strong ps-3 text-[13px] text-text-2" dir="auto" dangerouslySetInnerHTML={{ __html: state.quoteHtml }} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
          {/* pièces jointes */}
          {(state.attachments.filter((a) => a.disposition !== 'inline').length > 0 || uploading.length > 0) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <AnimatePresence initial={false}>
                {state.attachments
                  .filter((a) => a.disposition !== 'inline')
                  .map((a) => (
                    <motion.div
                      key={a.blobId}
                      layout
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={tFast}
                      className="group/att flex h-8 max-w-[240px] items-center gap-2 rounded-lg border border-line bg-muted/50 pe-1 ps-2.5 text-[12.5px]"
                    >
                      <FileIcon className="size-3.5 shrink-0 text-text-3" />
                      <span className="truncate text-text-1">{a.name}</span>
                      <span className="shrink-0 text-text-3">{fileSize(a.size)}</span>
                      <button
                        type="button"
                        aria-label={t('remove', { name: a.name })}
                        onClick={() => update(state.id, { attachments: state.attachments.filter((x) => x !== a) })}
                        className="flex size-6 items-center justify-center rounded text-text-3 hover:bg-accent hover:text-text-1"
                      >
                        <X className="size-3.5" />
                      </button>
                    </motion.div>
                  ))}
                {uploading.map((u) => (
                  <motion.div
                    key={u.id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="relative flex h-8 max-w-[240px] items-center gap-2 overflow-hidden rounded-lg border border-line px-2.5 text-[12.5px] text-text-2"
                  >
                    <div className="voxel-skeleton absolute inset-0 rounded-none opacity-40" />
                    <Loader2 className="relative size-3.5 animate-spin" />
                    <span className="relative truncate">{u.name}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {/* barre de mise en forme */}
      <AnimatePresence initial={false}>
        {toolbar && editorRef.current?.editor && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tFast} className="overflow-hidden px-3">
            <ToolbarSlot handle={editorRef} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* assistant d'écriture et dictée */}
      <AnimatePresence initial={false}>
        {aiWriting && (writing.run || writing.prompting) && (
          <motion.div key="ai" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tFast} className="overflow-hidden">
            <AiSuggestionPanel writing={writing} />
          </motion.div>
        )}
      </AnimatePresence>
      {aiEnabled && <DictationPill dictation={dictation} />}

      {/* pied */}
      <div className="flex shrink-0 items-center gap-1 px-3 pt-2 pb-3">
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => void send()}
            className={cn(
              'voxel-btn-primary flex h-9 items-center gap-2 pe-3.5 ps-4 text-[13.5px] font-medium active:scale-[0.98]',
              canSchedule ? 'rounded-s-lg' : 'rounded-lg',
            )}
            title={t('sendTooltip', { shortcut: `${MOD}+${t('shortcuts:keys.enter')}` })}
          >
            {sendLabel}
            <Send className="size-3.5 rtl:-scale-x-100" />
          </button>
          {canSchedule && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('schedule.options')}
                  className="voxel-btn-primary flex h-9 items-center rounded-e-lg border-s-0! px-1.5"
                >
                  <ChevronDown className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-64">
                <DropdownMenuLabel className="text-[11.5px] font-medium text-text-3">{t('schedule.title')}</DropdownMenuLabel>
                {[
                  [t('schedule.tomorrowMorning'), nextMorning(1)],
                  [t('schedule.mondayMorning'), nextMorning(0, 1)],
                ].map(([label, d]) => (
                  <DropdownMenuItem key={label as string} onSelect={() => void send(d as Date)}>
                    <Clock />
                    <span className="flex-1">{label as string}</span>
                    <span className="text-[11.5px] text-text-3">
                      {shortDateTime(d as Date)}
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <ScheduleCustom onPick={(d) => void send(d)} />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <IconButton label={t('attach')} onClick={() => fileInput.current?.click()} className="ms-1">
          <Paperclip />
        </IconButton>
        <IconButton label={t('formatting')} active={toolbar} onClick={() => setToolbar((t) => !t)}>
          <Type />
        </IconButton>
        {/* réponses types */}
        <DropdownMenu open={templatesOpen} onOpenChange={setTemplatesOpen}>
          <DropdownMenuTrigger asChild>
            <IconButton label={t('templates.insert')} shortcut={t('templates.shortcut')}>
              <FileText />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="top"
            className="max-h-80 w-64"
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              editorRef.current?.focus();
            }}
          >
            <DropdownMenuLabel className="text-[11.5px] font-medium text-text-3">{t('templates.title')}</DropdownMenuLabel>
            {templates?.length ? (
              templates.map((tpl) => (
                <DropdownMenuItem key={tpl.id} onSelect={() => insertTemplate(tpl.id)}>
                  <FileText />
                  <span className="truncate" dir="auto">
                    {tpl.name}
                  </span>
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled>{t('templates.empty')}</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openSettings('templates', account?.email)}>
              <Settings2 /> {t('templates.manage')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {aiWriting && (
          <AiComposeMenu writing={writing} state={state} open={aiMenuOpen} onOpenChange={setAiMenuOpen} onFocusEditor={() => editorRef.current?.focus()} />
        )}
        {aiEnabled && <DictationButton dictation={dictation} />}
        {/* options d'envoi : priorité, accusé de lecture, langue du correcteur */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={t('options.title')} active={!!state.requestReceipt || (!!state.priority && state.priority !== 'normal')}>
              <SlidersHorizontal />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64">
            <DropdownMenuLabel className="text-[11.5px] font-medium text-text-3">{t('options.priority')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={state.priority ?? 'normal'} onValueChange={(v) => update(state.id, { priority: v as ComposerState['priority'] })}>
              {PRIORITIES.map((p) => (
                <DropdownMenuRadioItem key={p} value={p} onSelect={(e) => e.preventDefault()}>
                  {t('options.priorities.' + p)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={!!state.requestReceipt} onCheckedChange={(v) => update(state.id, { requestReceipt: !!v })} onSelect={(e) => e.preventDefault()}>
              {t('options.receipt')}
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="flex-1">{t('options.language')}</span>
                <span className="text-[11.5px] text-text-3">{languageName(lang)}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={lang} onValueChange={(v) => update(state.id, { lang: v })}>
                  {LANGUAGES.map((l) => (
                    <DropdownMenuRadioItem key={l.code} value={l.code}>
                      <span lang={l.code}>{languageName(l.code)}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void addFiles(files);
          }}
        />
        <div className="flex-1" />
        <AnimatePresence mode="wait" initial={false}>
          {saveStatus !== 'idle' && (
            <motion.span key={saveStatus} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tFast} className="me-1 text-[11.5px] text-text-3">
              {saveStatus === 'saving' ? t('saving') : t('toasts.draftSaved')}
            </motion.span>
          )}
        </AnimatePresence>
        <IconButton label={t('discardDraft')} onClick={discard}>
          <Trash2 />
        </IconButton>
      </div>

      <AnimatePresence>
        {dragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tFast}
            className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-voxel-accent bg-panel/90 text-[13px] font-medium text-voxel-accent-strong backdrop-blur-sm"
          >
            <Upload className="size-5" />
            {t('dropFiles')}
          </motion.div>
        )}
      </AnimatePresence>
      <ComposerChromeBridge id={state.id} onClose={closeKeep} />
    </div>
  );
}

function ToolbarSlot({ handle }: { handle: React.RefObject<EditorHandle | null> }) {
  const [, force] = useState(0);
  const editor = handle.current?.editor;
  useEffect(() => {
    if (!editor) return;
    const f = () => force((n) => n + 1);
    editor.on('transaction', f);
    return () => {
      editor.off('transaction', f);
    };
  }, [editor]);
  if (!editor) return null;
  return <ToolbarLazy editor={editor} />;
}

function ScheduleCustom({ onPick }: { onPick: (d: Date) => void }) {
  const [v, setV] = useState(() => {
    const d = nextMorning(1);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  return (
    <div className="flex items-center gap-1.5 p-1.5" onKeyDown={(e) => e.stopPropagation()}>
      <input
        type="datetime-local"
        value={v}
        onChange={(e) => setV(e.target.value)}
        className="h-8 min-w-0 flex-1 rounded-md border border-line bg-panel px-2 text-[12.5px] text-text-1 outline-none focus:border-voxel-accent"
      />
      <button
        type="button"
        onClick={() => {
          const d = new Date(v);
          if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 60_000) return toast.error(i18n.t('compose:toasts.futureDate'));
          onPick(d);
        }}
        className="h-8 rounded-md bg-text-1 px-2.5 text-[12px] font-medium text-app"
      >
        {i18n.t('common:actions.ok')}
      </button>
    </div>
  );
}

/** Expose la fermeture « conserver le brouillon » à la fenêtre parente. */
const closeHandlers = new Map<string, () => void>();
function ComposerChromeBridge({ id, onClose }: { id: string; onClose: () => void }) {
  closeHandlers.set(id, onClose);
  useEffect(() => () => void closeHandlers.delete(id), [id]);
  return null;
}
export function requestCloseComposer(id: string) {
  const h = closeHandlers.get(id);
  if (h) h();
  else {
    // fenêtre réduite (non montée) : le brouillon distant est déjà à jour
    void db.drafts.delete(id).catch(() => undefined);
    useUi.getState().closeComposer(id);
  }
}

export function ComposerTitle({ state }: { state: ComposerState }) {
  useTranslation(); // re-rendu au changement de langue
  return <>{titleOf(state)}</>;
}

