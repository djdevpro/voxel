/**
 * Accent lisible par mode et couleurs « vivantes » du thème.
 *
 * La couleur choisie pour une boîte (ou l'accent par défaut de la collection) peut être trop claire ou trop
 * sombre pour le thème actif. On calcule donc, pour la collection et le mode courants :
 * - `--voxel-accent`        : la couleur d'aplat (pastilles, barres, aplat du bouton principal en clair) ;
 * - `--voxel-accent-strong` : variante pour le texte et les icônes d'accent, ≥ 4,5:1 sur le panneau et le fond ;
 * - `--voxel-on-accent`     : texte posé sur un aplat d'accent (blanc ou foncé selon la luminance, ≥ 4,5:1).
 * Les valeurs sont posées en style inline sur <html> : elles l'emportent sur la collection, s'appliquent aux
 * portails (menus, dialogues) et sont recalculées à chaque changement de collection, de mode ou de boîte.
 * Met aussi à jour <meta name="theme-color"> avec la valeur réelle de `--voxel-app`.
 */
import { THEMES, type ThemeId } from './themes';

type RGB = [number, number, number];

/* ---------- conversions ---------- */

export function parseColor(input: string): RGB | null {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return [+m[1]!, +m[2]!, +m[3]!];
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  if (m) return [+m[1]! * 255, +m[2]! * 255, +m[3]! * 255];
  return null;
}

const toHex = (c: RGB) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const unlin = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function luminance(c: RGB): number {
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** sRGB → OKLCH */
function toOklch(c: RGB): [number, number, number] {
  const r = lin(c[0]);
  const g = lin(c[1]);
  const b = lin(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

/** OKLCH → sRGB (chroma réduite jusqu'à rentrer dans le gamut) */
function fromOklch(L: number, C: number, H: number): RGB {
  for (let chroma = C; ; chroma *= 0.92) {
    const A = chroma * Math.cos(H);
    const B = chroma * Math.sin(H);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005) || chroma < 0.002) return rgb.map((v) => unlin(Math.min(1, Math.max(0, v)))) as RGB;
  }
}

/**
 * Variante de `color` (même teinte) atteignant `target`:1 contre toutes les couleurs `bgs` : on éclaircit
 * (fonds sombres) ou on assombrit (fonds clairs) par pas de luminosité OKLCH. Renvoie la couleur d'origine
 * si elle convient déjà.
 */
export function readableOn(color: RGB, bgs: RGB[], target = 4.5): RGB {
  const ok = (c: RGB) => bgs.every((bg) => contrast(c, bg) >= target);
  if (ok(color)) return color;
  const darkBg = bgs.reduce((s, bg) => s + luminance(bg), 0) / bgs.length < 0.18;
  const [L0, C, H] = toOklch(color);
  for (let i = 1; i <= 60; i++) {
    const L = darkBg ? L0 + i * 0.012 : L0 - i * 0.012;
    if (L <= 0 || L >= 1) break;
    const c = fromOklch(L, C, H);
    if (ok(c)) return c;
  }
  return darkBg ? [255, 255, 255] : [0, 0, 0];
}

/** Texte à poser sur un aplat `fill` : blanc, ou un foncé teinté, selon le meilleur contraste. */
export function onColor(fill: RGB, darkInk: RGB = [17, 17, 20]): RGB {
  const white: RGB = [255, 255, 255];
  return contrast(white, fill) >= Math.min(4.5, contrast(darkInk, fill)) ? white : darkInk;
}

/* ---------- application au document ---------- */

export interface AccentVars {
  accent: string;
  strong: string;
  onAccent: string;
}

/** Calcule les trois variables d'accent pour un fond (panneau + appli) donné. */
export function computeAccent(accent: string, surfaces: { app: string; panel: string; text: string }, dark: boolean): AccentVars | null {
  const base = parseColor(accent);
  const app = parseColor(surfaces.app);
  const panel = parseColor(surfaces.panel);
  const text = parseColor(surfaces.text);
  if (!base || !app || !panel) return null;
  // Aplat : doit rester visible sur le panneau (≥ 1,6:1, sinon une pastille claire disparaît sur fond clair).
  let fill = readableOn(base, [panel], 1.6);
  // Texte et icônes d'accent : ≥ 4,5:1 sur le panneau et sur le fond (marge pour l'arrondi en hexadécimal).
  const strong = readableOn(base, [panel, app], 4.6);
  // Texte sur aplat : blanc, ou encre très foncée (le fond appli s'il est presque noir, sinon un quasi-noir neutre).
  const white: RGB = [255, 255, 255];
  const darkInk: RGB = dark && luminance(app) < 0.02 ? app : text && luminance(text) < 0.02 ? text : [17, 17, 20];
  const cW = contrast(white, fill);
  const cD = contrast(darkInk, fill);
  let ink: RGB = cW >= 4.5 || cW >= cD ? white : darkInk;
  if (contrast(ink, fill) < 4.6) {
    // ni l'un ni l'autre n'atteint 4,5:1 (teintes moyennes) : on fonce (texte blanc) ou on éclaircit (encre foncée) l'aplat
    fill = readableOn(fill, [ink], 4.6);
    if (contrast(ink, fill) < 4.5) ink = contrast(white, fill) >= contrast(darkInk, fill) ? white : darkInk;
  }
  return { accent: toHex(fill), strong: toHex(strong), onAccent: toHex(ink) };
}

let activeAccent: string | null = null;
const EVENT = 'voxel:appearance';

/** Lit la valeur résolue d'une variable de couleur (sonde hors transition : les fondus ne faussent pas la lecture). */
function resolveVar(name: string): string | null {
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;color:var(${name});transition:none !important`;
  document.body.appendChild(probe);
  const v = getComputedStyle(probe).color;
  probe.remove();
  if (!v || parseColor(v)) return v || null;
  // oklab()/color-mix() résolus : conversion par un canevas 1×1
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
  } catch {
    return null;
  }
}

function currentSurfaces(themeId: ThemeId, dark: boolean) {
  const def = THEMES.find((t) => t.id === themeId) ?? THEMES[0]!;
  const p = def.preview[dark ? 'dark' : 'light'];
  return { app: p[0], panel: p[2], text: p[3], defaultAccent: p[4] };
}

/**
 * Recalcule l'accent lisible et la couleur de barre du navigateur pour l'état courant de <html>
 * (data-theme, classe .dark) et l'accent de la boîte active.
 */
export function refreshAppearance(): void {
  if (typeof document === 'undefined' || !document.body) return;
  const root = document.documentElement;
  const dark = root.classList.contains('dark');
  const themeId = (root.dataset.theme as ThemeId | undefined) ?? 'porcelain';
  const s = currentSurfaces(themeId, dark);
  const vars = computeAccent(activeAccent ?? s.defaultAccent, s, dark);
  if (vars) {
    root.style.setProperty('--voxel-accent', vars.accent);
    root.style.setProperty('--voxel-accent-strong', vars.strong);
    root.style.setProperty('--voxel-on-accent', vars.onAccent);
  }
  const app = resolveVar('--voxel-app');
  const rgb = app ? parseColor(app) : null;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', rgb ? toHex(rgb) : s.app);
  window.dispatchEvent(new Event(EVENT));
}

/** Accent de la boîte active (`null` = accent par défaut de la collection). */
export function setActiveAccent(color: string | null | undefined): void {
  const next = color || null;
  if (next === activeAccent) return;
  activeAccent = next;
  refreshAppearance();
}

/** Abonnement aux changements d'apparence (collection, mode, accent), pour les rendus qui lisent les tokens. */
export function onAppearanceChange(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** Valeur résolue (rgb) d'un token de couleur, lue sur <html>. */
export function readToken(name: string): string {
  const v = resolveVar(name);
  const rgb = v ? parseColor(v) : null;
  return rgb ? toHex(rgb) : '';
}

/**
 * Couleur d'encre (CSS) pour des initiales en gras ou une icône posées sur un aplat `color` : blanc dès qu'il
 * atteint 3:1 (seuil WCAG du texte large et des éléments graphiques), sinon une encre foncée.
 */
export function inkOn(color: string): string {
  const rgb = parseColor(color);
  if (!rgb) return '#fff';
  return contrast([255, 255, 255], rgb) >= 3 ? '#fff' : 'rgb(17 17 20 / 0.88)';
}
