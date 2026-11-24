import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, opendir, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { addAbortSignal, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DriveError } from '../errors.ts';
import type { StorageAdapter, StoredObject } from './adapter.ts';
import { CHUNK_BYTES, DIGEST_BYTES, FRAME_OVERHEAD, HEADER, checkHeader, dataEnd, readFrame, sealFrame, writeExactly } from './format.ts';
import { missingFile, syncDirectory } from './key.ts';

export class LocalStorage implements StorageAdapter {
  readonly capabilities: StorageAdapter['capabilities'];
  readonly directory: string;
  private readonly master: Buffer;
  private readonly repairing = new Set<string>();

  constructor(directory: string, maxObjectBytes: number, master: Buffer) {
    this.directory = directory;
    this.master = master;
    this.capabilities = {
      maxObjectBytes, quota: false, rangeRead: false, resumableUpload: true,
      deletion: true, integrityVerification: true,
    };
  }

  path(key: string) {
    if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('Invalid storage object ID.');
    return join(this.directory, key);
  }

  checkSize(size: number) {
    if (size > this.capabilities.maxObjectBytes || !Number.isSafeInteger(dataEnd(size) + DIGEST_BYTES + FRAME_OVERHEAD)) {
      throw new DriveError(413, 'The file exceeds the upload limit.');
    }
  }

  async upload(key: string, source: Readable, signal?: AbortSignal): Promise<StoredObject> {
    const file = await open(this.path(key) + '.part', 'wx', 0o600);
    const hash = createHash('sha256');
    let offset = 0;
    let filled = 0;
    const block = Buffer.allocUnsafe(CHUNK_BYTES);
    try {
      await writeExactly(file, HEADER, 0);
      signal?.throwIfAborted();
      if (signal) addAbortSignal(signal, source);
      for await (const incoming of source) {
        const bytes: Buffer = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
        this.checkSize(offset + filled + bytes.length);
        for (let start = 0; start < bytes.length;) {
          const count = Math.min(CHUNK_BYTES - filled, bytes.length - start);
          bytes.copy(block, filled, start, start + count);
          start += count;
          filled += count;
          if (filled !== CHUNK_BYTES) continue;
          await this.writeFrame(file, key, offset, block);
          hash.update(block);
          offset += filled;
          filled = 0;
        }
      }
      if (filled) {
        const tail = block.subarray(0, filled);
        await this.writeFrame(file, key, offset, tail);
        hash.update(tail);
        offset += filled;
      }
      const digest = hash.digest();
      await this.writeFrame(file, key, offset, digest, true);
      await file.sync();
      signal?.throwIfAborted();
      await file.close();
      await this.publish(key);
      return { key, size: offset, sha256: digest.toString('hex'), format: 1 };
    } finally {
      source.destroy();
      await file.close();
    }
  }

  private writeFrame(file: FileHandle, key: string, offset: number, bytes: Buffer, footer = false) {
    return writeExactly(file, sealFrame(this.master, key, offset, bytes, footer), dataEnd(offset));
  }

  private async publish(key: string) {
    const path = this.path(key);
    await rename(path + '.part', path);
    await syncDirectory(this.directory);
  }

  private async openPartial(key: string, offset: number) {
    const path = this.path(key) + '.part';
    const file = await open(path, offset === 0 ? 'w+' : 'r+', 0o600);
    try {
      if (offset === 0) {
        await writeExactly(file, HEADER, 0);
      } else {
        await checkHeader(file);
        const position = dataEnd(offset);
        const { size } = await file.stat();
        if (size < position) throw new DriveError(503, 'The saved upload is incomplete. Discard it and start again.');
        if (size > position) await file.truncate(position);
      }
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async append(key: string, offset: number, bytes: Buffer) {
    const file = await this.openPartial(key, offset);
    try {
      await this.writeFrame(file, key, offset, bytes);
      await file.sync();
      if (offset === 0) await syncDirectory(this.directory);
    } finally {
      await file.close();
    }
  }

  async complete(key: string, size: number, fingerprint: string, signal?: AbortSignal): Promise<StoredObject> {
    const final = await open(this.path(key), 'r').catch((error) => {
      if (!missingFile(error)) throw error;
      return null;
    });
    const file = final ?? await this.openPartial(key, size);
    let digest: Buffer;
    try {
      const storedDigest = final && await this.readFooter(file, key, size);
      const hash = createHash('sha256');
      const parts = createHash('sha256');
      for await (const bytes of this.readChunks(file, key, size, signal)) {
        hash.update(bytes);
        parts.update(createHash('sha256').update(bytes).digest());
      }
      digest = hash.digest();
      if (parts.digest('hex') !== fingerprint) {
        throw new DriveError(422, 'The uploaded bytes differ from the selected file. Discard this upload and try again.');
      }
      if (storedDigest && !storedDigest.equals(digest)) throw new DriveError(503, 'The stored upload failed verification.');
      if (!final) {
        await this.writeFrame(file, key, size, digest, true);
        await file.sync();
      }
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    if (!final) await this.publish(key);
    else await syncDirectory(this.directory);
    return { key, size, sha256: digest.toString('hex'), format: 1 };
  }

  private async *readChunks(file: FileHandle, key: string, size: number, signal?: AbortSignal) {
    for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
      signal?.throwIfAborted();
      yield await readFrame(file, this.master, key, offset, Math.min(CHUNK_BYTES, size - offset));
    }
  }

  private async readFooter(file: FileHandle, key: string, size: number) {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== dataEnd(size) + DIGEST_BYTES + FRAME_OVERHEAD) {
      throw new DriveError(503, 'The stored file is unavailable or has an unexpected size.');
    }
    await checkHeader(file);
    return readFrame(file, this.master, key, size, DIGEST_BYTES, true);
  }

  async verify(object: StoredObject, signal?: AbortSignal) {
    return this.verifyAt(this.path(object.key), object, signal);
  }

  private async verifyAt(path: string, object: StoredObject, signal?: AbortSignal) {
    const hash = createHash('sha256');
    try {
      if (object.format === 0) {
        let size = 0;
        for await (const bytes of createReadStream(path, { signal })) {
          size += bytes.length;
          if (size > object.size) return false;
          hash.update(bytes);
        }
        if (size !== object.size) return false;
      } else {
        const file = await open(path);
        try {
          const digest = await this.readFooter(file, object.key, object.size);
          if (digest.toString('hex') !== object.sha256) return false;
          for await (const bytes of this.readChunks(file, object.key, object.size, signal)) hash.update(bytes);
        } finally {
          await file.close();
        }
      }
      signal?.throwIfAborted();
      return hash.digest('hex') === object.sha256;
    } catch (error) {
      if (error instanceof DriveError && error.status === 503) return false;
      throw error;
    }
  }

  async recoverEncrypted(object: StoredObject, source: () => Promise<Readable>, signal: AbortSignal) {
    if (object.format !== 1) throw new Error('Expected an encrypted object.');
    const path = this.path(object.key);
    if (this.repairing.has(object.key)) throw new DriveError(409, 'This file is already being recovered. Try again shortly.');
    this.repairing.add(object.key);
    const temporary = path + '.repair';
    const expected = dataEnd(object.size) + DIGEST_BYTES + FRAME_OVERHEAD;
    let received = 0;
    const limit = new Transform({ transform(bytes: Buffer, _encoding, done) {
      received += bytes.length;
      if (received > expected) done(new DriveError(503, 'The remote copy exceeded the expected size.'));
      else done(null, bytes);
    } });
    try {
      await pipeline(await source(), limit, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      if (received !== expected || !await this.verifyAt(temporary, object, signal)) {
        throw new DriveError(503, 'The remote copy failed verification.');
      }
      const file = await open(temporary, 'r+');
      try { await file.sync(); } finally { await file.close(); }
      signal.throwIfAborted();
      await rename(temporary, path);
      await syncDirectory(this.directory);
    } finally {
      try { await rm(temporary, { force: true }); } finally { this.repairing.delete(object.key); }
    }
  }

  async clearInterruptedRepairs() {
    for await (const entry of await opendir(this.directory)) {
      if (/^[a-f0-9-]{36}\.repair$/.test(entry.name) && entry.isFile()) {
        await rm(join(this.directory, entry.name), { force: true });
      }
    }
  }

  async download({ key, size, sha256, format }: StoredObject) {
    const path = this.path(key);
    const file = await open(path);
    if (format === 0) {
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== size) {
          throw new DriveError(503, 'The stored file is unavailable or has an unexpected size.');
        }
        return file.createReadStream();
      } catch (error) {
        await file.close();
        throw error;
      }
    }
    try {
      const digest = await this.readFooter(file, key, size);
      if (digest.toString('hex') !== sha256) throw new DriveError(503, 'The stored file failed verification.');
    } finally {
      await file.close();
    }
    const readChunks = this.readChunks.bind(this);
    return Readable.from((async function* () {
      const input = await open(path);
      try {
        const hash = createHash('sha256');
        let received = 0;
        for await (const bytes of readChunks(input, key, size)) {
          hash.update(bytes);
          received += bytes.length;
          if (received === size && hash.digest('hex') !== sha256) {
            throw new DriveError(503, 'The stored file failed verification.');
          }
          yield bytes;
        }
      } finally { await input.close(); }
    })(), { objectMode: false });
  }

  async delete(key: string) {
    const path = this.path(key);
    await rm(path + '.part', { force: true });
    await rm(path, { force: true });
    await syncDirectory(this.directory);
  }
}
