import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { Editor as TiptapEditor } from '@tiptap/react';
import { DOMSerializer, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { ComposerState } from '@/store/ui';
import { describeAiError } from '@/lib/ai/errors';

export interface WritingTarget {
  /** 'selection' : plage figée au lancement ; 'draft' : tout le contenu */
  kind: 'selection' | 'draft';
  from: number;
  to: number;
  /** document au lancement : la plage n'est réappliquée que s'il n'a pas changé */
  doc: ProseMirrorNode;
}

export interface WritingRun {
  label: string;
  instruction: string;
  target: WritingTarget;
  status: 'streaming' | 'done' | 'error';
  markdown: string;
  error?: string;
}

const REPLY_MAX = 6000;

let writingPrefetched = false;

/** Précharge le moteur d'écriture (ouverture du menu ✨) ; une seule fois, erreurs ignorées. */
export function prefetchAiWriting(): void {
  if (writingPrefetched) return;
  writingPrefetched = true;
  void Promise.all([import('@/lib/ai/writing'), import('@/lib/ai/markdown')]).catch(() => undefined);
}

/** Si `html` est un seul paragraphe, son contenu en ligne (sans la balise `<p>`) ; sinon null. */
function singleParagraph(html: string): string | null {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  const nodes = Array.from(tpl.content.childNodes).filter((n) => n.nodeType !== Node.TEXT_NODE || n.textContent?.trim());
  const only = nodes[0];
  return nodes.length === 1 && only instanceof HTMLParagraphElement ? only.innerHTML : null;
}

/** E-mail d'origine en Markdown (réponse ou transfert) : introduction + contenu cité, borné. */
function replyContext(state: ComposerState, htmlToMarkdown: (html: string) => string): string | undefined {
  if (!state.quoteHtml || !['reply', 'replyAll', 'forward'].includes(state.mode)) return undefined;
  const doc = new DOMParser().parseFromString(state.quoteHtml, 'text/html');
  const quote = doc.querySelector('blockquote');
  // htmlToMarkdown retire l'historique cité : on lui passe le contenu du blockquote, pas le blockquote lui-même
  const md = quote
    ? [doc.querySelector('p')?.textContent?.trim() ?? '', htmlToMarkdown(quote.innerHTML)].filter(Boolean).join('\n\n')
    : htmlToMarkdown(state.quoteHtml);
  return md.length > REPLY_MAX ? md.slice(0, REPLY_MAX) : md || undefined;
}

/** Demande d'écriture IA sur la sélection ou le brouillon : lancement, flux, application annulable. */
export function useAiWriting(opts: { editor: () => TiptapEditor | null | undefined; state: ComposerState }) {
  const { t } = useTranslation('ai-compose');
  const [run, setRun] = useState<WritingRun | null>(null);
  /** saisie d'une instruction libre en cours */
  const [prompting, setPrompting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const textRef = useRef('');
  /** remet les images du brouillon dans le HTML du modèle (voir `draftToMarkdown`) */
  const restoreRef = useRef<((md: string) => string) | null>(null);
  /** le document a changé depuis le lancement : « Remplacer » est désactivé */
  const [stale, setStale] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const runRef = useRef(run);
  runRef.current = run;

  const abort = () => {
    controller.current?.abort();
    controller.current = null;
  };

  /** `source` : texte déjà prêt (nouvel essai) ou HTML de la sélection ou du brouillon, converti une fois le moteur chargé. */
  const launch = useCallback((label: string, instruction: string, target: WritingTarget, source: { text: string; restore: (md: string) => string } | { html: string }) => {
    abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setPrompting(false);
    setRun({ label, instruction, target, status: 'streaming', markdown: '' });
    const { state } = optsRef.current;
    // moteur IA chargé à la demande
    Promise.all([import('@/lib/ai/writing'), import('@/lib/ai/markdown')])
      .then(([{ runWriting }, { htmlToMarkdown, draftToMarkdown }]) => {
        let text: string;
        if ('html' in source) {
          const draft = draftToMarkdown(source.html);
          text = draft.markdown;
          restoreRef.current = draft.restore;
        } else {
          text = source.text;
          restoreRef.current = source.restore;
        }
        textRef.current = text;
        return runWriting({
          instruction,
          text,
          replyTo: replyContext(state, htmlToMarkdown),
          accountId: state.accountId,
          signal: ctrl.signal,
          onDelta: (md) => {
            if (controller.current === ctrl) setRun((r) => (r ? { ...r, markdown: md } : r));
          },
        });
      })
      .then((md) => {
        if (controller.current !== ctrl) return;
        controller.current = null;
        setRun((r) => (r ? { ...r, markdown: md, status: 'done' } : r));
      })
      .catch((e: unknown) => {
        if (controller.current !== ctrl) return;
        controller.current = null;
        const err = describeAiError(e);
        if (err.code === 'aborted') setRun(null);
        else setRun((r) => (r ? { ...r, status: 'error', error: err.message } : r));
      });
  }, []);

  const start = useCallback(
    (label: string, instruction: string) => {
      const editor = optsRef.current.editor();
      if (!editor) return;
      const { doc, selection } = editor.state;
      const target: WritingTarget = selection.empty
        ? { kind: 'draft', from: 0, to: doc.content.size, doc }
        : { kind: 'selection', from: selection.from, to: selection.to, doc };
      let html: string;
      if (selection.empty) html = editor.getHTML();
      else {
        // la tranche choisie en HTML, pour garder liens et images
        const div = document.createElement('div');
        div.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(doc.slice(selection.from, selection.to).content));
        html = div.innerHTML;
      }
      launch(label, instruction, target, { html });
    },
    [launch],
  );

  const retry = useCallback(() => {
    const r = runRef.current;
    const restore = restoreRef.current;
    if (r && restore) launch(r.label, r.instruction, r.target, { text: textRef.current, restore });
  }, [launch]);

  const close = useCallback(() => {
    abort();
    setRun(null);
    setPrompting(false);
  }, []);

  const stop = close;

  const openPrompt = useCallback(() => {
    abort();
    setRun(null);
    setPrompting(true);
  }, []);

  const replace = useCallback(() => {
    const editor = optsRef.current.editor();
    const r = runRef.current;
    if (!editor || !r) return;
    const restore = restoreRef.current;
    // document modifié depuis le lancement : jamais de remplacement (le bouton est désactivé)
    if (!restore || !editor.state.doc.eq(r.target.doc)) return;
    const html = restore(r.markdown);
    const { from, to } = r.target;
    const doc = editor.state.doc;
    const $from = doc.resolve(from);
    const $to = doc.resolve(to);
    // sélection dans un seul bloc de texte et résultat d'un seul paragraphe : insertion en ligne
    const inline = r.target.kind === 'selection' && $from.parent.isTextblock && $from.sameParent($to) ? singleParagraph(html) : null;
    editor.chain().focus().insertContentAt({ from, to }, inline ?? html).run();
    toast(t('panel.replaced'), { action: { label: t('panel.undo'), onClick: () => editor.commands.undo() } });
    close();
  }, [close, t]);

  const insertBelow = useCallback(() => {
    const editor = optsRef.current.editor();
    const r = runRef.current;
    if (!editor || !r) return;
    const restore = restoreRef.current;
    if (!restore) return;
    const html = restore(r.markdown);
    const doc = editor.state.doc;
    if (r.target.kind === 'selection' && doc.eq(r.target.doc)) {
      // après le bloc de premier niveau qui contient la fin de la sélection
      const $to = doc.resolve(r.target.to);
      const pos = $to.depth >= 1 ? $to.after(1) : r.target.to;
      editor.chain().focus().insertContentAt(pos, html).run();
    } else {
      editor.chain().focus('end').insertContent(html).run();
    }
    close();
  }, [close]);

  const copy = useCallback(async () => {
    const r = runRef.current;
    if (!r) return;
    await navigator.clipboard.writeText(r.markdown);
    toast(t('panel.copied'));
  }, [t]);

  useEffect(() => () => controller.current?.abort(), []);

  // suit les modifications du brouillon pendant qu'un résultat est affiché
  const target = run?.target;
  useEffect(() => {
    const editor = optsRef.current.editor();
    if (!target || !editor) {
      setStale(false);
      return;
    }
    const check = () => setStale(!editor.state.doc.eq(target.doc));
    check();
    editor.on('update', check);
    return () => {
      editor.off('update', check);
    };
  }, [target]);

  return { run, prompting, stale, start, retry, stop, close, openPrompt, replace, insertBelow, copy };
}

export type AiWriting = ReturnType<typeof useAiWriting>;
