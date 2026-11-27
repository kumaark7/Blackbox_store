import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openDatabase } from '../src/database/open.ts';
import { Drive } from '../src/files/drive.ts';
import { ROOT_ID } from '../src/files/index.ts';
import { connectMega, MegaStorage } from '../src/storage/mega-rclone.ts';
import { rcloneOperationError } from '../src/storage/rclone-rc.ts';
import type { RcloneControl } from '../src/storage/rclone-rc.ts';

const config = { remote: 'test-mega:BlackboxStore', executable: 'rclone' };
const marker = config.remote + '/.blackbox-store-id';

test('native MEGA browses outside the Blackbox folder and sends original bytes without overwriting', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'blackbox-mega-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('real file contents');
  const file = join(directory, 'source');
  await writeFile(file, bytes);
  const binding = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  let uploaded = false;
  const remote = new MegaStorage(config, binding, {
    async call(route, args) {
      if (route === 'operations/stat') {
        if (args.fs === config.remote) {
          assert.equal(args.remote, '.blackbox-store-id');
          return { item: { IsDir: false, Size: binding.length } };
        }
        assert.equal(args.fs, 'test-mega:');
        assert.equal(args.remote, 'existing/photo.jpg');
        return { item: uploaded ? { IsDir: false, Size: bytes.length } : null };
      }
      if (route === 'operations/list') {
        assert.deepEqual(args, { fs: 'test-mega:', remote: 'existing' });
        return { list: [{ Name: 'photo.jpg', IsDir: false, Size: bytes.length }] };
      }
      assert.equal(route, 'operations/copyfile');
      if (args.srcFs === config.remote) {
        assert.equal(args.srcRemote, '.blackbox-store-id');
        await writeFile(join(args.dstFs, args.dstRemote), binding);
      } else if (args.dstFs === 'test-mega:') {
        assert.equal(args.dstRemote, 'existing/photo.jpg');
        assert.equal(args.immutable, 'true');
        assert.deepEqual(await readFile(join(args.srcFs, args.srcRemote)), bytes);
        uploaded = true;
      } else {
        assert.equal(args.srcFs, 'test-mega:');
        assert.equal(args.srcRemote, 'existing/photo.jpg');
        await writeFile(join(args.dstFs, args.dstRemote), bytes);
      }
      return {};
    },
  });
  const signal = new AbortController().signal;
  await remote.native.uploadFile('existing', 'photo.jpg', 'image/jpeg', file, bytes.length, signal);
  await assert.rejects(remote.native.uploadFile('existing', 'photo.jpg', 'image/jpeg', file, bytes.length, signal), { status: 409 });
  await assert.rejects(remote.native.listFiles('../outside', undefined, signal), { status: 400 });
  const { items } = await remote.native.listFiles('existing', undefined, signal);
  assert.equal(items[0].id, 'existing/photo.jpg');
  assert.deepEqual(await buffer((await remote.native.downloadFile(items[0].id, signal)).stream), bytes);
});

test('MEGA exposes known account errors without leaking rclone error details', async () => {
  const connectionError = (error: string) =>
    rcloneOperationError(Response.json({ error }, { status: 500 }), 'operations/mkdir');
  assert.match((await connectionError("couldn't login: User blocked")).message, /account is blocked/);
  assert.match((await connectionError("couldn't login: Multi-factor authentication required")).message, /two-factor authentication code/);
  const fallback = await connectionError('could not open /fixture/private/folder');
  assert.match(fallback.message, /could not sign in to MEGA or open the selected folder/);
  assert.doesNotMatch(fallback.message, /fixture\/private/);
});

function rcloneFixture() {
  const files = new Map<string, Buffer>();
  const demo = { uploads: 0, downloads: 0, fileDeletes: 0, dropReply: false, ignoreDelete: false };
  const runner: RcloneControl = {
    async call(route, params) {
      switch (route) {
        case 'config/get':
          assert.deepEqual(params, { name: 'test-mega' });
          return { type: 'mega' };
        case 'operations/mkdir':
          assert.deepEqual(params, { fs: config.remote, remote: '' });
          return {};
        case 'operations/about':
          assert.deepEqual(params, { fs: config.remote });
          return { total: 56_000, used: 16_000, free: 40_000 };
        case 'operations/stat': {
          assert.equal(params.fs, config.remote);
          const bytes = files.get(params.fs + '/' + params.remote);
          return { item: bytes ? { IsDir: false, Size: bytes.length } : null };
        }
        case 'operations/deletefile':
          assert.equal(params.fs, config.remote);
          demo.fileDeletes++;
          if (!demo.ignoreDelete) files.delete(params.fs + '/' + params.remote);
          return {};
        case 'operations/copyfile': {
          if (params.dstFs === config.remote) {
            const path = params.dstFs + '/' + params.dstRemote;
            files.set(path, await readFile(join(params.srcFs, params.srcRemote)));
            if (path !== marker) {
              demo.uploads++;
              if (demo.dropReply) throw new Error('Fixture disconnection after saving ciphertext');
            }
          } else {
            assert.equal(params.srcFs, config.remote);
            const path = params.srcFs + '/' + params.srcRemote;
            if (path !== marker) demo.downloads++;
            const bytes = files.get(path);
            assert.ok(bytes);
            await writeFile(join(params.dstFs, params.dstRemote), bytes);
          }
          return {};
        }
        default: throw new Error('Unexpected command');
      }
    },
  };
  return { runner, files, demo };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'blackbox-mega-'));
  const remote = rcloneFixture();
  let drive: Drive | undefined;
  t.after(async () => {
    drive?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const database = openDatabase(directory);
  let binding: string;
  try {
    await connectMega(database, config, remote.runner);
    binding = remote.files.get(marker)!.toString();
  } finally { database.close(); }
  const provider = new MegaStorage(config, binding, remote.runner);
  async function open(offline = false) {
    drive?.close();
    drive = undefined;
    drive = await Drive.open(directory, 1024, 1, offline ? {} : { megaProvider: provider });
    return drive;
  }
  return { ...remote, binding, open };
}

test('MEGA binds the folder, uploads Important ciphertext, and resumes verification after restart', async (t) => {
  const { files, open, demo } = await fixture(t);
  let drive = await open();
  assert.deepEqual(await drive.mega.accountQuota(), { totalBytes: 56_000, usedBytes: 16_000 });
  const plain = Buffer.from('Unique MEGA fixture plaintext');
  const add = (name: string, importance: 'important' | 'backup') =>
    drive.upload({ parentId: ROOT_ID, name, importance }, () => Readable.from([plain]));
  const file = await add('important-name.txt', 'important');
  await add('backup.txt', 'backup');
  const path = drive.storage.path(drive.index.get(file.id).objectKey!);
  assert.deepEqual(file.cloudCopies, []);
  demo.dropReply = true;
  assert.equal(await drive.mega.replicateNext(), true);
  assert.equal(drive.mega.status(), 'retrying');
  const remote = files.get(config.remote + '/' + drive.index.get(file.id).objectKey! + '.bbs')!;
  assert.equal(remote.includes(plain), false);
  assert.deepEqual(remote, await readFile(path));
  drive = await open();
  demo.dropReply = false;
  assert.equal(await drive.mega.replicateNext(Date.now() + 60_000), true);
  assert.equal(demo.uploads, 1);
  const published = drive.index.browse({ parentId: ROOT_ID, sort: 'name', limit: 10, offset: 0 }).items;
  assert.deepEqual(published.find((entry) => entry.id === file.id)?.cloudCopies, ['mega']);
  assert.deepEqual(published.find((entry) => entry.name === 'backup.txt')?.cloudCopies, []);
  await rm(path);
  assert.deepEqual(await buffer((await drive.download(file.id)).stream), plain);
  assert.deepEqual(await readFile(path), remote);
});

test('MEGA permanent deletion checks identity and waits for verified remote removal', async (t) => {
  const { files, binding, open, demo } = await fixture(t);
  let drive = await open();
  const file = await drive.upload({ parentId: ROOT_ID, name: 'remove.txt', importance: 'important' },
    () => Readable.from([Buffer.from('disposable fixture')]));
  const object = drive.index.get(file.id).objectKey!;
  const path = drive.storage.path(object);
  const remote = config.remote + '/' + object + '.bbs';
  await drive.mega.replicateNext();
  drive.index.moveToTrash(file.id);
  drive = await open(true);
  assert.equal(drive.mega.status(), 'reconnect');
  await assert.rejects(drive.purge(file.id), { status: 503 });

  drive = await open();
  files.set(marker, Buffer.from('wrong-marker'));
  await assert.rejects(drive.purge(file.id), { status: 503 });
  assert.equal(demo.fileDeletes, 0);
  assert.ok(files.has(remote));
  files.set(marker, Buffer.from(binding));
  demo.ignoreDelete = true;
  await assert.rejects(drive.purge(file.id), { status: 503 });
  assert.ok(await readFile(path));
  demo.ignoreDelete = false;
  await drive.purge(file.id);
  assert.equal(files.has(remote), false);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});
