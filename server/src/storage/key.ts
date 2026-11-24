import { createHash, randomBytes } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export function missingFile(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function syncDirectory(path: string) {
  if (process.platform !== 'linux') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writePrivateFile(path: string, bytes: Uint8Array) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export const keyPath = (dataDir: string) => join(dataDir, 'storage.key');

export async function loadStorageKey(dataDir: string, db: DatabaseSync, required = false) {
  const path = keyPath(dataDir);
  const expected = db.prepare('SELECT digest FROM storage_key_identity WHERE id = 1').get()?.digest;
  let key: Buffer;
  try {
    key = await readFile(path);
  } catch (error) {
    if (!missingFile(error)) throw error;
    if (expected || required) throw new Error('The storage key is missing. Restore it from a backup.');
    key = randomBytes(32);
    await writePrivateFile(path, key);
  }
  const digest = createHash('sha256').update(key).digest('hex');
  if (key.length !== 32 || (expected && expected !== digest)) {
    throw new Error('The storage key is invalid. Restore it from a backup.');
  }
  if (!expected) db.prepare('INSERT INTO storage_key_identity (id, digest) VALUES (1, ?)').run(digest);
  return key;
}
