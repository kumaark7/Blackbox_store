import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { buildApp } from '../src/api/app.ts';
import { OwnerAuth } from '../src/auth/owner.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/database/open.ts';
import { TeraboxCleanupRequired } from '../src/errors.ts';
import { Drive } from '../src/files/drive.ts';
import { ROOT_ID } from '../src/files/index.ts';
import type { CloudProvider } from '../src/storage/adapter.ts';
import { DIGEST_BYTES, FRAME_OVERHEAD, dataEnd } from '../src/storage/format.ts';
import { loadStorageKey } from '../src/storage/key.ts';
import { bindTerabox, exchangeTeraboxDevice, readTeraboxAuth, TeraboxAuth } from '../src/storage/terabox-auth.ts';
import { TeraboxStorage } from '../src/storage/terabox.ts';
import { cloudUsage } from '../src/storage/usage.ts';

const application = { clientId: 'test-app', clientSecret: 'test-secret', privateSecret: 'test-private', appFolder: '/From：Other Applications/Blackbox-' };
const tokens = { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: Date.now() + 3_600_000 };
const accountId = '9007199254740993';
const fileId = '18446744073709551615';
const binding = createHash('sha256').update(JSON.stringify([application.clientId, accountId, application.appFolder])).digest('hex');

function teraboxFixture() {
  const files = new Map<string, Buffer>();
  const trash = new Map<string, Buffer>();
  const stats = { created: 0, parts: 0, quotaReads: 0, failQuota: false, dropCreateReply: false, badDownloadHost: false };
  const uploads = new Map<string, { hashes: string[]; blocks: Buffer[] }>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const params = url.searchParams;
    const body = init?.body;
    if (url.pathname === '/oauth/tokeninfo') {
      assert.equal(url.origin, 'https://www.terabox.com');
      assert.ok(body instanceof FormData);
      assert.equal(body.get('access_token'), tokens.accessToken);
      return new Response(`{"errno":0,"data":{"client_id":"test-app","user_id":${accountId},"api_domain":"api.terabox.com","upload_domain":"c-jp.terabox.com"}}`);
    }
    assert.equal(params.get('access_tokens'), tokens.accessToken);
    assert.equal(init?.redirect, 'error');
    if (url.pathname === '/rest/2.0/pcs/superfile2') {
      assert.equal(url.origin, 'https://c-jp.terabox.com');
      assert.equal(params.get('app_id'), '250528');
      assert.equal(params.get('method'), 'upload');
      const path = params.get('path')!;
      const upload = uploads.get(path)!;
      assert.ok(body instanceof FormData);
      const file = body.get('file');
      assert.ok(file instanceof Blob);
      const index = Number(params.get('partseq'));
      const bytes = Buffer.from(await file.arrayBuffer());
      if (upload.hashes.length > 1) assert.ok(bytes.length > 4 * 1024 * 1024);
      const md5 = createHash('md5').update(bytes).digest('hex');
      assert.equal(md5, upload.hashes[index]);
      upload.blocks[index] = bytes;
      stats.parts++;
      return Response.json({ md5, partseq: index, uploadid: 'test-id' });
    }
    if (url.hostname === 'd.terabox.com') {
      assert.equal(params.get('sign'), 's=');
      const bytes = [...files.values()][0];
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Length': String(bytes.length) } });
    }
    assert.equal(url.origin, 'https://api.terabox.com');
    switch (url.pathname) {
      case '/openapi/api/list':
        assert.equal(params.get('dir'), application.appFolder);
        return Response.json({ errno: 0, list: [] });
      case '/openapi/api/quota':
        assert.equal(init?.method, 'GET');
        stats.quotaReads++;
        return Response.json(stats.failQuota ? { errno: 99 } : { errno: 0, total: 60_000, used: 24_000 });
      case '/openapi/api/precreate': {
        assert.ok(body instanceof URLSearchParams);
        assert.equal(body.get('autoinit'), '1');
        const path = body.get('path')!;
        assert.ok(path.startsWith(application.appFolder + '/blackbox-'));
        assert.ok(path.endsWith('.bbs'));
        const hashes = JSON.parse(body.get('block_list')!) as string[];
        uploads.set(path, { hashes, blocks: [] });
        return Response.json({ errno: 0, return_type: 1, uploadid: 'test-id', block_list: hashes.map((_, index) => index) });
      }
      case '/openapi/api/create': {
        assert.ok(body instanceof URLSearchParams);
        assert.equal(body.get('rtype'), '0');
        const path = body.get('path')!;
        const upload = uploads.get(path)!;
        assert.equal(body.get('block_list'), JSON.stringify(upload.hashes));
        assert.equal(body.get('uploadid'), 'test-id');
        assert.equal(files.has(path), false);
        const bytes = Buffer.concat(upload.blocks);
        assert.equal(body.get('size'), String(bytes.length));
        files.set(path, bytes);
        stats.created++;
        if (stats.dropCreateReply) throw new Error('Connection lost after create');
        return Response.json({ errno: 0, path });
      }
      case '/openapi/api/filemetas': {
        const [path] = JSON.parse(params.get('target')!) as [string];
        const bytes = files.get(path);
        return bytes ? new Response(`{"errno":0,"list":[{"path":${JSON.stringify(path)},"isdir":0,"fs_id":${fileId},"size":${bytes.length}}]}`)
          : Response.json({ errno: -9 });
      }
      case '/openapi/api/download':
        assert.equal(params.get('fidlist'), '[' + fileId + ']');
        assert.equal(params.get('type'), 'dlink');
        return Response.json({ errno: 0, dlink: [{ fs_id: fileId,
          dlink: stats.badDownloadHost ? 'https://terabox.com.example.test/ciphertext?sign=s%3D' : 'https://d.terabox.com/ciphertext?sign=s%3D' }] });
      case '/openapi/api/filemanager': {
        assert.ok(body instanceof URLSearchParams);
        assert.equal(params.get('opera'), 'delete');
        assert.equal(params.get('async'), '0');
        const [path] = JSON.parse(body.get('filelist')!) as [string];
        trash.set(path, files.get(path)!);
        files.delete(path);
        return Response.json({ errno: 0, info: [{ errno: 0, path }] });
      }
      default: throw new Error('Unexpected TeraBox API endpoint.');
    }
  };
  return { fetcher, files, trash, stats };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'blackbox-terabox-test-'));
  const remote = teraboxFixture();
  t.mock.method(globalThis, 'fetch', remote.fetcher);
  let drive: Drive | undefined;
  const closeDrive = () => {
    drive?.close();
    drive = undefined;
  };
  t.after(async () => {
    closeDrive();
    await rm(directory, { recursive: true, force: true });
  });
  const database = openDatabase(directory);
  try {
    const key = await loadStorageKey(directory, database);
    await bindTerabox(database, directory, key, application, tokens, new AbortController().signal, remote.fetcher);
    assert.ok(await readTeraboxAuth(database, directory, key));
    assert.equal((await readFile(join(directory, 'terabox.credentials'))).includes(application.clientSecret), false);
  } finally {
    database.close();
  }
  async function open(telegramProvider?: CloudProvider) {
    closeDrive();
    drive = await Drive.open(directory, 20 * 1024 * 1024, 1, { telegramProvider });
    return drive;
  }
  return { ...remote, open, closeDrive, directory };
}

test('Cloud storage reports quota and counts files once across accounts while keeping tracked copies per account', async (t) => {
  const { open, stats } = await fixture(t);
  const unused = async () => { throw new Error('The usage dashboard does not transfer replicas.'); };
  const telegramProvider = { allocate: unused, upload: unused, verify: unused, download: unused, delete: unused };
  let drive = await open(telegramProvider);
  const folder = drive.index.createFolder(ROOT_ID, 'Discarded');
  const add = (name: string, contents: string, parentId = ROOT_ID) =>
    drive.upload({ parentId, name, importance: 'backup' }, () => Readable.from([Buffer.from(contents)]));
  const shared = await add('both.bin', 'shared');
  const telegramOnly = await add('empty.bin', '');
  const trashed = await add('deleted.bin', 'trash', folder.id);
  await add('local.bin', 'local');
  drive.index.moveToTrash(folder.id);
  const db = drive.index.db;
  const teraboxRow = db.prepare('INSERT INTO terabox_replicas (node_id, verified) VALUES (?, 1)');
  const telegramRow = db.prepare('INSERT INTO telegram_replicas (node_id, verified) VALUES (?, 1)');
  teraboxRow.run(shared.id);
  teraboxRow.run(trashed.id);
  telegramRow.run(shared.id);
  telegramRow.run(telegramOnly.id);
  const ciphertext = (size: number) => dataEnd(size) + DIGEST_BYTES + FRAME_OVERHEAD;
  const [usage, cached] = await Promise.all([cloudUsage(drive), cloudUsage(drive)]);
  assert.deepEqual(usage, cached);
  assert.equal(stats.quotaReads, 1);
  assert.deepEqual(usage.accounts, [
    { id: 'terabox', status: 'connected', quota: { totalBytes: 60_000, usedBytes: 24_000 },
      tracked: { files: 2, bytes: ciphertext(6) + ciphertext(5) } },
    { id: 'telegram', status: 'connected', quota: null, tracked: { files: 2, bytes: ciphertext(6) + ciphertext(0) } },
  ]);
  assert.deepEqual(usage.priorities, [
    { importance: 'highly-important', files: 0, bytes: 0 },
    { importance: 'important', files: 0, bytes: 0 },
    { importance: 'backup', files: 2, bytes: 6 },
  ]);
  stats.failQuota = true;
  drive = await open(telegramProvider);
  const failed = await cloudUsage(drive);
  assert.equal(failed.accounts[0].quota, null);
  assert.deepEqual(failed.accounts[0].tracked, usage.accounts[0].tracked);
  assert.deepEqual(failed.priorities, usage.priorities);
});

test('TeraBox uploads only Backup ciphertext, resists a lost create reply, and repairs from cloud', async (t) => {
  const { open, files, stats } = await fixture(t);
  let drive = await open();
  assert.equal(drive.terabox.status(), 'connected');
  const plain = Buffer.alloc(16 * 1024 * 1024, 35);
  const backup = await drive.upload({ parentId: ROOT_ID, name: 'private-name.zip', importance: 'backup' }, () => Readable.from([plain]));
  await drive.upload({ parentId: ROOT_ID, name: 'important.txt', importance: 'important' }, () => Readable.from(['small']));
  const local = drive.storage.path(drive.index.get(backup.id).objectKey!);
  stats.dropCreateReply = true;
  assert.equal(await drive.terabox.replicateNext(), true);
  assert.equal(drive.terabox.status(), 'retrying');
  assert.equal(stats.parts, 2);
  assert.equal(files.size, 1);
  const [remote, ciphertext] = [...files.entries()][0];
  assert.equal(remote.includes(backup.name), false);
  assert.equal(ciphertext.includes(plain.subarray(0, 64)), false);
  assert.deepEqual(ciphertext, await readFile(local));
  drive = await open();
  const later = Date.now() + 60_000;
  assert.equal(await drive.terabox.replicateNext(later), true);
  assert.equal(await drive.terabox.replicateNext(later), false);
  assert.equal(stats.created, 1);
  const entries = drive.index.browse({ parentId: ROOT_ID, sort: 'name', limit: 10, offset: 0 }).items;
  assert.deepEqual(entries.find((entry) => entry.id === backup.id)?.cloudCopies, ['terabox']);
  assert.deepEqual(entries.find((entry) => entry.name === 'important.txt')?.cloudCopies, []);
  await rm(local);
  stats.badDownloadHost = true;
  await assert.rejects(drive.download(backup.id), { status: 503 });
  stats.badDownloadHost = false;
  assert.deepEqual(await buffer((await drive.download(backup.id)).stream), plain);
  assert.deepEqual(await readFile(local), ciphertext);
});

test('TeraBox purge preserves local data until the owner confirms Recycle Bin cleanup', async (t) => {
  const { open, files, trash, closeDrive, directory } = await fixture(t);
  let drive = await open();
  const folder = drive.index.createFolder(ROOT_ID, 'Backup folder');
  const file = await drive.upload({ parentId: folder.id, name: 'disposable.txt', importance: 'backup' }, () => Readable.from(['temporary']));
  const local = drive.storage.path(drive.index.get(file.id).objectKey!);
  await drive.terabox.replicateNext();
  const [remote, ciphertext] = [...files.entries()][0];
  drive.index.moveToTrash(folder.id);
  let confirmation = '';
  const needsConfirmation = (error: unknown) => {
    assert.ok(error instanceof TeraboxCleanupRequired);
    assert.equal(error.status, 409);
    assert.deepEqual(error.paths, [remote]);
    confirmation = error.confirmation;
    return true;
  };
  await assert.rejects(drive.purge(folder.id), needsConfirmation);
  assert.equal(files.has(remote), false);
  assert.deepEqual(trash.get(remote), ciphertext);
  assert.deepEqual(await readFile(local), ciphertext);
  drive = await open();
  await assert.rejects(drive.purge(folder.id, '0'.repeat(64)), needsConfirmation);
  files.set(remote, ciphertext);
  await assert.rejects(drive.purge(folder.id, confirmation), needsConfirmation);
  assert.deepEqual(await readFile(local), ciphertext);
  const origin = 'https://blackbox.test';
  const password = 'fixture-owner-password';
  const config = loadConfig({ DATA_DIR: directory, APP_ORIGIN: origin });
  await new OwnerAuth(drive.index.db, config.sessionSeconds).createOwner(password);
  closeDrive();
  const app = await buildApp(config, { logger: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password } });
    assert.equal(login.statusCode, 200);
    const session = login.cookies[0];
    const headers = { origin, cookie: session.name + '=' + session.value };
    assert.equal((await app.inject({ url: '/api/storage', headers })).json().terabox, 'connected');
    const request = { method: 'DELETE', url: '/api/entries/' + folder.id + '/permanent', headers } as const;
    const pending = await app.inject(request);
    assert.equal(pending.statusCode, 409, pending.body);
    assert.deepEqual(pending.json().teraboxCleanup, { paths: [remote], confirmation });
    assert.equal((await app.inject({ ...request, payload: { teraboxConfirmation: 'invalid' } })).statusCode, 400);
    trash.delete(remote);
    const finished = await app.inject({ ...request, payload: { teraboxConfirmation: confirmation } });
    assert.equal(finished.statusCode, 204, finished.body);
  } finally {
    await app.close();
  }
  await assert.rejects(readFile(local), { code: 'ENOENT' });
});

test('TeraBox device exchange uses the documented signature and refresh rotation persists before use', async () => {
  const signal = new AbortController().signal;
  const exchanged = await exchangeTeraboxDevice(application, 'fixture-code', signal, async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/oauth/gettoken');
    const form = init?.body;
    assert.ok(form instanceof FormData);
    const signature = createHash('md5').update(`test-app_${form.get('timestamp')}_test-secret_test-private`).digest('hex');
    assert.equal(form.get('sign'), signature);
    assert.equal(form.get('grant_type'), 'device_code');
    assert.equal(form.get('code'), 'fixture-code');
    return Response.json({ errno: 400001 });
  });
  assert.equal(exchanged, null);
  let refreshes = 0;
  let saved = '';
  let shouldFailToSave = true;
  const auth = new TeraboxAuth({ ...application, ...tokens, binding, expiresAt: 0 }, async (credentials) => {
    if (shouldFailToSave) throw new Error('fixture disk failure');
    saved = credentials.refreshToken;
  }, async (input, init) => {
    const form = init?.body;
    assert.ok(form instanceof FormData);
    if (new URL(String(input)).pathname === '/oauth/refreshtoken') {
      refreshes++;
      assert.equal(form.get('refresh_token'), tokens.refreshToken);
      return Response.json({ errno: 0, data: { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 } });
    }
    assert.equal(form.get('access_token'), 'rotated-access');
    assert.equal(saved, 'rotated-refresh');
    return new Response(`{"errno":0,"data":{"client_id":"test-app","user_id":${accountId},"api_domain":"api.terabox.com","upload_domain":"c-jp.terabox.com"}}`);
  });
  await assert.rejects(auth.session(signal), /disk failure/);
  shouldFailToSave = false;
  const [first, second] = await Promise.all([auth.session(signal), auth.session(signal)]);
  assert.equal(first, second);
  assert.equal(first.accessToken, 'rotated-access');
  assert.equal(refreshes, 1);
  const badAuth = new TeraboxAuth({ ...application, ...tokens, binding }, async () => {}, async () =>
    new Response(`{"errno":0,"data":{"client_id":"test-app","user_id":${accountId},"api_domain":"api.terabox.com.invalid","upload_domain":"c-jp.terabox.com"}}`));
  const provider = new TeraboxStorage(badAuth);
  await assert.rejects(provider.download(await provider.allocate(signal), signal, 1), { status: 503 });
});
