/**
 * Format mbox (variante « mboxrd ») pour l'export et l'import de dossiers. Module pur.
 * Les messages sont manipulés en chaînes « binaires » (un caractère = un octet, latin1) pour ne pas
 * altérer les octets 8 bits : voir `bytesToBinary` et `binaryToBytes`.
 */

/** Octets → chaîne binaire (latin1). */
export function bytesToBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

/** Chaîne binaire (latin1) → octets. */
export function binaryToBytes(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Date au format `asctime` de la ligne de séparation (`Tue Nov  3 10:00:00 2026`, UTC). */
export function asctime(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/**
 * Une entrée mbox : ligne `From <expéditeur> <date>`, lignes en LF, `From ` (précédé de `>` éventuels)
 * protégé par un `>` de plus (mboxrd), puis une ligne vide.
 */
export function mboxEntry(raw: string, opts: { sender?: string | null; date?: Date } = {}): string {
  const sender = (opts.sender ?? '').replace(/\s+/g, '') || 'MAILER-DAEMON';
  const body = raw.replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1');
  return `From ${sender} ${asctime(opts.date ?? new Date())}\n${body}${body.endsWith('\n') ? '' : '\n'}\n`;
}

/**
 * Découpe incrémentale d'un mbox : `push()` des morceaux (chaînes binaires), reçoit les messages complets
 * (lignes CRLF, `>From ` déprotégé) ; `end()` rend le dernier. Une ligne `From ` n'est un séparateur qu'en
 * début de fichier ou après une ligne vide.
 */
export class MboxSplitter {
  private buf = '';
  private cur: string[] | null = null;
  private prevBlank = true;

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let start = 0;
    let nl: number;
    while ((nl = this.buf.indexOf('\n', start)) >= 0) {
      this.line(this.buf.slice(start, nl).replace(/\r$/, ''), out);
      start = nl + 1;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  end(): string[] {
    const out: string[] = [];
    if (this.buf) {
      this.line(this.buf.replace(/\r$/, ''), out);
      this.buf = '';
    }
    const last = this.finish();
    if (last) out.push(last);
    return out;
  }

  private line(line: string, out: string[]) {
    if (line.startsWith('From ') && this.prevBlank) {
      const done = this.finish();
      if (done) out.push(done);
      this.cur = [];
      this.prevBlank = false;
      return;
    }
    this.prevBlank = line === '';
    // texte avant le premier séparateur : ignoré (fichier qui n'est pas un mbox)
    if (!this.cur) return;
    this.cur.push(/^>+From /.test(line) ? line.slice(1) : line);
  }

  private finish(): string | null {
    const lines = this.cur;
    this.cur = null;
    if (!lines) return null;
    // la ligne vide de séparation n'appartient pas au message
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return null;
    return `${lines.join('\r\n')}\r\n`;
  }
}

/** Découpe d'un mbox entier (voir `MboxSplitter`). */
export function splitMbox(text: string): string[] {
  const s = new MboxSplitter();
  return [...s.push(text), ...s.end()];
}

/** Vrai si le texte commence comme un mbox (ligne `From ` initiale). */
export function looksLikeMbox(head: string): boolean {
  return /^From \S/.test(head);
}

/** Date d'un message brut (en-tête `Date`, UTC sans millisecondes), pour `receivedAt` à l'import. */
export function rawMessageDate(raw: string): string | undefined {
  const end = raw.search(/\r?\n\r?\n/);
  const head = end >= 0 ? raw.slice(0, end) : raw.slice(0, 65536);
  const m = /^Date:[ \t]*(.*(?:\r?\n[ \t].+)*)/im.exec(head);
  const d = m ? Date.parse(m[1]!.replace(/\r?\n[ \t]+/g, ' ').trim().replace(/\s*\([^)]*\)\s*$/, '')) : NaN;
  return Number.isNaN(d) ? undefined : new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

