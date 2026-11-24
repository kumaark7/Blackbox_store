import { lstat, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Drive } from '../files/drive.ts';
import { IMPORTANCE } from '../files/index.ts';
import type { Importance } from '../files/index.ts';
import { missingFile } from './key.ts';

async function diskUsage(dataDir: string) {
  try {
    const disk = await statfs(dataDir, { bigint: true });
    if (disk.blocks <= 0n || disk.bsize <= 0n || disk.bavail < 0n) return null;
    return { totalBytes: Number(disk.blocks * disk.bsize), availableBytes: Number(disk.bavail * disk.bsize) };
  } catch {
    return null;
  }
}

export async function localUsage(dataDir: string, objectDir: string, trashKeys: ReadonlySet<string>) {
  let appBytes = 0;
  let trashBytes = 0;
  async function count(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (directory !== dataDir && missingFile(error)) return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await count(path);
      } else if (entry.isFile()) {
        const info = await lstat(path).catch((error) => {
          if (missingFile(error)) return null;
          throw error;
        });
        if (!info?.isFile()) continue;
        appBytes += info.size;
        if (directory === objectDir && trashKeys.has(entry.name)) trashBytes += info.size;
      }
    }
  }
  const [disk] = await Promise.all([diskUsage(dataDir), count(dataDir)]);
  return { appBytes, trashBytes, disk };
}

export async function cloudUsage(drive: Drive) {
  const sources = [
    { id: 'google-drive', replicas: drive.googleDrive },
    { id: 'mega', replicas: drive.mega },
    { id: 'terabox', replicas: drive.terabox },
    { id: 'telegram', replicas: drive.telegram },
  ] as const;
  const accounts = sources.map((source) => ({ ...source, status: source.replicas.status() }));
  const connected = accounts.map(({ status }) => Number(status === 'connected' || status === 'retrying'));
  const rows = connected.some(Boolean) ? drive.index.db.prepare(`
    WITH RECURSIVE trashed(id) AS (
      SELECT id FROM nodes WHERE state = 'trash'
      UNION ALL SELECT nodes.id FROM nodes JOIN trashed ON nodes.parent_id = trashed.id WHERE nodes.state != 'trash'
    )
    SELECT importance, COUNT(*) AS files, SUM(size) AS bytes FROM nodes
    WHERE kind = 'file' AND state = 'ready' AND id NOT IN (SELECT id FROM trashed)
      AND ((? = 1 AND EXISTS (SELECT 1 FROM google_drive_replicas WHERE node_id = nodes.id AND verified = 1))
        OR (? = 1 AND EXISTS (SELECT 1 FROM mega_replicas WHERE node_id = nodes.id AND verified = 1))
        OR (? = 1 AND EXISTS (SELECT 1 FROM terabox_replicas WHERE node_id = nodes.id AND verified = 1))
        OR (? = 1 AND EXISTS (SELECT 1 FROM telegram_replicas WHERE node_id = nodes.id AND verified = 1)))
    GROUP BY importance`).all(...connected) as { importance: Importance; files: number; bytes: number }[] : [];
  const priorities = IMPORTANCE.map((importance) => {
    const row = rows.find((entry) => entry.importance === importance);
    return { importance, files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
  });
  const usage = await Promise.all(accounts.filter(({ status }) => status !== 'off').map(async ({ id, status, replicas }) => {
    const tracked = replicas.trackedUsage();
    return { id, status, tracked, quota: id === 'telegram' ? null : await replicas.accountQuota() };
  }));
  return { accounts: usage, priorities };
}
