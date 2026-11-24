import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { addAbortSignal } from 'node:stream';
import type { Readable } from 'node:stream';
import type { CloudProvider, StoredObject } from '../storage/adapter.ts';
import { CloudReplicas } from '../storage/cloud-replicas.ts';
import { DriveError, TeraboxCleanupRequired } from '../errors.ts';
import { lockDrive, openDatabase } from '../database/open.ts';
import { CHUNK_BYTES } from '../storage/format.ts';
import { GoogleDriveStorage } from '../storage/google-drive.ts';
import { bindGoogleDrive, readGoogleCredentials } from '../storage/google-drive-credentials.ts';
import { loadStorageKey, missingFile } from '../storage/key.ts';
import { LocalStorage } from '../storage/local.ts';
import { openMega } from '../storage/mega-rclone.ts';
import type { MegaConfig } from '../storage/mega-rclone.ts';
import { managedMega, readMegaCredentials } from '../storage/mega-credentials.ts';
import { readTeraboxAuth } from '../storage/terabox-auth.ts';
import { TeraboxStorage } from '../storage/terabox.ts';
import { openTelegram } from '../storage/telegram-credentials.ts';
import { FileIndex, validateName } from './index.ts';
import type { Importance } from './index.ts';

type UploadOptions = { parentId: string; name: string; importance: Importance; signal?: AbortSignal };
type TransferOptions = Omit<UploadOptions, 'signal'> & { size: number; fingerprint: string };
type Transfer = TransferOptions & { id: string; key: string; received: number; state: 'pending' | 'ready' | 'trash' };
const transfers = `SELECT nodes.id, parent_id AS parentId, name, importance, state, object_key AS key,
  total_bytes AS size, received_bytes AS received, fingerprint FROM transfers JOIN nodes ON nodes.id = node_id`;

function transferStatus({ id, parentId, name, importance, size, received, state }: Transfer) {
  return { id, parentId, name, importance, size, received, completed: state === 'ready' };
}

export class Drive {
  readonly index: FileIndex;
  readonly storage: LocalStorage;
  readonly maxConcurrentUploads: number;
  readonly lock: DatabaseSync;
  readonly googleDrive: CloudReplicas;
  readonly mega: CloudReplicas;
  readonly terabox: CloudReplicas;
  readonly telegram: CloudReplicas;
  private activeUploads = 0;
  private activePurges = new Set<string>();
  private activeTransfers = new Set<string>();

  constructor(index: FileIndex, storage: LocalStorage, maxConcurrentUploads: number, lock: DatabaseSync,
    googleDrive: CloudReplicas, mega: CloudReplicas, terabox: CloudReplicas, telegram: CloudReplicas) {
    this.index = index;
    this.storage = storage;
    this.maxConcurrentUploads = maxConcurrentUploads;
    this.lock = lock;
    this.googleDrive = googleDrive;
    this.mega = mega;
    this.terabox = terabox;
    this.telegram = telegram;
  }

  static async open(dataDir: string, maxUploadBytes: number, maxConcurrentUploads: number,
    options: { googleProvider?: GoogleDriveStorage; mega?: MegaConfig; megaProvider?: CloudProvider;
      megaExecutable?: string; telegramClientDir?: string; telegramProvider?: CloudProvider } = {}) {
    const lock = lockDrive(dataDir);
    let db: DatabaseSync | undefined;
    try {
      db = openDatabase(dataDir);
      const index = new FileIndex(db);
      const objects = join(dataDir, 'objects');
      await mkdir(objects, { recursive: true, mode: 0o700 });
      const master = await loadStorageKey(dataDir, db);
      const storage = new LocalStorage(objects, maxUploadBytes, master);
      await storage.clearInterruptedRepairs();
      let provider = options.googleProvider ?? null;
      try {
        if (!provider) {
          const credentials = await readGoogleCredentials(dataDir, master);
          if (credentials) provider = new GoogleDriveStorage(credentials);
        }
        if (provider) bindGoogleDrive(db, provider.binding);
      } catch {
        provider = null;
      }
      const interrupted = db.prepare(`SELECT id, object_key AS key FROM nodes
        WHERE state = 'pending' AND id NOT IN (SELECT node_id FROM transfers)`).all() as { id: string; key: string }[];
      for (const pending of interrupted) {
        await storage.delete(pending.key);
        index.abandon(pending.id);
      }
      const terabox = await readTeraboxAuth(db, dataDir, master)
        .then((auth) => auth ? new TeraboxStorage(auth) : null).catch(() => null);
      const telegram = options.telegramProvider ?? await openTelegram(db, dataDir, master, options.telegramClientDir).catch(() => null);
      const savedMega = await readMegaCredentials(dataDir, master).catch(() => null);
      const mega = savedMega ? managedMega(savedMega, options.megaExecutable ?? options.mega?.executable ?? 'rclone') : options.mega;
      return new Drive(index, storage, maxConcurrentUploads, lock, new CloudReplicas(db, storage, 'google_drive', provider),
        new CloudReplicas(db, storage, 'mega', options.megaProvider ?? openMega(db, mega)),
        new CloudReplicas(db, storage, 'terabox', terabox), new CloudReplicas(db, storage, 'telegram', telegram));
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

  replaceCloudConnection(replica: CloudReplicas, install: () => Promise<CloudProvider>) {
    if (this.activePurges.size) throw new DriveError(409, 'Wait for permanent deletion to finish before reconnecting.');
    return replica.replaceConnection(install);
  }

  async upload(options: UploadOptions, getSource: () => Readable | Promise<Readable>) {
    this.checkUploadSlot();
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
      const entry = this.index.finish(id, object.size, object.sha256, object.format);
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

  private checkUploadSlot() {
    if (this.activeUploads >= this.maxConcurrentUploads) {
      throw new DriveError(429, 'All upload slots are in use. Try again when a transfer finishes.');
    }
  }

  listTransfers() {
    const rows = this.index.db.prepare(`${transfers} WHERE state = 'pending' ORDER BY nodes.created_at`).all() as Transfer[];
    return rows.map(transferStatus);
  }

  startTransfer(options: TransferOptions) {
    this.storage.checkSize(options.size);
    const name = validateName(options.name);
    const db = this.index.db;
    const existing = db.prepare(`${transfers} WHERE parent_id = ? AND name = ? AND state = 'pending'`)
      .get(options.parentId, name) as Transfer | undefined;
    if (existing) {
      if (existing.size === options.size && existing.importance === options.importance
        && existing.fingerprint === options.fingerprint) return transferStatus(existing);
      throw new DriveError(409, 'A different upload has this name. Discard the pending upload or choose the original file and importance.');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const reserved = this.index.reserve(options.parentId, name, options.importance);
      db.prepare('INSERT INTO transfers (node_id, total_bytes, fingerprint) VALUES (?, ?, ?)')
        .run(reserved.id, options.size, options.fingerprint);
      db.exec('COMMIT');
      return transferStatus({ ...options, ...reserved, name, received: 0, state: 'pending' });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private getTransfer(id: string) {
    const transfer = this.index.db.prepare(`${transfers} WHERE nodes.id = ?`).get(id) as Transfer | undefined;
    if (!transfer || transfer.state === 'trash') throw new DriveError(404, 'Upload not found.');
    if (transfer.state === 'ready') this.index.get(id);
    return transfer;
  }

  transferStatus(id: string) {
    return transferStatus(this.getTransfer(id));
  }

  private async transferOperation<T>(id: string, work: (transfer: Transfer) => Promise<T>) {
    if (this.activeTransfers.has(id)) throw new DriveError(409, 'This upload is already being updated.');
    const transfer = this.getTransfer(id);
    this.checkUploadSlot();
    this.activeTransfers.add(id);
    this.activeUploads++;
    try {
      return await work(transfer);
    } catch (error) {
      if (missingFile(error)) throw new DriveError(503, 'The saved upload is unavailable. Discard it and start again.');
      throw error;
    } finally {
      this.activeTransfers.delete(id);
      this.activeUploads--;
    }
  }

  appendTransfer(id: string, offset: number, source: () => Readable, signal: AbortSignal) {
    return this.transferOperation(id, async (transfer) => {
      if (transfer.state !== 'pending' || offset !== transfer.received || offset >= transfer.size) {
        throw new DriveError(409, 'The upload offset has changed. Check the saved progress and retry.');
      }
      const length = Math.min(CHUNK_BYTES, transfer.size - offset);
      const bytes = Buffer.allocUnsafe(length);
      let received = 0;
      signal.throwIfAborted();
      for await (const incoming of addAbortSignal(signal, source())) {
        signal.throwIfAborted();
        const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
        if (received + chunk.length > length) throw new DriveError(413, 'The upload chunk is too large.');
        received += chunk.copy(bytes, received);
      }
      signal.throwIfAborted();
      if (received !== length) throw new DriveError(400, 'The upload chunk is incomplete.');
      await this.storage.append(transfer.key, offset, bytes);
      this.index.db.prepare('UPDATE transfers SET received_bytes = ? WHERE node_id = ?').run(offset + length, id);
      return transferStatus({ ...transfer, received: offset + length });
    });
  }

  finishTransfer(id: string, signal?: AbortSignal) {
    return this.transferOperation(id, async (transfer) => {
      if (transfer.state === 'ready') return transferStatus(transfer);
      if (transfer.received !== transfer.size) throw new DriveError(409, 'The upload still has missing chunks.');
      signal?.throwIfAborted();
      const object = await this.storage.complete(transfer.key, transfer.size, transfer.fingerprint, signal);
      this.index.finish(id, object.size, object.sha256, object.format);
      return transferStatus({ ...transfer, state: 'ready' });
    });
  }

  discardTransfer(id: string) {
    return this.transferOperation(id, async (transfer) => {
      if (transfer.state !== 'pending') throw new DriveError(409, 'This upload is already complete.');
      await this.storage.delete(transfer.key);
      this.index.abandon(id);
    });
  }

  async download(id: string) {
    const entry = this.index.get(id);
    if (entry.kind !== 'file' || entry.size === null || !entry.objectKey || !entry.sha256) {
      throw new DriveError(404, 'File not found.');
    }
    try {
      const stream = await this.openStoredFile(id, {
        key: entry.objectKey, size: entry.size, sha256: entry.sha256, format: entry.storageFormat,
      });
      return { name: entry.name, size: entry.size, stream };
    } catch (error) {
      if (missingFile(error)) {
        throw new DriveError(503, 'The stored file is unavailable.');
      }
      throw error;
    }
  }

  private async openStoredFile(id: string, object: StoredObject) {
    let failure: unknown;
    for (const replica of [this.googleDrive, this.mega, this.terabox, this.telegram]) {
      try {
        const stream = await replica.download(id, object);
        if (stream) return stream;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    return this.storage.download(object);
  }

  async purge(id: string, teraboxConfirmation?: string) {
    if (this.activePurges.has(id)) throw new DriveError(409, 'Permanent deletion is already running.');
    const objects = this.index.purgeObjects(id);
    const ids = objects.map((entry) => entry.id);
    this.googleDrive.ensureNotBusy(ids);
    this.mega.ensureNotBusy(ids);
    this.terabox.ensureNotBusy(ids);
    this.telegram.ensureNotBusy(ids);
    this.index.startPurge(id);
    this.activePurges.add(id);
    try {
      const paths: string[] = [];
      let moved = false;
      for (const object of objects) {
        const result = await this.terabox.delete(object.id);
        if (result) {
          paths.push(result.path);
          moved ||= result.moved;
        }
      }
      if (paths.length) {
        const confirmation = createHash('sha256').update(JSON.stringify([id, paths.sort()])).digest('hex');
        if (moved || confirmation !== teraboxConfirmation) throw new TeraboxCleanupRequired(paths, confirmation);
      }
      for (const object of objects) {
        await this.googleDrive.delete(object.id);
        await this.mega.delete(object.id);
        await this.telegram.delete(object.id);
        await this.storage.delete(object.key);
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
