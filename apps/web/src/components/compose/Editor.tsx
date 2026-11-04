import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { useEditor, EditorContent, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Bold, Italic, Underline, Strikethrough, List, ListOrdered, Quote, Code, Link2, RemoveFormatting, Undo2, Redo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';

export interface EditorHandle {
  getHTML: () => string;
  focus: () => void;
  isEmpty: () => boolean;
  insertImage: (src: string) => void;
  /** Insère du HTML à la position du curseur. */
  insertHtml: (html: string) => void;
  editor: TiptapEditor | null;
}

export function RichEditor({
  initialHtml,
  onChange,
  placeholder,
  onPasteFiles,
  onSubmit,
  autoFocus,
  className,
  minHeight = 140,
  handleRef,
  toolbar = true,
  ariaLabel,
  lang,
  onShortcut,
}: {
  initialHtml: string;
  onChange?: (html: string) => void;
  placeholder?: string;
  onPasteFiles?: (files: File[]) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
  className?: string;
  minHeight?: number;
  handleRef?: Ref<EditorHandle>;
  toolbar?: boolean;
  ariaLabel?: string;
  /** Langue du texte (attribut `lang`) : le correcteur orthographique natif suit cette langue. */
  lang?: string;
  /** Raccourci propre au rédacteur (ex. réponses types) : renvoie vrai s'il a été traité. */
  onShortcut?: (event: KeyboardEvent) => boolean;
}) {
  const langRef = useRef(lang);
  langRef.current = lang;
  const shortcutRef = useRef(onShortcut);
  shortcutRef.current = onShortcut;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
      }),
      Image.configure({ inline: false, allowBase64: true }),
      // fonction : relue à chaque rendu, suit donc la langue courante
      Placeholder.configure({ placeholder: () => placeholder ?? i18n.t('compose:editor.placeholder') }),
    ],
    content: initialHtml || '',
    autofocus: autoFocus ? 'start' : false,
    editorProps: {
      // correcteur orthographique natif du navigateur, dans la langue du message
      attributes: () => ({
        class: 'voxel-prose',
        'aria-label': ariaLabel ?? i18n.t('compose:editor.label'),
        role: 'textbox',
        'aria-multiline': 'true',
        dir: 'auto',
        spellcheck: 'true',
        lang: langRef.current || i18n.language || 'en',
      }),
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length && onPasteFiles) {
          onPasteFiles(files);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (files.length && onPasteFiles) {
          event.preventDefault();
          onPasteFiles(files);
          return true;
        }
        return false;
      },
      handleKeyDown: (_view, event) => {
        if (shortcutRef.current?.(event)) {
          event.preventDefault();
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          onSubmit?.();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => onChange?.(e.getHTML()),
    immediatelyRender: true,
  });

  useImperativeHandle(
    handleRef,
    () => ({
      getHTML: () => editor?.getHTML() ?? '',
      focus: () => editor?.commands.focus('end'),
      isEmpty: () => editor?.isEmpty ?? true,
      insertImage: (src: string) => editor?.chain().focus().setImage({ src }).run(),
      insertHtml: (html: string) => editor?.chain().focus().insertContent(html).run(),
      editor,
    }),
    [editor],
  );

  useEffect(() => () => editor?.destroy(), [editor]);

  // changement de langue : les attributs de l'éditeur sont recalculés par une transaction vide
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [editor, lang]);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="min-h-0 flex-1 cursor-text overflow-y-auto" onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} style={{ minHeight }} className="[&_.ProseMirror]:min-h-[inherit] [&_.ProseMirror]:outline-none" />
      </div>
      {toolbar && editor && <Toolbar editor={editor} />}
    </div>
  );
}

function Btn({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className={cn(
            'flex size-7 items-center justify-center rounded-md text-text-2 voxel-transition hover:bg-black/[0.05] hover:text-text-1 dark:hover:bg-white/[0.07] [&_svg]:size-[15px]',
            active && 'bg-black/[0.07] text-text-1 dark:bg-white/[0.1]',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="border-0 bg-text-1 px-2 py-1 text-[11.5px] text-app">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function Toolbar({ editor }: { editor: TiptapEditor }) {
  const { t } = useTranslation('compose');
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt(t('editor.linkPrompt'), prev ?? 'https://');
    if (url === null) return;
    if (!url || url === 'https://') editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };
  return (
    <div className="-mx-1 flex shrink-0 items-center gap-0.5 overflow-x-auto px-1 pt-2 [&>*]:shrink-0 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible" role="toolbar" aria-label={t('formatting')}>
      <Btn label={t('editor.bold', { mod })} active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold />
      </Btn>
      <Btn label={t('editor.italic', { mod })} active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic />
      </Btn>
      <Btn label={t('editor.underline', { mod })} active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <Underline />
      </Btn>
      <Btn label={t('editor.strike')} active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough />
      </Btn>
      <span className="mx-1 h-4 w-px bg-line" />
      <Btn label={t('editor.bulletList')} active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List />
      </Btn>
      <Btn label={t('editor.orderedList')} active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered />
      </Btn>
      <Btn label={t('editor.quote')} active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote />
      </Btn>
      <Btn label={t('editor.code')} active={editor.isActive('code') || editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code />
      </Btn>
      <Btn label={t('editor.link', { mod })} active={editor.isActive('link')} onClick={setLink}>
        <Link2 />
      </Btn>
      <Btn label={t('editor.clear')} onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
        <RemoveFormatting />
      </Btn>
      <span className="mx-1 h-4 w-px bg-line" />
      <Btn label={t('editor.undo', { mod })} onClick={() => editor.chain().focus().undo().run()}>
        <Undo2 className="rtl:-scale-x-100" />
      </Btn>
      <Btn label={t('editor.redo')} onClick={() => editor.chain().focus().redo().run()}>
        <Redo2 className="rtl:-scale-x-100" />
      </Btn>
    </div>
  );
}
