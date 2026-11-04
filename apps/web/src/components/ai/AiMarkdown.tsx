import { useMemo, type MouseEvent } from 'react';
import { markdownToFragment, markdownToHtml } from '@/lib/ai/render';
import { cn } from '@/lib/utils';

export interface AiRef {
  label: string;
  title?: string;
  onOpen: () => void;
}

const REF_CLASS =
  'mx-0.5 inline-flex h-[18px] max-w-[180px] items-center truncate rounded-md bg-voxel-accent-soft px-1.5 align-[1px] text-[11px] font-medium text-voxel-accent-strong hover:bg-voxel-accent hover:text-on-accent';

/** Remplace `[#3]` / `[C3]` par une puce cliquable, nœud texte par nœud texte (aucun traitement de HTML par regex). */
function linkRefs(markdown: string, resolveRef: (ref: string) => AiRef | null): string {
  const fragment = markdownToFragment(markdown, { allowH1: true });
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const text of texts) {
    const value = text.data;
    const re = /\[(#\d+|C\d+)\]/g;
    let last = 0;
    const parts: Array<string | Node> = [];
    for (let m = re.exec(value); m; m = re.exec(value)) {
      const ref = m[1]!;
      const r = resolveRef(ref);
      if (!r) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.ref = ref;
      button.className = REF_CLASS;
      if (r.title) button.title = r.title;
      button.textContent = r.label;
      parts.push(value.slice(last, m.index), button);
      last = m.index + m[0].length;
    }
    if (!parts.length) continue;
    parts.push(value.slice(last));
    text.replaceWith(...parts);
  }
  const div = document.createElement('div');
  div.append(fragment);
  return div.innerHTML;
}

/** Markdown produit par l'IA, rendu en HTML sûr, avec les références de conversations cliquables. */
export function AiMarkdown({
  markdown,
  resolveRef,
  streaming,
  className,
}: {
  markdown: string;
  /** résout `#3` ou `C3` (sans crochets) ; `null` → laissé en texte */
  resolveRef?: (ref: string) => AiRef | null;
  streaming?: boolean;
  className?: string;
}) {
  const html = useMemo(() => {
    return resolveRef ? linkRefs(markdown, resolveRef) : markdownToHtml(markdown, { allowH1: true });
  }, [markdown, resolveRef]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ref]');
    const ref = el?.dataset.ref;
    if (!ref || !resolveRef) return;
    e.preventDefault();
    resolveRef(ref)?.onOpen();
  };

  return (
    <div
      aria-busy={streaming || undefined}
      onClick={onClick}
      className={cn(
        'voxel-prose text-[13.5px] leading-relaxed [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-[14px] [&_h2]:font-semibold [&_p]:my-2 [&_ul]:my-2',
        streaming && "[&>*:last-child]:after:ms-0.5 [&>*:last-child]:after:inline-block [&>*:last-child]:after:size-1.5 [&>*:last-child]:after:animate-pulse [&>*:last-child]:after:rounded-full [&>*:last-child]:after:bg-text-3 [&>*:last-child]:after:align-middle [&>*:last-child]:after:content-['']",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
