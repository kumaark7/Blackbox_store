import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openDatabase } from '../src/database/open.ts';
import { Drive } from '../src/files/drive.ts';
import { ROOT_ID } from '../src/files/index.ts';
import { loadStorageKey } from '../src/storage/key.ts';
import { TelegramStorage } from '../src/storage/telegram.ts';
import type { TelegramChannel } from '../src/storage/telegram.ts';
import { bindTelegram, telegramApplication } from '../src/storage/telegram-credentials.ts';

const login = {
  apiId: 123456,
  apiHash: '0'.repeat(32),
  channelId: '1234567890',
  userId: '9000000001',
  accessHash: '-9223372036854775808',
  session: 'fixture-only-telegram-session',
};

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'blackbox-telegram-test-'));
  const db = openDatabase(dataDir);
  let drive: Drive | undefined;
  t.after(async () => {
    drive?.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const key = await loadStorageKey(dataDir, db);
  await bindTelegram(db, dataDir, key, login);
  const posts = new Map<number, { caption: string; content: Buffer }>();
  const calls = { sends: 0, deletes: 0, histories: 0, dropSendReply: false, accessible: true, remove: true };
  let latest = 20;
  const channel: TelegramChannel = {
    async check() {
      if (!calls.accessible) throw new Error('Fixture channel is inaccessible.');
    },
    async latestId() { return latest; },
    async byId(id) {
      const post = posts.get(id);
      return post ? { id, caption: post.caption, bytes: post.content.length } : null;
    },
    async find(caption, after) {
      calls.histories++;
      assert.equal(after, 20);
      for (const [id, post] of posts) {
        if (id > after && post.caption === caption) return { id, caption, bytes: post.content.length };
      }
      return null;
    },
    async send(caption, randomId, path, bytes) {
      assert.match(caption, /^blackbox-[0-9a-f-]{36}$/);
      assert.match(randomId, /^-?[0-9]+$/);
      const content = await readFile(path);
      assert.equal(content.length, bytes);
      calls.sends++;
      posts.set(++latest, { caption, content });
      if (calls.dropSendReply) throw new Error('Fixture lost send response after publishing.');
    },
    async *download(id) {
      const post = posts.get(id);
      assert.ok(post);
      yield post.content;
    },
    async delete(id) {
      calls.deletes++;
      if (calls.remove) posts.delete(id);
    },
    async close() {},
  };
  async function open(offline = false) {
    drive?.close();
    drive = undefined;
    drive = await Drive.open(dataDir, 1024, 1, offline ? { telegramClientDir: join(dataDir, 'missing-package-prefix') }
      : { telegramProvider: new TelegramStorage(db, channel) });
    return drive;
  }
  return { db, dataDir, key, open, calls, posts };
}

test('Telegram retries a lost send using the private channel and repairs missing Backup ciphertext', async (t) => {
  const { db, open, calls, posts } = await fixture(t);
  let drive = await open();
  const bytes = Buffer.from('unique original Telegram fixture bytes');
  const file = await drive.upload({ parentId: ROOT_ID, name: 'private-note.txt', importance: 'backup' }, () => Readable.from([bytes]));
  await drive.upload({ parentId: ROOT_ID, name: 'important.txt', importance: 'important' }, () => Readable.from([bytes]));
  const local = drive.storage.path(drive.index.get(file.id).objectKey!);
  calls.dropSendReply = true;
  assert.equal(await drive.telegram.replicateNext(), true);
  assert.equal(drive.telegram.status(), 'retrying');
  const [post] = [...posts.values()];
  assert.equal(post.caption.includes(file.name), false);
  assert.equal(post.content.includes(bytes), false);
  assert.deepEqual(post.content, await readFile(local));
  drive = await open();
  const later = Date.now() + 60_000;
  assert.equal(await drive.telegram.replicateNext(later), true);
  assert.equal(await drive.telegram.replicateNext(later), false);
  assert.equal(drive.telegram.status(), 'connected');
  assert.equal(calls.sends, 1);
  assert.equal(db.prepare('SELECT message_id FROM telegram_replicas WHERE node_id = ?').get(file.id)?.message_id, 21);
  const entries = drive.index.browse({ parentId: ROOT_ID, sort: 'name', limit: 10, offset: 0 }).items;
  assert.deepEqual(entries.find((item) => item.id === file.id)?.cloudCopies, ['telegram']);
  assert.deepEqual(entries.find((item) => item.name === 'important.txt')?.cloudCopies, []);
  const historyCalls = calls.histories;
  await rm(local);
  assert.deepEqual(await buffer((await drive.download(file.id)).stream), bytes);
  assert.equal(calls.histories, historyCalls);
  assert.deepEqual(await readFile(local), post.content);
});

test('Telegram purge verifies the tracked message disappeared before removing local bytes', async (t) => {
  const { open, posts, calls } = await fixture(t);
  let drive = await open();
  const file = await drive.upload({ parentId: ROOT_ID, name: 'delete-me.txt', importance: 'backup' }, () => Readable.from(['disposable']));
  const local = drive.storage.path(drive.index.get(file.id).objectKey!);
  await drive.telegram.replicateNext();
  const post = posts.get(21)!;
  drive.index.moveToTrash(file.id);
  drive = await open(true);
  assert.equal(drive.telegram.status(), 'reconnect');
  await assert.rejects(drive.purge(file.id), { status: 503 });
  drive = await open();
  const caption = post.caption;
  post.caption = 'unrelated entry';
  await assert.rejects(drive.purge(file.id), { status: 503 });
  assert.equal(calls.deletes, 0);
  post.caption = caption;
  calls.remove = false;
  await assert.rejects(drive.purge(file.id), { status: 503 });
  assert.deepEqual(await readFile(local), post.content);
  calls.remove = true;
  await drive.purge(file.id);
  assert.equal(posts.has(21), false);
  await assert.rejects(readFile(local), { code: 'ENOENT' });
});

test('Telegram seals its session and reconnect must use the original account and channel', async (t) => {
  const { db, dataDir, key } = await fixture(t);
  const example = await readFile(new URL('../../docs/telegram.example.json', import.meta.url), 'utf8');
  const application = telegramApplication(JSON.parse(example));
  assert.equal(application.channelId, login.channelId);
  assert.throws(() => telegramApplication({ ...application, channelId: '-1001234567890' }), /setup JSON/);
  const sealed = await readFile(join(dataDir, 'telegram.credentials'));
  assert.equal(sealed.includes(login.session), false);
  await assert.rejects(bindTelegram(db, dataDir, key, { ...login, userId: '9000000002' }), /original Telegram account/);
  await assert.rejects(bindTelegram(db, dataDir, key, { ...login, channelId: '1234567891' }), /original Telegram account/);
  assert.deepEqual(await readFile(join(dataDir, 'telegram.credentials')), sealed);
});
