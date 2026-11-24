import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { lockDrive, openDatabase } from '../database/open.ts';
import type { StoredObject } from './adapter.ts';
import { readExactly } from './format.ts';
import { keyPath, loadStorageKey, missingFile, syncDirectory, writePrivateFile } from './key.ts';
import { LocalStorage } from './local.ts';

const manifestName = 'recovery.key';
const metadataName = 'metadata.sqlite';
const metadataId = '00000000-0000-0000-0000-000000000000';
const magic = Buffer.from('BBRECOV1');
const bodyBytes = 32 + 8 + 32;
const tagBytes = 16;
const headerBytes = magic.length + 32 + 12;

function wrappingKey(passphrase: string, header: Buffer) {
  return scryptSync(passphrase, header.subarray(magic.length, magic.length + 32), 32,
    { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
}

function wrap(master: Buffer, index: StoredObject, passphrase: string) {
  const header = Buffer.concat([magic, randomBytes(32), randomBytes(12)]);
  const body = Buffer.alloc(bodyBytes);
  master.copy(body);
  body.writeBigUInt64BE(BigInt(index.size), 32);
  Buffer.from(index.sha256, 'hex').copy(body, 40);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey(passphrase, header), header.subarray(-12));
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
}

async function unwrap(path: string, passphrase: string) {
  const file = await open(path, 'r');
  let packet: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== headerBytes + bodyBytes + tagBytes) throw new Error('Invalid recovery key file.');
    packet = await readExactly(file, info.size, 0);
  } finally { await file.close(); }
  const header = packet.subarray(0, headerBytes);
  if (!header.subarray(0, magic.length).equals(magic)) throw new Error('Unsupported recovery key format.');
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey(passphrase, header), header.subarray(-12),
    { authTagLength: tagBytes });
  decipher.setAAD(header);
  decipher.setAuthTag(packet.subarray(-tagBytes));
  let body: Buffer;
  try {
    body = Buffer.concat([decipher.update(packet.subarray(headerBytes, -tagBytes)), decipher.final()]);
  } catch {
    throw new Error('The recovery passphrase is incorrect or the key file is damaged.');
  }
  const size = Number(body.readBigUInt64BE(32));
  if (!Number.isSafeInteger(size)) throw new Error('Invalid recovery metadata size.');
  const index: StoredObject = { key: metadataId, size, sha256: body.subarray(40).toString('hex'), format: 1 };
  return { master: body.subarray(0, 32), index };
}

async function withNewDirectory(source: string, output: string, operation: (directory: string) => Promise<void>) {
  const target = resolve(output);
  const destination = join(await realpath(dirname(target)), basename(target));
  const nested = (from: string, to: string) => {
    const path = relative(from, to);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
  };
  if (nested(source, destination) || nested(destination, source)) {
    throw new Error('Choose a new destination separate from the source directory.');
  }
  await mkdir(destination, { mode: 0o700 });
  try {
    await operation(destination);
    await syncDirectory(destination);
    await syncDirectory(dirname(destination));
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function completeObjects(db: DatabaseSync) {
  return db.prepare(`WITH RECURSIVE purging(id) AS (
    SELECT node_id FROM trash_purges
    UNION SELECT nodes.id FROM nodes JOIN purging ON nodes.parent_id = purging.id
  )
  SELECT object_key AS key, size, sha256, storage_format AS format FROM nodes
  WHERE kind = 'file' AND state != 'pending' AND id NOT IN (SELECT id FROM purging)`).iterate() as Iterable<StoredObject>;
}

async function syncFile(path: string) {
  const file = await open(path, 'r+');
  try { await file.sync(); } finally { await file.close(); }
}

async function copyObject(source: string, destination: string, optional = false) {
  try { await copyFile(source, destination); } catch (error) {
    if (optional && missingFile(error)) return false;
    throw error;
  }
  await syncFile(destination);
  return true;
}

async function copyPending(db: DatabaseSync, source: LocalStorage, destination: LocalStorage) {
  const pending = db.prepare(`SELECT object_key AS key, received_bytes AS received FROM transfers JOIN nodes
    ON node_id = nodes.id WHERE state = 'pending'`).iterate() as Iterable<{ key: string; received: number }>;
  for (const { key, received } of pending) {
    const published = await copyObject(source.path(key), destination.path(key), true);
    const partial = await copyObject(source.path(key) + '.part', destination.path(key) + '.part', true);
    if (received > 0 && !published && !partial) throw new Error('A saved upload is missing its storage object.');
  }
}

function recoveryStorage(directory: string, master: Buffer) {
  return new LocalStorage(directory, Number.MAX_SAFE_INTEGER, master);
}

export async function backupDrive(dataDir: string, output: string, passphrase: string) {
  if (passphrase.length < 16 || passphrase.length > 1024) throw new Error('Use a recovery passphrase of 16 to 1024 characters.');
  const source = await realpath(dataDir);
  const metadata = join(source, metadataName);
  if (!(await stat(metadata)).isFile()) throw new Error('The source has no drive database.');
  const lock = lockDrive(source);
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(source);
    const snapshot = db;
    const master = await loadStorageKey(source, snapshot, true);
    if (snapshot.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !== 0) {
      throw new Error('The drive database is busy. Stop the server and retry.');
    }
    await withNewDirectory(source, output, async (destination) => {
      const live = recoveryStorage(join(source, 'objects'), master);
      const objects = recoveryStorage(join(destination, 'objects'), master);
      const index = recoveryStorage(join(destination, 'index'), master);
      await mkdir(objects.directory, { mode: 0o700 });
      await mkdir(index.directory, { mode: 0o700 });
      const encryptedIndex = await index.upload(metadataId, createReadStream(metadata));
      for (const object of completeObjects(snapshot)) {
        if (object.format === 1) {
          await copyObject(live.path(object.key), objects.path(object.key));
        } else {
          const encrypted = await objects.upload(object.key, await live.download(object));
          if (encrypted.sha256 !== object.sha256) throw new Error('A legacy file failed backup verification.');
        }
        if (!await objects.verify({ ...object, format: 1 })) throw new Error('A file in the backup failed verification.');
      }
      await copyPending(snapshot, live, objects);
      await syncDirectory(objects.directory);
      await writePrivateFile(join(destination, manifestName), wrap(master, encryptedIndex, passphrase));
    });
  } finally {
    try { db?.close(); } finally { lock.close(); }
  }
}

export async function restoreDrive(backupDir: string, output: string, passphrase: string) {
  const source = await realpath(backupDir);
  const { master, index } = await unwrap(join(source, manifestName), passphrase);
  await withNewDirectory(source, output, async (destination) => {
    const objects = recoveryStorage(join(source, 'objects'), master);
    const restored = recoveryStorage(join(destination, 'objects'), master);
    const snapshot = recoveryStorage(join(source, 'index'), master);
    const metadata = join(destination, metadataName);
    await mkdir(restored.directory, { mode: 0o700 });
    await pipeline(await snapshot.download(index), createWriteStream(metadata, { flags: 'wx', mode: 0o600 }));
    const db = openDatabase(destination);
    try {
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('The restored drive database failed verification.');
      for (const object of completeObjects(db)) {
        await copyObject(objects.path(object.key), restored.path(object.key));
        if (!await restored.verify({ ...object, format: 1 })) throw new Error('A restored file failed verification.');
      }
      await copyPending(db, objects, restored);
      db.exec("UPDATE nodes SET storage_format = 1 WHERE kind = 'file' AND state != 'pending'; DELETE FROM sessions;");
    } finally { db.close(); }
    await syncFile(metadata);
    await syncDirectory(restored.directory);
    await writePrivateFile(keyPath(destination), master);
  });
}
