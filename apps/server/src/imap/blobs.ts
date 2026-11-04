/**
 * Blobs téléversés (pièces jointes en cours de rédaction) : fichiers temporaires sous
 * `<dossier de données>/blobs/<boîte>/` (même dossier que imap-kv.sqlite, voir paths.ts), durée de vie 24 h.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolveDataDir } from '../paths.js';
import { hashOf, randomHex } from './util.js';

const TTL_MS = 24 * 3600_000;
/** Quota par boîte : 300 blobs et 500 Mo au plus sur 24 h. */
const MAX_BLOBS = 300;
const MAX_TOTAL_BYTES = 500_000_000;

/** Blob téléversé au-delà de la taille maximale (le routeur le traduit en 413). */
export class BlobTooLargeError extends Error {
  readonly status = 413;
  constructor() {
    super('blob too large');
    this.name = 'BlobTooLargeError';
  }
}

export class BlobStore {
  readonly dir: string;
  private lastCleanup = 0;

  constructor(email: string, maxSize = 50_000_000, baseDir = resolveDataDir()) {
    const base = baseDir;
    this.dir = join(base, 'blobs', hashOf(email.toLowerCase(), 16));
    this.maxSize = maxSize;
  }
  private readonly maxSize: number;

  static isUploadId(blobId: string): boolean {
    return /^U[0-9a-f]{24}$/.test(blobId);
  }

  async put(body: ReadableStream<Uint8Array>, type: string): Promise<{ blobId: string; size: number; type: string }> {
    await mkdir(this.dir, { recursive: true });
    void this.cleanup();
    // Quota par boîte (blobs gardés 24 h) : sans lui, des téléversements répétés rempliraient le disque.
    const used = await this.usage();
    if (used.count >= MAX_BLOBS || used.bytes >= MAX_TOTAL_BYTES) throw new BlobTooLargeError();
    const blobId = `U${randomHex(12)}`;
    const file = join(this.dir, blobId);
    let size = 0;
    const max = Math.min(this.maxSize, MAX_TOTAL_BYTES - used.bytes);
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > max) cb(new BlobTooLargeError());
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream<Uint8Array>), counter, createWriteStream(file));
    } catch (e) {
      await rm(file, { force: true });
      throw e;
    }
    const t = type || 'application/octet-stream';
    await writeFile(`${file}.json`, JSON.stringify({ type: t, size, at: Date.now() }));
    return { blobId, size, type: t };
  }

  async get(blobId: string): Promise<{ data: Buffer; type: string } | null> {
    if (!BlobStore.isUploadId(blobId)) return null;
    const file = join(this.dir, blobId);
    try {
      const [data, meta] = await Promise.all([readFile(file), readFile(`${file}.json`, 'utf8').catch(() => '{}')]);
      const m = JSON.parse(meta) as { type?: string };
      return { data, type: m.type ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  /** Nombre de blobs et octets occupés (hors fichiers .json de métadonnées). */
  private async usage(): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    try {
      for (const name of await readdir(this.dir)) {
        if (!BlobStore.isUploadId(name)) continue;
        const s = await stat(join(this.dir, name)).catch(() => null);
        if (!s || Date.now() - s.mtimeMs > TTL_MS) continue;
        count += 1;
        bytes += s.size;
      }
    } catch {
      /* dossier absent */
    }
    return { count, bytes };
  }

  /** Supprime les blobs de plus de 24 h (au plus une fois par heure). */
  async cleanup(): Promise<void> {
    if (Date.now() - this.lastCleanup < 3600_000) return;
    this.lastCleanup = Date.now();
    try {
      for (const name of await readdir(this.dir)) {
        const p = join(this.dir, name);
        const s = await stat(p).catch(() => null);
        if (s && Date.now() - s.mtimeMs > TTL_MS) await rm(p, { force: true });
      }
    } catch {
      /* dossier absent */
    }
  }
}
