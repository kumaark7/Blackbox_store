import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DriveError } from '../errors.ts';
import type { StorageAdapter, StoredObject } from './adapter.ts';

export class LocalStorage implements StorageAdapter {
  readonly capabilities: StorageAdapter['capabilities'];
  readonly directory: string;

  constructor(directory: string, maxObjectBytes: number) {
    this.directory = directory;
    this.capabilities = {
      maxObjectBytes, quota: false, rangeRead: false, resumableUpload: false,
      deletion: true, integrityVerification: true,
    };
  }

  path(key: string) {
    if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('Invalid storage object ID.');
    return join(this.directory, key);
  }

  async upload(key: string, source: Readable, signal?: AbortSignal) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const finalPath = this.path(key);
    const stagedPath = finalPath + '.part';
    const hash = createHash('sha256');
    const limit = this.capabilities.maxObjectBytes;
    let size = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > limit) {
          done(new DriveError(413, 'The file exceeds the upload limit.'));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });

    await pipeline(source, meter, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }), { signal });
    const file = await open(stagedPath, 'r+');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await rename(stagedPath, finalPath);
    if (process.platform === 'linux') {
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return { key, size, sha256: hash.digest('hex') };
  }

  async verify(object: StoredObject, signal?: AbortSignal) {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(this.path(object.key), { signal })) {
      size += chunk.length;
      if (size > object.size) return false;
      hash.update(chunk);
    }
    return size === object.size && hash.digest('hex') === object.sha256;
  }

  async download(object: StoredObject) {
    const handle = await open(this.path(object.key));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== object.size) {
        throw new DriveError(503, 'The stored file is unavailable or has an unexpected size.');
      }
      return handle.createReadStream();
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async delete(key: string) {
    const path = this.path(key);
    await rm(path + '.part', { force: true });
    await rm(path, { force: true });
  }
}
