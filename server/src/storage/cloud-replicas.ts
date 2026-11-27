import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { DriveError } from '../errors.ts';
import type { Ciphertext, CloudProvider, StoredObject } from './adapter.ts';
import { DIGEST_BYTES, FRAME_OVERHEAD, dataEnd } from './format.ts';
import { missingFile } from './key.ts';
import type { LocalStorage } from './local.ts';
import type { AccountQuota } from './quota.ts';

const pollMs = 5_000;
const auditMs = 24 * 60 * 60_000;
const retryMax = 15 * 60_000;

type Replica = { remoteId: string | null; checksum: string | null; confirmedAt: number | null; failures: number | null };
type Job = StoredObject & Replica & { id: string };

const purgeTree = `WITH RECURSIVE deleting(id) AS (
  SELECT node_id FROM trash_purges
  UNION SELECT nodes.id FROM nodes JOIN deleting ON nodes.parent_id = deleting.id
)`;
const replicaColumns = 'remote_id AS remoteId, checksum, confirmed_at AS confirmedAt, failures';
const encryptedSize = (size: number) => dataEnd(size) + DIGEST_BYTES + FRAME_OVERHEAD;

const providers = {
  google_drive: { name: 'Google Drive', importance: 'highly-important', auditInterval: auditMs },
  mega: { name: 'MEGA', importance: 'important', auditInterval: null },
  terabox: { name: 'TeraBox', importance: 'backup', auditInterval: null },
  telegram: { name: 'Telegram', importance: 'backup', auditInterval: null },
} as const;

export class CloudReplicas {
  private readonly db: DatabaseSync;
  private readonly local: LocalStorage;
  private provider: CloudProvider | null;
  private connecting = false;
  private readonly table: string;
  private readonly accountTable: string;
  private readonly settings: (typeof providers)[keyof typeof providers];
  private readonly busy = new Set<string>();
  private readonly shutdown = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<boolean>;
  private quotaCache?: { until: number; value: AccountQuota | null };
  private quotaRequest?: Promise<AccountQuota | null>;

  constructor(db: DatabaseSync, local: LocalStorage, kind: keyof typeof providers, provider: CloudProvider | null) {
    this.db = db;
    this.local = local;
    this.provider = provider;
    this.table = kind + '_replicas';
    this.accountTable = kind + '_account';
    this.settings = providers[kind];
  }

  status() {
    const expected = Boolean(this.db.prepare(`SELECT 1 FROM ${this.accountTable}`).get());
    if (!this.provider) return expected ? 'reconnect' : 'off';
    return this.db.prepare(`SELECT 1 FROM ${this.table} WHERE failures > 0 LIMIT 1`).get() ? 'retrying' : 'connected';
  }

  available() {
    return Boolean(this.provider && !this.connecting && !this.shutdown.signal.aborted);
  }

  async storePending(id: string, object: StoredObject, requestSignal?: AbortSignal) {
    const provider = this.provider;
    if (!provider || !this.available()) throw new DriveError(409, 'Connect ' + this.settings.name + ' in Account connections first.');
    this.ensureNotBusy([id]);
    const signal = requestSignal ? AbortSignal.any([this.shutdown.signal, requestSignal]) : this.shutdown.signal;
    this.db.prepare(`INSERT OR IGNORE INTO ${this.table} (node_id) VALUES (?)`).run(id);
    const job = { ...object, ...this.getReplica(id)!, id };
    this.busy.add(id);
    try {
      await this.copyToCloud(provider, job, signal);
      this.db.prepare(`UPDATE ${this.table} SET verified = 1, failures = 0, confirmed_at = ?, retry_at = ? WHERE node_id = ?`)
        .run(Date.now(), Number.MAX_SAFE_INTEGER, id);
      this.quotaCache = undefined;
    } catch (error) {
      if (signal.aborted || error instanceof DriveError) throw error;
      throw new DriveError(503, 'Could not save the file to ' + this.settings.name + '. Check the account connection and available storage.');
    } finally {
      this.busy.delete(id);
    }
  }

  trackedUsage() {
    const rows = this.db.prepare(`SELECT size FROM ${this.table} JOIN nodes ON nodes.id = node_id
      WHERE verified = 1 AND nodes.storage_format = 1`).iterate() as Iterable<{ size: number }>;
    let bytes = 0;
    let files = 0;
    for (const { size } of rows) {
      bytes += encryptedSize(size);
      files++;
    }
    return { bytes, files };
  }

  accountQuota() {
    const provider = this.provider;
    if (!provider?.quota || this.connecting || this.shutdown.signal.aborted) return Promise.resolve(null);
    if (this.quotaCache && this.quotaCache.until > Date.now()) return Promise.resolve(this.quotaCache.value);
    if (!this.quotaRequest) {
      const done = new AbortController();
      const signal = AbortSignal.any([done.signal, this.shutdown.signal]);
      const timeout = delay(8_000, null, { signal, ref: false }).catch(() => null);
      this.quotaRequest = Promise.race([provider.quota(signal).catch(() => null), timeout]).then((value) => {
        this.quotaCache = { value, until: Date.now() + (value ? 60_000 : 15_000) };
        return value;
      }).finally(() => {
        done.abort();
        this.quotaRequest = undefined;
      });
    }
    return this.quotaRequest;
  }

  start() {
    if (!this.provider || this.timer) return;
    const poll = () => {
      if (this.running) return;
      this.running = this.replicateNext().catch(() => false).finally(() => { this.running = undefined; });
    };
    this.timer = setInterval(poll, pollMs);
    this.timer.unref();
    poll();
  }

  async stop() {
    clearInterval(this.timer);
    this.shutdown.abort();
    try { await this.running; } finally { await this.provider?.close?.(); }
  }

  async replaceConnection(install: () => Promise<CloudProvider | null>) {
    if (this.connecting || this.busy.size || this.shutdown.signal.aborted) {
      throw new DriveError(409, 'Wait for the current storage operation to finish before changing the connection.');
    }
    this.connecting = true;
    try {
      await this.quotaRequest;
      const replacement = await install();
      const previous = this.provider;
      this.provider = replacement;
      this.quotaCache = undefined;
      if (!replacement) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      await previous?.close?.().catch(() => undefined);
    } finally {
      this.connecting = false;
      if (!this.shutdown.signal.aborted) this.start();
    }
  }

  private getReplica(id: string) {
    return this.db.prepare(`SELECT ${replicaColumns} FROM ${this.table} WHERE node_id = ?`).get(id) as Replica | undefined;
  }

  async replicateNext(now = Date.now()) {
    const provider = this.provider;
    if (!provider || this.connecting || this.shutdown.signal.aborted || this.busy.size > 0) return false;
    const job = this.db.prepare(`${purgeTree}
      SELECT nodes.id, object_key AS key, size, sha256, storage_format AS format, ${replicaColumns}
      FROM nodes LEFT JOIN ${this.table} ON node_id = nodes.id
      WHERE storage_format = 1 AND state != 'pending' AND cloud_only = 0
        AND (importance = ? OR remote_id IS NOT NULL)
        AND (retry_at IS NULL OR retry_at <= ?)
        AND nodes.id NOT IN (SELECT id FROM deleting)
      ORDER BY coalesce(retry_at, 0), nodes.updated_at, nodes.id LIMIT 1`).get(this.settings.importance, now) as Job | undefined;
    if (!job) return false;
    const signal = this.shutdown.signal;
    this.db.prepare(`INSERT OR IGNORE INTO ${this.table} (node_id) VALUES (?)`).run(job.id);
    this.busy.add(job.id);
    try {
      await this.copyToCloud(provider, job, signal);
      const completedAt = Math.max(now, Date.now());
      const next = this.settings.auditInterval ? completedAt + this.settings.auditInterval : Number.MAX_SAFE_INTEGER;
      this.db.prepare(`UPDATE ${this.table} SET verified = 1, failures = 0,
        confirmed_at = ?, retry_at = ? WHERE node_id = ?`).run(completedAt, next, job.id);
    } catch {
      if (!signal.aborted) {
        const attempts = Math.min((job.failures ?? 0) + 1, 32);
        const wait = Math.min(retryMax, 5_000 * 2 ** attempts);
        this.db.prepare(`UPDATE ${this.table} SET verified = 0, failures = ?, retry_at = ? WHERE node_id = ?`)
          .run(attempts, Math.max(now, Date.now()) + wait, job.id);
      }
    } finally {
      this.busy.delete(job.id);
    }
    return true;
  }

  private async copyToCloud(provider: CloudProvider, job: Job, signal: AbortSignal) {
    let id = job.remoteId;
    const bytes = encryptedSize(job.size);
    if (id && job.checksum) {
      if (await provider.verify(id, { key: job.key, bytes, checksum: job.checksum }, signal)) return;
      if (job.confirmedAt !== null) id = null;
    }
    if (!await this.local.verify(job, signal)) throw new DriveError(503, 'The local copy failed verification.');
    const path = this.local.path(job.key);
    const hash = createHash('sha256');
    let sourceSize = 0;
    for await (const chunk of createReadStream(path, { signal })) {
      sourceSize += chunk.length;
      if (sourceSize > bytes) throw new DriveError(503, 'The local copy has an unexpected size.');
      hash.update(chunk);
    }
    if (sourceSize !== bytes) throw new DriveError(503, 'The local copy has an unexpected size.');
    const object: Ciphertext = { key: job.key, bytes, checksum: hash.digest('hex') };
    id ??= await provider.allocate(signal, job.key);
    this.db.prepare(`UPDATE ${this.table} SET remote_id = ?, checksum = ?, confirmed_at = NULL,
      verified = 0 WHERE node_id = ?`).run(id, object.checksum, job.id);
    await provider.upload(id, object, path, signal);
    if (!await provider.verify(id, object, signal)) throw new DriveError(503, this.settings.name + ' has not verified the copy yet.');
  }

  ensureNotBusy(ids: string[]) {
    if (this.connecting) throw new DriveError(409, 'Wait for the account connection to finish.');
    if (ids.some((id) => this.busy.has(id))) throw new DriveError(409, 'Wait for the ' + this.settings.name + ' operation to finish, then try again.');
  }

  async delete(id: string, signal = this.shutdown.signal) {
    const replica = this.getReplica(id);
    if (!replica?.remoteId) return;
    if (!this.provider) throw new DriveError(503, 'Reconnect the original ' + this.settings.name + ' before finishing permanent deletion.');
    return this.provider.delete(replica.remoteId, signal);
  }

  async download(id: string, object: StoredObject, cloudOnly = false) {
    const replica = this.getReplica(id);
    const provider = this.provider;
    if (!provider || this.connecting || !replica?.remoteId || !replica.confirmedAt) return null;
    const remoteId = replica.remoteId;
    const signal = this.shutdown.signal;
    try {
      if (cloudOnly) {
        const source = await provider.download(remoteId, signal, encryptedSize(object.size));
        return this.local.decodeCloudObject(object, source);
      }
      const valid = await this.local.verify(object, signal).catch((error) => {
        if (missingFile(error)) return false;
        throw error;
      });
      if (!valid) await this.repair(id, object, () => this.provider!.download(remoteId, signal, encryptedSize(object.size)), signal);
      return await this.local.download(object);
    } catch (error) {
      if (error instanceof DriveError) throw error;
      throw new DriveError(503, 'The stored file is unavailable.');
    }
  }

  private async repair(id: string, object: StoredObject, source: () => Promise<Readable>, signal: AbortSignal) {
    this.ensureNotBusy([id]);
    if (this.db.prepare(`${purgeTree} SELECT 1 FROM deleting WHERE id = ?`).get(id)) {
      throw new DriveError(404, 'File not found.');
    }
    this.busy.add(id);
    try { await this.local.recoverEncrypted(object, source, signal); } finally { this.busy.delete(id); }
  }
}
