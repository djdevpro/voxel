/**
 * Analyseur de flux Server-Sent Events (format text/event-stream), pur et incrémental.
 * Sert au push JMAP lu par `fetch` (un EventSource natif ne sait pas envoyer `Authorization`).
 */

export interface SseEvent {
  /** Nom de l'événement (`message` par défaut). */
  event: string;
  data: string;
  /** Dernier identifiant reçu (`id:`), s'il y en a un. */
  id?: string;
}

export interface SseParser {
  /** Ajoute un morceau de texte reçu ; renvoie les événements complets qu'il termine. */
  push(chunk: string): SseEvent[];
  /** Dernier identifiant vu (pour `Last-Event-ID`). */
  readonly lastEventId: string | undefined;
}

/** Crée un analyseur : les morceaux peuvent être coupés n'importe où (y compris au milieu d'une ligne ou d'un `\r\n`). */
export function createSseParser(): SseParser {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let lastId: string | undefined;
  let first = true;

  const line = (l: string, out: SseEvent[]) => {
    if (l === '') {
      // fin d'un événement
      if (data.length) out.push({ event: event || 'message', data: data.join('\n'), ...(lastId !== undefined ? { id: lastId } : {}) });
      event = '';
      data = [];
      return;
    }
    if (l.startsWith(':')) return; // commentaire
    const i = l.indexOf(':');
    const field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) lastId = value;
    // `retry` et champs inconnus : ignorés
  };

  return {
    push(chunk: string) {
      const out: SseEvent[] = [];
      buffer += chunk;
      if (first && buffer.length) {
        if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
        first = false;
      }
      for (;;) {
        const m = /\r\n|\r|\n/.exec(buffer);
        if (!m) break;
        // un `\r` en fin de tampon peut être suivi d'un `\n` dans le prochain morceau : on attend
        if (m[0] === '\r' && m.index === buffer.length - 1) break;
        line(buffer.slice(0, m.index), out);
        buffer = buffer.slice(m.index + m[0].length);
      }
      return out;
    },
    get lastEventId() {
      return lastId;
    },
  };
}
