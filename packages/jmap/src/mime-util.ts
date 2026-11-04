/** Petits outils MIME isomorphes (sans dépendance) pour les messages construits côté client. */

/** UTF-8 → base64. */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Base64 coupé en lignes de 76 caractères (RFC 2045). */
export function wrapBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

const PRINTABLE = /^[\x20-\x7e]*$/;

/** Mot encodé RFC 2047 si la valeur n'est pas en ASCII imprimable. */
export function encodeWord(s: string): string {
  if (PRINTABLE.test(s)) return s;
  return `=?UTF-8?B?${utf8ToBase64(s)}?=`;
}

/** Adresse pour un en-tête : `"Nom" <a@b>` (nom encodé si besoin) ou `a@b`. */
export function headerAddress(a: { name?: string | null; email: string }): string {
  if (!a.name || a.name === a.email) return a.email;
  const name = PRINTABLE.test(a.name) ? `"${a.name.replace(/(["\\])/g, '\\$1')}"` : encodeWord(a.name);
  return `${name} <${a.email}>`;
}

/** Date RFC 5322 en UTC (`Tue, 03 Nov 2026 10:00:00 +0000`). */
export function rfc5322Date(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** `<id>` : ajoute les chevrons d'un Message-ID JMAP (stocké sans). */
export function angle(id: string): string {
  return id.startsWith('<') ? id : `<${id}>`;
}
