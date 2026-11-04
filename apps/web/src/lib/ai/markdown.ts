/**
 * Conversions pour l'IA : l'IA ne reçoit que du Markdown (images base64, pixels de suivi et historique cité
 * retirés, URL de suivi raccourcies, longueur bornée) ; le retour en HTML est dans `render.ts`.
 */
import TurndownService from 'turndown';
import type { Email, EmailAddress } from '@voxel/jmap';
import { bodyHtml, bodyText } from '@/lib/mail';
import { fileSize } from '@/lib/format';
import { markdownToHtml } from './render';

const REMOVED = 'script, style, head, title, meta, link, noscript, svg, iframe, object, embed, form, button, input, select, textarea';
const QUOTES = 'blockquote[type="cite"], .gmail_quote, .gmail_extra, .yahoo_quoted, .moz-cite-prefix';

/** URL de plus de 80 caractères → `https://hôte/…`. */
function shortUrl(url: string): string {
  if (url.length <= 80) return url;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return `${url.slice(0, 77)}…`;
  }
}

function cleanImages(doc: Document) {
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    const w = Number(img.getAttribute('width') ?? NaN);
    const h = Number(img.getAttribute('height') ?? NaN);
    const alt = (img.getAttribute('alt') ?? '').trim();
    const pixel = (!Number.isNaN(w) && w <= 2) || (!Number.isNaN(h) && h <= 2);
    const meaningful = alt.length > 2 && !/^(image|logo)$/i.test(alt);
    if (src.startsWith('data:') || pixel || !meaningful) img.remove();
    else img.replaceWith(doc.createTextNode(`[image: ${alt}]`));
  }
}

function removeQuotedHistory(doc: Document) {
  for (const el of Array.from(doc.querySelectorAll(QUOTES))) el.remove();
  // Outlook : l'en-tête de réponse et tout ce qui le suit
  const outlook = doc.getElementById('divRplyFwdMsg');
  if (outlook) {
    let node: Node | null = outlook;
    while (node && node !== doc.body) {
      while (node.nextSibling) node.nextSibling.remove();
      node = node.parentNode;
    }
    outlook.remove();
  }
}

let turndown: TurndownService | null = null;

function turndownService(): TurndownService {
  if (turndown) return turndown;
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '_', strongDelimiter: '**', linkStyle: 'inlined' });
  td.addRule('link', {
    filter: (node) => node.nodeName === 'A' && !!node.getAttribute('href'),
    replacement: (content, node) => {
      const text = content.trim();
      if (!text) return '';
      const href = (node as HTMLElement).getAttribute('href') ?? '';
      if (/^mailto:/i.test(href)) return text;
      const url = shortUrl(href);
      return text === href ? url : `[${text}](${url})`;
    },
  });
  turndown = td;
  return td;
}

function compact(md: string): string {
  return md
    .replace(/data:[^\s)]+/g, '')
    .replace(/[​-‍﻿­]/g, '')
    .replace(/ /g, ' ')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of Array.from(doc.querySelectorAll(REMOVED))) el.remove();
  cleanImages(doc);
  removeQuotedHistory(doc);
  return compact(turndownService().turndown(doc.body));
}

/**
 * Brouillon de l'utilisateur → Markdown, sans perte : URL intactes, chaque image remplacée par un jeton
 * `[[image-N]]`. `restore` reconvertit le Markdown du modèle en HTML et remet les images (celles dont le
 * jeton a disparu sont ajoutées à la fin).
 */
export function draftToMarkdown(html: string): { markdown: string; restore: (md: string) => string } {
  const images: string[] = [];
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '_', strongDelimiter: '**', linkStyle: 'inlined' });
  td.addRule('draftImage', {
    filter: 'img',
    replacement: (_content, node) => {
      images.push((node as HTMLElement).outerHTML);
      return `[[image-${images.length}]]`;
    },
  });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const markdown = td.turndown(doc.body).trim();

  const restore = (md: string): string => {
    const out = new DOMParser().parseFromString(markdownToHtml(md), 'text/html');
    const used = new Set<number>();
    const imageNode = (n: number): Node => {
      const tpl = out.createElement('template');
      tpl.innerHTML = images[n - 1]!;
      return tpl.content;
    };
    // jeton seul dans un paragraphe : le paragraphe entier devient l'image
    for (const p of Array.from(out.body.querySelectorAll('p'))) {
      const m = /^\[\[image-(\d+)\]\]$/.exec(p.textContent?.trim() ?? '');
      const n = m ? Number(m[1]) : 0;
      if (n >= 1 && n <= images.length && !used.has(n)) {
        used.add(n);
        p.replaceWith(imageNode(n));
      }
    }
    // jetons en ligne
    const walker = out.createTreeWalker(out.body, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const text of texts) {
      const value = text.data;
      const re = /\[\[image-(\d+)\]\]/g;
      if (!re.test(value)) continue;
      re.lastIndex = 0;
      const frag = out.createDocumentFragment();
      let last = 0;
      for (let m = re.exec(value); m; m = re.exec(value)) {
        const n = Number(m[1]);
        if (n < 1 || n > images.length || used.has(n)) continue;
        used.add(n);
        frag.append(value.slice(last, m.index), imageNode(n));
        last = m.index + m[0].length;
      }
      frag.append(value.slice(last));
      text.replaceWith(frag);
    }
    // aucune image perdue
    images.forEach((_img, i) => {
      if (!used.has(i + 1)) out.body.append(imageNode(i + 1));
    });
    return out.body.innerHTML;
  };

  return { markdown, restore };
}

const QUOTE_INTRO = /^(On\b.*wrote:|Le\b.*a écrit\s*:)\s*$/i;

export function textToMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('>')) {
      // retire la ligne d'introduction de la citation (sur une ou deux lignes)
      while (out.length && !out[out.length - 1]!.trim()) out.pop();
      const last = out[out.length - 1]?.trim() ?? '';
      const prev = out[out.length - 2]?.trim() ?? '';
      if (QUOTE_INTRO.test(last)) out.pop();
      else if (QUOTE_INTRO.test(`${prev} ${last}`)) out.splice(-2, 2);
      continue;
    }
    out.push(line);
  }
  return compact(out.join('\n'));
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd()} … [truncated]`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** AAAA-MM-JJ HH:MM, heure locale. */
export function localDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** « Nom <adresse> » ou l'adresse seule. */
export function formatAddress(a: EmailAddress): string {
  return a.name?.trim() ? `${a.name.trim()} <${a.email}>` : a.email;
}

const addresses = (list: EmailAddress[] | null | undefined) => (list ?? []).map(formatAddress).join(', ');

/** E-mail en Markdown pour l'IA : en-têtes (option), corps HTML (sinon texte), pièces jointes, tronqué à `maxChars` (défaut 4000). */
export function emailToMarkdown(e: Email, opts?: { maxChars?: number; headers?: boolean }): string {
  const html = bodyHtml(e);
  const body = truncateText(html ? htmlToMarkdown(html) : textToMarkdown(bodyText(e)), opts?.maxChars ?? 4000);
  if (opts?.headers === false) return body;
  const lines = [`From: ${addresses(e.from)}`, `To: ${addresses(e.to)}`];
  if (e.cc?.length) lines.push(`Cc: ${addresses(e.cc)}`);
  lines.push(`Date: ${localDateTime(e.receivedAt)}`, `Subject: ${e.subject ?? ''}`);
  const files = (e.attachments ?? []).filter((a) => a.name);
  if (files.length) lines.push(`Attachments: ${files.map((a) => `${a.name} (${fileSize(a.size)})`).join(', ')}`);
  return `${lines.join('\n')}\n\n${body}`;
}
