import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Drive } from '../src/files/drive.ts';
import { ROOT_ID } from '../src/files/index.ts';
import { CHUNK_BYTES } from '../src/storage/format.ts';
import { backupDrive, restoreDrive } from '../src/storage/recovery.ts';

async function fixture(t: TestContext, uploadLimit = 128, concurrency = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'blackbox-drive-'));
  let drive: Drive | null = null;
  t.after(async () => {
    drive?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const restart = async () => {
    drive?.close();
    drive = null;
    drive = await Drive.open(directory, uploadLimit, concurrency);
    return drive;
  };
  return { directory, drive: await restart(), restart };
}

const browse = (drive: Drive, parentId = ROOT_ID, search?: string, trash?: boolean) =>
  drive.index.browse({ parentId, search, sort: 'name', offset: 0, limit: 20, trash });
const upload = (drive: Drive, name: string, content: Buffer, parentId = ROOT_ID) =>
  drive.upload({ parentId, name, importance: 'highly-important' }, () => Readable.from([content]));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
const fingerprint = (...chunks: Buffer[]) => digest(Buffer.concat(chunks.map(digest))).toString('hex');
const transferInput = (name: string, ...chunks: Buffer[]) => ({
  parentId: ROOT_ID, name, importance: 'backup' as const,
  size: chunks.reduce((sum, chunk) => sum + chunk.length, 0), fingerprint: fingerprint(...chunks),
});
const append = (drive: Drive, id: string, offset: number, chunk: Buffer) =>
  drive.appendTransfer(id, offset, () => Readable.from([chunk]), new AbortController().signal);

test('SQLite opens in WAL mode with foreign keys and one active drive per directory', async (t) => {
  const { drive, directory } = await fixture(t);
  assert.equal(drive.index.db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  assert.equal(drive.index.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  await assert.rejects(Drive.open(directory, 128, 1), { status: 503 });
});

test('verified upload, independent local copy, and restart preserve bytes and metadata', async (t) => {
  const { drive, restart } = await fixture(t);
  const folder = drive.index.createFolder(ROOT_ID, 'Records');
  const bytes = Buffer.from([0, 255, 17, 39]);
  const file = await upload(drive, 'café.bin', bytes, folder.id);
  assert.equal(file.protection, 'degraded');
  const copy = await drive.copy(file.id, ROOT_ID, 'copy.bin');
  assert.notEqual(drive.index.get(file.id).objectKey, drive.index.get(copy.id).objectKey);
  const reopened = await restart();
  assert.deepEqual(await buffer((await reopened.download(file.id)).stream), bytes);
  assert.deepEqual(await buffer((await reopened.download(copy.id)).stream), bytes);
  assert.deepEqual(browse(reopened, folder.id).breadcrumbs.map(({ name }) => name), ['My Files', 'Records']);
  assert.equal(browse(reopened, folder.id).items[0].name, 'café.bin');
});

test('stored bytes are verified against SHA-256 and zero-byte files remain valid', async (t) => {
  const { drive, directory } = await fixture(t);
  const empty = await upload(drive, 'empty.bin', Buffer.alloc(0));
  assert.equal((await buffer((await drive.download(empty.id)).stream)).length, 0);
  const file = await upload(drive, 'checked.bin', Buffer.from('check'));
  const { objectKey, sha256, size, storageFormat: format } = drive.index.get(file.id);
  assert.ok(objectKey && sha256 && size !== null);
  assert.equal(format, 1);
  const object = { key: objectKey, sha256, size, format };
  assert.equal(await drive.storage.verify(object), true);
  const path = join(directory, 'objects', objectKey);
  const stored = await readFile(path);
  assert.equal(stored.includes(Buffer.from('check')), false);
  stored[40] ^= 1;
  await writeFile(path, stored);
  assert.equal(await drive.storage.verify(object), false);
  await assert.rejects(buffer((await drive.download(file.id)).stream), { status: 503 });
});

test('uploads resume from committed chunks and recover an interrupted publish', async (t) => {
  const { drive, restart } = await fixture(t, CHUNK_BYTES + 100);
  const first = Buffer.alloc(CHUNK_BYTES, 7);
  const last = Buffer.from('tail');
  const input = transferInput('resume.bin', first, last);
  const { id } = drive.startTransfer(input);
  assert.deepEqual(drive.startTransfer(input), drive.transferStatus(id));
  await assert.rejects(append(drive, id, 0, Buffer.alloc(1)), { status: 400 });
  assert.equal(drive.transferStatus(id).received, 0);
  const slow = new PassThrough();
  const active = drive.appendTransfer(id, 0, () => slow, new AbortController().signal);
  await assert.rejects(append(drive, id, 0, first), { status: 409 });
  slow.end(first);
  assert.equal((await active).received, CHUNK_BYTES);
  await assert.rejects(append(drive, id, 0, first), { status: 409 });
  await assert.rejects(drive.finishTransfer(id), { status: 409 });
  const key = drive.index.pending().find((row) => row.id === id)!.key;
  await drive.storage.append(key, CHUNK_BYTES, Buffer.from('uncommitted bytes'));
  const reopened = await restart();
  assert.equal(reopened.listTransfers()[0].received, CHUNK_BYTES);
  assert.equal(reopened.startTransfer(input).id, id);
  assert.throws(() => reopened.startTransfer(transferInput(input.name, first, Buffer.from('else'))), { status: 409 });
  await append(reopened, id, CHUNK_BYTES, last);
  // Simulate a stop after the final rename and before SQLite exposes the file.
  await reopened.storage.complete(key, input.size, input.fingerprint);
  const afterPublish = await restart();
  assert.equal(browse(afterPublish).items.length, 0);
  assert.equal((await afterPublish.finishTransfer(id)).completed, true);
  assert.equal((await afterPublish.finishTransfer(id)).completed, true);
  assert.deepEqual(await buffer((await afterPublish.download(id)).stream), Buffer.concat([first, last]));
  assert.deepEqual(afterPublish.listTransfers(), []);
});

test('wrong transfer bytes cannot be published and a discarded name is reusable', async (t) => {
  const { drive } = await fixture(t);
  const original = Buffer.from('original');
  const input = transferInput('verify.txt', original);
  const { id } = drive.startTransfer(input);
  await append(drive, id, 0, Buffer.from('mismatch'));
  await assert.rejects(drive.finishTransfer(id), { status: 422 });
  assert.deepEqual(browse(drive).items, []);
  await drive.discardTransfer(id);
  assert.throws(() => drive.transferStatus(id), { status: 404 });
  assert.notEqual(drive.startTransfer(input).id, id);
});

test('a missing or replaced storage key prevents the drive from opening', async (t) => {
  const { directory, drive, restart } = await fixture(t);
  await upload(drive, 'protected', Buffer.from('test'));
  const path = join(directory, 'storage.key');
  const key = await readFile(path);
  await writeFile(path, Buffer.alloc(32));
  await assert.rejects(restart(), /storage key is invalid/);
  await rm(path);
  await assert.rejects(restart(), /storage key is missing/);
  await writeFile(path, key);
  assert.equal(browse(await restart()).items[0].name, 'protected');
});

test('folders can be managed without cycles and trashed descendants stay hidden', async (t) => {
  const { drive } = await fixture(t);
  const parent = drive.index.createFolder(ROOT_ID, 'Parent');
  const child = drive.index.createFolder(parent.id, 'Child');
  const file = await upload(drive, 'Document.txt', Buffer.from('data'), child.id);
  assert.throws(() => drive.index.edit(parent.id, { parentId: child.id }), { status: 400 });
  drive.index.edit(file.id, { parentId: parent.id, name: 'Renamed.txt', importance: 'backup' });
  assert.equal(browse(drive, ROOT_ID, 'renamed').items[0].importance, 'backup');
  drive.index.moveToTrash(parent.id);
  assert.equal(browse(drive, ROOT_ID, 'renamed').items.length, 0);
  await assert.rejects(drive.download(file.id), { status: 404 });
  assert.equal(browse(drive, ROOT_ID, undefined, true).items[0].id, parent.id);
  drive.index.restore(parent.id);
  assert.equal(browse(drive, ROOT_ID, 'renamed').items[0].id, file.id);
});

test('reserved names and duplicate folder entries are rejected with pagination', async (t) => {
  const { drive } = await fixture(t);
  for (const invalid of ['../x', 'a/b', 'a\\b', 'NUL.txt', '..', 'a.', 'a\u0000b']) {
    assert.throws(() => drive.index.createFolder(ROOT_ID, invalid), { status: 400 });
  }
  drive.index.createFolder(ROOT_ID, 'Alpha');
  drive.index.createFolder(ROOT_ID, 'Beta');
  assert.throws(() => drive.index.createFolder(ROOT_ID, 'alpha'), { status: 409 });
  const first = drive.index.browse({ parentId: ROOT_ID, sort: 'name', offset: 0, limit: 1 });
  assert.equal(first.items[0].name, 'Alpha');
  assert.equal(first.nextOffset, 1);
  const second = drive.index.browse({ parentId: ROOT_ID, sort: 'name', offset: 1, limit: 1 });
  assert.equal(second.items[0].name, 'Beta');
  assert.equal(second.nextOffset, null);
});

test('upload limits and aborts release names, staging files and concurrency slots', async (t) => {
  const { drive, directory } = await fixture(t, 8);
  await assert.rejects(upload(drive, 'one', Buffer.alloc(9)), { status: 413 });
  assert.equal(browse(drive).items.length, 0);
  assert.deepEqual(await readdir(join(directory, 'objects')), []);

  const inbound = new PassThrough();
  const cancel = new AbortController();
  const pending = drive.upload({ parentId: ROOT_ID, name: 'one', importance: 'backup', signal: cancel.signal }, () => inbound);
  await assert.rejects(upload(drive, 'two', Buffer.from('x')), { status: 429 });
  cancel.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(await readdir(join(directory, 'objects')), []);
  await upload(drive, 'one', Buffer.from('ok'));
});

test('startup cleans abandoned reservations before accepting the same name again', async (t) => {
  const { drive, directory, restart } = await fixture(t);
  await upload(drive, 'committed', Buffer.from('keep'));
  const pending = drive.index.reserve(ROOT_ID, 'abandoned', 'backup');
  await writeFile(join(directory, 'objects', pending.key), 'partial fixture');
  await writeFile(join(directory, 'objects', pending.key + '.part'), 'partial fixture');
  const reopened = await restart();
  assert.equal(reopened.index.pending().length, 0);
  assert.equal((await readdir(join(directory, 'objects'))).length, 1);
  await upload(reopened, 'abandoned', Buffer.from('retry'));
});

test('purging a folder removes its subtree and leaves unrelated files intact', async (t) => {
  const { drive, directory } = await fixture(t);
  const parent = drive.index.createFolder(ROOT_ID, 'Discard');
  const child = drive.index.createFolder(parent.id, 'Nested');
  const file = await upload(drive, 'discarded.txt', Buffer.from('discarded'), child.id);
  const separate = await upload(drive, 'kept.txt', Buffer.from('kept'));
  drive.index.moveToTrash(file.id);
  drive.index.moveToTrash(parent.id);
  await drive.purge(parent.id);
  assert.equal(browse(drive, ROOT_ID, undefined, true).items.length, 0);
  assert.throws(() => drive.index.restore(file.id), { status: 404 });
  assert.equal((await readdir(join(directory, 'objects'))).length, 1);
  assert.equal((await buffer((await drive.download(separate.id)).stream)).toString(), 'kept');
});

test('an interrupted purge can be retried after restart and cannot restore missing content', async (t) => {
  const { drive, directory, restart } = await fixture(t);
  const file = await upload(drive, 'discarded.txt', Buffer.from('discarded'));
  const key = drive.index.get(file.id).objectKey;
  assert.ok(key);
  drive.index.moveToTrash(file.id);
  drive.index.startPurge(file.id);
  await drive.storage.delete(key);

  const reopened = await restart();
  assert.equal(browse(reopened, ROOT_ID, undefined, true).items[0].deletionPending, true);
  assert.throws(() => reopened.index.restore(file.id), { status: 409 });
  await reopened.purge(file.id);
  assert.deepEqual(await readdir(join(directory, 'objects')), []);
  assert.equal(browse(reopened, ROOT_ID, undefined, true).items.length, 0);
});

test('a version-one drive keeps existing folders and plaintext files across migrations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'blackbox-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sql = await readFile(new URL('../src/database/001-initial.sql', import.meta.url), 'utf8');
  const legacyId = '00000000-0000-4000-8000-000000000001';
  const legacyKey = '00000000-0000-4000-8000-000000000002';
  const bytes = Buffer.from('old object bytes');
  await mkdir(join(directory, 'objects'));
  await writeFile(join(directory, 'objects', legacyKey), bytes);
  const db = new DatabaseSync(join(directory, 'metadata.sqlite'));
  try {
    db.exec(sql);
    db.exec('PRAGMA user_version = 1');
    db.prepare(`INSERT INTO nodes (id, parent_id, name, kind, state, created_at, updated_at)
      VALUES (?, ?, 'Existing folder', 'folder', 'ready', 1, 1)`).run('existing-folder', ROOT_ID);
    db.prepare(`INSERT INTO nodes (id, parent_id, name, kind, state, importance, object_key, size, sha256, created_at, updated_at)
      VALUES (?, 'existing-folder', 'legacy.txt', 'file', 'ready', 'backup', ?, ?, ?, 1, 1)`)
      .run(legacyId, legacyKey, bytes.length, digest(bytes).toString('hex'));
  } finally {
    db.close();
  }

  const drive = await Drive.open(directory, 128, 1);
  try {
    assert.equal(drive.index.db.prepare('PRAGMA user_version').get()?.user_version, 8);
    assert.equal(browse(drive).items[0].name, 'Existing folder');
    assert.equal(drive.index.get(legacyId).storageFormat, 0);
    assert.deepEqual(await buffer((await drive.download(legacyId)).stream), bytes);
    drive.index.moveToTrash('existing-folder');
    await drive.purge('existing-folder');
    assert.equal(browse(drive, ROOT_ID, undefined, true).items.length, 0);
  } finally {
    drive.close();
  }
});

test('a password-protected backup restores files, metadata and pending transfers into a fresh drive', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'blackbox-recovery-'));
  const source = join(base, 'source');
  const backup = join(base, 'backup');
  const restored = join(base, 'restored');
  const passphrase = 'fixture recovery passphrase';
  t.after(() => rm(base, { recursive: true, force: true }));
  const drive = await Drive.open(source, 128, 1);
  const content = Buffer.from('unique encrypted file bytes');
  const legacyBytes = Buffer.from('unique legacy plaintext bytes');
  let fileId: string;
  let legacyId: string;
  let pendingId: string;
  try {
    drive.index.db.exec(`INSERT INTO owner (id, password_hash) VALUES (1, 'fixture owner hash');
      INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES ('fixture session', 1, 4000000000);`);
    const folder = drive.index.createFolder(ROOT_ID, 'Private folder name');
    fileId = (await upload(drive, 'Protected.txt', content, folder.id)).id;
    const legacy = drive.index.reserve(ROOT_ID, 'Legacy.txt', 'backup');
    legacyId = legacy.id;
    await writeFile(drive.storage.path(legacy.key), legacyBytes);
    drive.index.finish(legacy.id, legacyBytes.length, digest(legacyBytes).toString('hex'), 0);
    const pending = drive.startTransfer(transferInput('pending.txt', content));
    pendingId = pending.id;
    await append(drive, pending.id, 0, content);
  } finally { drive.close(); }
  await backupDrive(source, backup, passphrase);
  assert.deepEqual((await readdir(backup)).sort(), ['index', 'objects', 'recovery.key']);
  const indexFiles = await readdir(join(backup, 'index'));
  const encryptedIndex = await readFile(join(backup, 'index', indexFiles[0]));
  assert.equal(encryptedIndex.includes(Buffer.from('Private folder name')), false);
  for (const name of await readdir(join(backup, 'objects'))) {
    const object = await readFile(join(backup, 'objects', name));
    assert.equal(object.includes(legacyBytes) || object.includes(content), false);
  }
  await assert.rejects(restoreDrive(backup, restored, 'wrong recovery passphrase'), /passphrase is incorrect/);
  await restoreDrive(backup, restored, passphrase);
  await assert.rejects(restoreDrive(backup, restored, passphrase), { code: 'EEXIST' });
  const recovered = await Drive.open(restored, 128, 1);
  try {
    assert.equal(recovered.index.db.prepare('SELECT password_hash FROM owner').get()?.password_hash, 'fixture owner hash');
    assert.equal(recovered.index.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count, 0);
    assert.deepEqual(await buffer((await recovered.download(fileId)).stream), content);
    assert.deepEqual(await buffer((await recovered.download(legacyId)).stream), legacyBytes);
    assert.equal(recovered.index.get(legacyId).storageFormat, 1);
    assert.equal(recovered.transferStatus(pendingId).received, content.length);
    assert.equal((await recovered.finishTransfer(pendingId)).completed, true);
    assert.deepEqual(await buffer((await recovered.download(pendingId)).stream), content);
  } finally { recovered.close(); }
});
