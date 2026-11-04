/**
 * Petits fichiers réels pour les pièces jointes de la démo : PDF d'une page, PNG, invitation `.ics`.
 * Générés à la volée, sans dépendance.
 */
import { deflateSync } from 'node:zlib';

/** PDF 1.4 minimal valide : une page A4 avec une ligne de texte (Helvetica). */
export function pdf(line: string): Buffer {
  const safe = line.replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1');
  const stream = `BT /F1 18 Tf 72 760 Td (${safe}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** PNG RGB ; `pixel(x, y)` renvoie `[r, g, b]`. */
export function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Logo carré bicolore avec un motif (quelques centaines d'octets une fois encodé). */
export function logo(a: [number, number, number], b: [number, number, number], size = 24): Buffer {
  return png(size, size, (x, y) => ((x * 7 + y * 13) % 11 < 5 || (x > size / 3 && x < (2 * size) / 3) ? a : b));
}

export function dataUri(buf: Buffer, type = 'image/png'): string {
  return `data:${type};base64,${buf.toString('base64')}`;
}

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Invitation iCalendar courte (une heure). */
export function ics(summary: string, start: Date, organizer: string, attendee: string): Buffer {
  const end = new Date(start.getTime() + 60 * 60_000);
  return Buffer.from(
    [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Voxel//Demo//FR', 'METHOD:REQUEST', 'BEGIN:VEVENT',
      `UID:${icsDate(start)}-weekly@acme.demo`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
      `SUMMARY:${summary}`, `ORGANIZER:mailto:${organizer}`, `ATTENDEE;RSVP=TRUE:mailto:${attendee}`, 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n'),
  );
}
