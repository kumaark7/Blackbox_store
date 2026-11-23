import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Drive } from '../src/files/drive.ts';
import { ROOT_ID } from '../src/files/index.ts';

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
  const { objectKey, sha256, size } = drive.index.get(file.id);
  assert.ok(objectKey && sha256 && size !== null);
  assert.equal(await drive.storage.verify({ key: objectKey, sha256, size }), true);
  await writeFile(join(directory, 'objects', objectKey), 'other');
  assert.equal(await drive.storage.verify({ key: objectKey, sha256, size }), false);
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

test('a version-one drive keeps its existing entries when the purge migration runs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'blackbox-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sql = await readFile(new URL('../src/database/001-initial.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(join(directory, 'metadata.sqlite'));
  try {
    db.exec(sql);
    db.exec('PRAGMA user_version = 1');
    db.prepare(`INSERT INTO nodes (id, parent_id, name, kind, state, created_at, updated_at)
      VALUES (?, ?, 'Existing folder', 'folder', 'ready', 1, 1)`).run('existing-folder', ROOT_ID);
  } finally {
    db.close();
  }

  const drive = await Drive.open(directory, 128, 1);
  try {
    assert.equal(drive.index.db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(browse(drive).items[0].name, 'Existing folder');
    drive.index.moveToTrash('existing-folder');
    await drive.purge('existing-folder');
    assert.equal(browse(drive, ROOT_ID, undefined, true).items.length, 0);
  } finally {
    drive.close();
  }
});
