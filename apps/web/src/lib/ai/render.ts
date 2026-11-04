/** Markdown produit par l'IA → HTML sûr (module léger, sans turndown). */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

const ALLOWED_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'h2', 'h3', 'hr'];

function linkTarget(node: Element) {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
}

/**
 * Markdown produit par l'IA → HTML sûr pour l'éditeur (marked, gfm, breaks) puis DOMPurify.
 * Les `# ` deviennent `h2`, sauf avec `allowH1` (affichage dans l'appli, `AiMarkdown`).
 */
export function markdownToHtml(md: string, opts?: { allowH1?: boolean }): string {
  return sanitize(md, opts, false);
}

/** Comme `markdownToHtml`, mais renvoie le fragment DOM assaini (pour un traitement nœud par nœud). */
export function markdownToFragment(md: string, opts?: { allowH1?: boolean }): DocumentFragment {
  return sanitize(md, opts, true);
}

function sanitize(md: string, opts: { allowH1?: boolean } | undefined, fragment: false): string;
function sanitize(md: string, opts: { allowH1?: boolean } | undefined, fragment: true): DocumentFragment;
function sanitize(md: string, opts: { allowH1?: boolean } | undefined, fragment: boolean): string | DocumentFragment {
  let html = marked.parse(md, { async: false, gfm: true, breaks: true });
  if (!opts?.allowH1) html = html.replace(/<(\/?)h1\b/gi, '<$1h2');
  const config = { ALLOWED_TAGS: opts?.allowH1 ? [...ALLOWED_TAGS, 'h1'] : ALLOWED_TAGS, ALLOWED_ATTR: ['href'] };
  DOMPurify.addHook('afterSanitizeAttributes', linkTarget);
  try {
    return fragment ? DOMPurify.sanitize(html, { ...config, RETURN_DOM_FRAGMENT: true }) : DOMPurify.sanitize(html, config);
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', linkTarget);
  }
}
