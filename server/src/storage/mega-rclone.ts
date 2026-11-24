import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { DriveError } from '../errors.ts';
import type { Ciphertext, CloudProvider } from './adapter.ts';
import { reportedQuota } from './quota.ts';
import { rcloneControl, rcloneUnavailable } from './rclone-rc.ts';
import type { RcloneControl } from './rclone-rc.ts';

export const megaRemotePattern = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/;
const objectId = /^[a-f0-9-]{36}$/;
const markerFile = '.blackbox-store-id';
const stagedFile = 'encrypted-object';
const localFs = (dir: string) => dir.replaceAll('\\', '/');
export type MegaConfig = { remote: string; executable: string; configPath?: string; configEnv?: NodeJS.ProcessEnv };

function bindingRow(db: DatabaseSync) {
  return db.prepare('SELECT binding, connected FROM mega_account WHERE id = 1').get() as
    { binding: string; connected: number } | undefined;
}

export async function connectMega(db: DatabaseSync, config: MegaConfig,
  control = rcloneControl(config.executable, config.configPath, config.configEnv), outer?: AbortSignal) {
  const timeout = AbortSignal.timeout(120_000);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  const name = config.remote.split(':')[0];
  try {
    if (!config.configEnv) {
      const settings = await control.call('config/get', { name }, signal) as { type?: string };
      if (settings?.type !== 'mega') throw new Error('Choose an rclone remote with the MEGA backend.');
    }
    const state = bindingRow(db);
    if (!state?.connected) await control.call('operations/mkdir', { fs: config.remote, remote: '' }, signal);
    const marker = await statFile(control, config.remote, markerFile, signal);
    if (marker) {
      if (!state || !await matchesMarker(control, config.remote, state.binding, signal)) {
        throw new Error('Choose the original MEGA folder or a new, dedicated folder.');
      }
    } else {
      if (state?.connected) throw new Error('Reconnect the original MEGA folder before continuing.');
      const binding = state?.binding ?? randomUUID();
      db.prepare('INSERT OR IGNORE INTO mega_account (id, binding) VALUES (1, ?)').run(binding);
      const directory = await mkdtemp(join(tmpdir(), 'blackbox-mega-binding-'));
      const path = join(directory, stagedFile);
      try {
        await writeFile(path, binding, { mode: 0o600, signal });
        await sendFile(control, config.remote, markerFile, path, signal);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      if (!await matchesMarker(control, config.remote, binding, signal)) throw rcloneUnavailable();
    }
    signal.throwIfAborted();
    db.exec('UPDATE mega_account SET connected = 1 WHERE id = 1; UPDATE mega_replicas SET retry_at = 0 WHERE verified = 0;');
  } finally {
    await control.close?.();
  }
}

async function statFile(control: RcloneControl, fs: string, remote: string, signal: AbortSignal) {
  const result = await control.call('operations/stat', { fs, remote }, signal) as
    { item?: { IsDir?: boolean; Size?: number } | null };
  if (result?.item === null) return null;
  const item = result?.item;
  if (item?.IsDir !== false || !Number.isSafeInteger(item.Size) || item.Size! < 0) throw rcloneUnavailable();
  return { size: item.Size! };
}

async function sendFile(control: RcloneControl, remote: string, name: string, path: string, signal: AbortSignal) {
  await control.call('operations/copyfile', { srcFs: localFs(dirname(path)), srcRemote: basename(path),
    dstFs: remote, dstRemote: name }, signal);
}

function receiveFile(control: RcloneControl, remote: string, name: string, signal: AbortSignal) {
  return Readable.from((async function* () {
    const directory = await mkdtemp(join(tmpdir(), 'blackbox-mega-download-'));
    try {
      await control.call('operations/copyfile', { srcFs: remote, srcRemote: name,
        dstFs: localFs(directory), dstRemote: stagedFile }, signal);
      yield* createReadStream(join(directory, stagedFile), { signal });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })(), { objectMode: false });
}

async function matchesMarker(control: RcloneControl, remote: string, binding: string, signal: AbortSignal) {
  const metadata = await statFile(control, remote, markerFile, signal);
  if (metadata?.size !== binding.length) return false;
  const marker = await buffer(receiveFile(control, remote, markerFile, signal));
  return marker.equals(Buffer.from(binding));
}

export function openMega(db: DatabaseSync, config: MegaConfig | undefined) {
  if (!config) return null;
  const state = bindingRow(db);
  return state?.connected ? new MegaStorage(config, state.binding) : null;
}

export class MegaStorage implements CloudProvider {
  private readonly remote: string;
  private readonly binding: string;
  private readonly control: RcloneControl;

  constructor(config: MegaConfig, binding: string, control = rcloneControl(config.executable, config.configPath, config.configEnv)) {
    this.remote = config.remote;
    this.binding = binding;
    this.control = control;
  }

  private filename(id: string) {
    if (!objectId.test(id)) throw rcloneUnavailable();
    return id + '.bbs';
  }

  private async checkFolder(signal: AbortSignal) {
    if (!await matchesMarker(this.control, this.remote, this.binding, signal)) {
      throw new DriveError(503, 'Reconnect the original MEGA folder before continuing.');
    }
  }

  async quota(signal: AbortSignal) {
    await this.checkFolder(signal);
    const result = await this.control.call('operations/about', { fs: this.remote }, signal) as { total?: unknown; used?: unknown } | null;
    return reportedQuota(result?.total, result?.used);
  }

  async allocate(signal: AbortSignal, key: string) {
    signal.throwIfAborted();
    this.filename(key);
    return key;
  }

  async upload(id: string, _object: Ciphertext, sourcePath: string, signal: AbortSignal) {
    await this.checkFolder(signal);
    await sendFile(this.control, this.remote, this.filename(id), sourcePath, signal);
  }

  async verify(id: string, object: Ciphertext, signal: AbortSignal) {
    await this.checkFolder(signal);
    const file = this.filename(id);
    const metadata = await statFile(this.control, this.remote, file, signal);
    if (!metadata) return false;
    if (metadata.size !== object.bytes) throw rcloneUnavailable();

    let size = 0;
    const checksum = createHash('sha256');
    for await (const bytes of receiveFile(this.control, this.remote, file, signal)) {
      size += bytes.length;
      if (size > object.bytes) throw rcloneUnavailable();
      checksum.update(bytes);
    }
    if (size !== object.bytes || checksum.digest('hex') !== object.checksum) throw rcloneUnavailable();
    return true;
  }

  async download(id: string, signal: AbortSignal, bytes: number) {
    await this.checkFolder(signal);
    const file = this.filename(id);
    if ((await statFile(this.control, this.remote, file, signal))?.size !== bytes) throw rcloneUnavailable();
    return receiveFile(this.control, this.remote, file, signal);
  }

  async delete(id: string, signal: AbortSignal) {
    await this.checkFolder(signal);
    const remote = this.filename(id);
    if (await statFile(this.control, this.remote, remote, signal)) {
      await this.control.call('operations/deletefile', { fs: this.remote, remote }, signal);
    }
    if (await statFile(this.control, this.remote, remote, signal)) throw rcloneUnavailable();
  }

  async close() {
    await this.control.close?.();
  }
}
