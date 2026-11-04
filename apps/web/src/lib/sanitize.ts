import DOMPurify from 'dompurify';

export interface SanitizeOptions {
  allowRemote: boolean;
  /** cid (sans chevrons) → URL locale */
  cidMap?: Record<string, string>;
}

export interface SanitizeResult {
  html: string;
  blocked: number;
}

const REMOTE = /^(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*(['"]?)(https?:)?\/\/[^)]*\1\s*\)/gi;

/** Nettoie le HTML d'un mail ; bloque les ressources distantes si demandé. */
export function sanitizeEmailHtml(raw: string, opts: SanitizeOptions): SanitizeResult {
  let blocked = 0;
  const purifier = DOMPurify();
  purifier.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) {
      let css = node.textContent.replace(/@import[^;]+;?/gi, () => {
        if (!opts.allowRemote) blocked++;
        return opts.allowRemote ? '' : '';
      });
      if (!opts.allowRemote)
        css = css.replace(CSS_REMOTE_URL, () => {
          blocked++;
          return 'none';
        });
      // évite qu'un mail ne casse la mise en page (position: fixed…)
      css = css.replace(/position\s*:\s*fixed/gi, 'position:static');
      node.textContent = css;
    }
  });
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;
    const tag = el.tagName;
    if (tag === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (href && !href.startsWith('#')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (tag === 'IMG' || tag === 'IMAGE' || tag === 'INPUT') {
      const src = el.getAttribute('src') ?? '';
      if (src.toLowerCase().startsWith('cid:')) {
        const cid = src.slice(4).replace(/^<|>$/g, '');
        const url = opts.cidMap?.[cid];
        if (url) el.setAttribute('src', url);
        else el.removeAttribute('src');
      } else if (REMOTE.test(src) && !opts.allowRemote) {
        el.setAttribute('data-voxel-src', src);
        el.removeAttribute('src');
        el.removeAttribute('srcset');
        blocked++;
        // évite les grands espaces vides : on laisse les dimensions explicites mais on masque l'icône cassée
        el.setAttribute('alt', el.getAttribute('alt') ?? '');
      }
      if (el.hasAttribute('srcset') && !opts.allowRemote) el.removeAttribute('srcset');
    }
    if (el.hasAttribute('background')) {
      const bg = el.getAttribute('background') ?? '';
      if (REMOTE.test(bg) && !opts.allowRemote) {
        el.removeAttribute('background');
        blocked++;
      }
    }
    const style = el.getAttribute('style');
    if (style) {
      let s = style.replace(/position\s*:\s*fixed/gi, 'position:static');
      if (!opts.allowRemote)
        s = s.replace(CSS_REMOTE_URL, () => {
          blocked++;
          return 'none';
        });
      el.setAttribute('style', s);
    }
  });
  const html = purifier.sanitize(raw, {
    FORCE_BODY: true,
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target', 'background', 'bgcolor', 'align', 'valign', 'border', 'cellpadding', 'cellspacing', 'width', 'height'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'frame', 'frameset', 'applet', 'audio', 'video'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'formaction'],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  }) as string;
  return { html, blocked };
}

/** Mail « simple » (texte mis en forme, sans mise en page propre) : peut suivre le thème de l'appli. */
export function isSimpleHtml(html: string): boolean {
  if (html.length > 80_000) return false;
  const body = html.replace(/^[\s\S]*?<body[^>]*>/i, '');
  return !/<table|bgcolor|background|<img|<style|<font[^>]+color|(^|[;"'\s])color\s*:/i.test(body);
}

export interface FrameTheme {
  simple: boolean;
  dark: boolean;
  /**
   * Couleurs du thème actif pour un mail « simple » (valeurs résolues des tokens : texte, liens, citations).
   * Seules des couleurs #rrggbb sont acceptées (elles sont insérées dans la feuille de style de l'iframe).
   */
  colors?: Partial<Record<'text' | 'link' | 'quote' | 'quoteLine', string>>;
}

const FRAME_FALLBACK = {
  light: { text: '#1c1917', link: '#4338ca', quote: '#57534e', quoteLine: '#e2dfda' },
  dark: { text: '#edebe8', link: '#a5b4fc', quote: '#b3ada6', quoteLine: '#3a3734' },
} as const;

/** Couleurs effectives de l'iframe : tokens du thème pour un mail simple, sinon encre neutre sur fond blanc. */
function frameColors(theme: FrameTheme) {
  const base = theme.simple && theme.dark ? FRAME_FALLBACK.dark : FRAME_FALLBACK.light;
  if (!theme.simple || !theme.colors) return base;
  const pick = (k: keyof typeof base) => {
    const v = theme.colors?.[k];
    return v && /^#[0-9a-f]{6}$/i.test(v) ? v : base[k];
  };
  return { text: pick('text'), link: pick('link'), quote: pick('quote'), quoteLine: pick('quoteLine') };
}

/** Document complet pour l'iframe sandboxé, avec CSP stricte. */
export function emailDocument(bodyHtml: string, allowRemote: boolean, theme: FrameTheme = { simple: false, dark: false }): string {
  const img = allowRemote ? "img-src 'self' data: blob: https: http:;" : "img-src 'self' data: blob:;";
  const style = allowRemote ? "style-src 'unsafe-inline' https:; font-src data: https:;" : "style-src 'unsafe-inline'; font-src data:;";
  const c = frameColors(theme);
  return `<!DOCTYPE html><html dir="auto"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${img} ${style} media-src 'none'; script-src 'none'; frame-src 'none'; form-action 'none';">
<meta name="color-scheme" content="${theme.simple && theme.dark ? 'dark' : 'light'}">
<style>
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:${theme.simple ? '0' : '18px 20px'};font-family:'Inter Variable',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:${c.text};background:${theme.simple ? 'transparent' : '#fff'};word-wrap:break-word;overflow-wrap:anywhere;overflow-x:auto;overflow-y:hidden}
p{margin:0 0 .6em}
img{max-width:100%;height:auto}
img:not([src]){display:none}
table{max-width:100%}
pre{white-space:pre-wrap}
a{color:${c.link};text-underline-offset:2px}
blockquote{margin:0;margin-inline-start:.4em;padding-inline-start:.9em;border-inline-start:2px solid ${c.quoteLine};color:${c.quote}}
hr{border:0;border-top:1px solid ${c.quoteLine};margin:1em 0}
</style></head><body dir="auto">${bodyHtml}</body></html>`;
}

/** Nettoyage pour une citation (réponse / transfert). */
export function sanitizeForQuote(raw: string): string {
  return DOMPurify.sanitize(raw, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link', 'base', 'head', 'title'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  }) as string;
}

/** Texte brut → HTML lisible avec liens cliquables et citations atténuées. */
export function plainToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .split('\n')
    .map((line) => {
      const linked = line.replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
      return /^\s*&gt;/.test(line) ? `<span class="voxel-quote">${linked}</span>` : linked;
    })
    .join('\n');
}
