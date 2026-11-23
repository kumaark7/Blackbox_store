import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { DriveError } from '../errors.ts';
import { lockDrive, openDatabase } from '../database/open.ts';
import type { StorageAdapter } from '../storage/adapter.ts';
import { LocalStorage } from '../storage/local.ts';
import { FileIndex } from './index.ts';
import type { Importance } from './index.ts';

type UploadOptions = { parentId: string; name: string; importance: Importance; signal?: AbortSignal };

export class Drive {
  readonly index: FileIndex;
  readonly storage: StorageAdapter;
  readonly maxConcurrentUploads: number;
  readonly lock: DatabaseSync;
  private activeUploads = 0;
  private activePurges = new Set<string>();

  constructor(index: FileIndex, storage: StorageAdapter, maxConcurrentUploads: number, lock: DatabaseSync) {
    this.index = index;
    this.storage = storage;
    this.maxConcurrentUploads = maxConcurrentUploads;
    this.lock = lock;
  }

  static async open(dataDir: string, maxUploadBytes: number, maxConcurrentUploads: number) {
    const lock = lockDrive(dataDir);
    let db: DatabaseSync | undefined;
    try {
      db = openDatabase(dataDir);
      const index = new FileIndex(db);
      const storage = new LocalStorage(join(dataDir, 'objects'), maxUploadBytes);
      for (const pending of index.pending()) {
        await storage.delete(pending.key);
        index.abandon(pending.id);
      }
      return new Drive(index, storage, maxConcurrentUploads, lock);
    } catch (error) {
      db?.close();
      lock.close();
      throw error;
    }
  }

  close() {
    try {
      this.index.db.close();
    } finally {
      this.lock.close();
    }
  }

  async upload(options: UploadOptions, getSource: () => Readable | Promise<Readable>) {
    if (this.activeUploads >= this.maxConcurrentUploads) {
      throw new DriveError(429, 'All upload slots are in use. Try again when a transfer finishes.');
    }
    options.signal?.throwIfAborted();
    const { key, id } = this.index.reserve(options.parentId, options.name, options.importance);
    this.activeUploads++;
    let committed = false;
    try {
      const source = await getSource();
      const object = await this.storage.upload(key, source, options.signal);
      if (!(await this.storage.verify(object, options.signal))) {
        throw new DriveError(502, 'The stored upload could not be verified.');
      }
      options.signal?.throwIfAborted();
      const entry = this.index.finish(id, object.size, object.sha256);
      committed = true;
      return entry;
    } finally {
      try {
        if (!committed) {
          await this.storage.delete(key);
          this.index.abandon(id);
        }
      } finally {
        this.activeUploads--;
      }
    }
  }

  async download(id: string) {
    const entry = this.index.get(id);
    if (entry.kind !== 'file' || entry.size === null || !entry.objectKey || !entry.sha256) {
      throw new DriveError(404, 'File not found.');
    }
    try {
      const stream = await this.storage.download({
        key: entry.objectKey, size: entry.size, sha256: entry.sha256,
      });
      return { name: entry.name, size: entry.size, stream };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        throw new DriveError(503, 'The stored file is unavailable.');
      }
      throw error;
    }
  }

  async purge(id: string) {
    if (this.activePurges.has(id)) throw new DriveError(409, 'Permanent deletion is already running.');
    this.index.startPurge(id);
    this.activePurges.add(id);
    try {
      for (const { key } of this.index.purgeObjects(id)) {
        await this.storage.delete(key);
      }
      this.index.finishPurge(id);
    } finally {
      this.activePurges.delete(id);
    }
  }

  async copy(id: string, parentId: string, name: string, signal?: AbortSignal) {
    const source = this.index.get(id);
    if (source.kind !== 'file' || !source.importance) throw new DriveError(400, 'Choose a file to copy.');
    return this.upload({ parentId, name, importance: source.importance, signal }, async () => {
      return (await this.download(id)).stream;
    });
  }
}
