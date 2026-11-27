import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Drive } from '../src/files/drive.ts';
import { ROOT_ID } from '../src/files/index.ts';
import type { Importance } from '../src/files/index.ts';
import { readGoogleCredentials, writeGoogleCredentials } from '../src/storage/google-drive-credentials.ts';
import { GoogleDriveStorage } from '../src/storage/google-drive.ts';

const credentials = {
  clientId: 'fixture-client', clientSecret: 'fixture-private-client-secret',
  refreshToken: 'fixture-private-refresh-token', binding: 'a'.repeat(64),
};
const checksum = (data: Buffer) => createHash('sha256').update(data).digest('hex');

test('native Google Drive browsing and upload use normal folders, names, and file bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'blackbox-google-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('plain file contents');
  const path = join(directory, 'contents');
  await writeFile(path, bytes);
  let accepted = false;
  const provider = new GoogleDriveStorage(credentials, async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-access', expires_in: 3600 });
    if (url.pathname.startsWith('/upload/')) {
      if (init?.method === 'POST') {
        assert.deepEqual(JSON.parse(init.body as string),
          { name: 'original.txt', parents: ['folder-a'], mimeType: 'text/plain' });
        return new Response(null, { headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test' } });
      }
      assert.deepEqual(Buffer.from(await new Response(init?.body).arrayBuffer()), bytes);
      accepted = true;
      return Response.json({ id: 'native-file' });
    }
    if (url.pathname === '/drive/v3/files') {
      assert.equal(url.searchParams.get('spaces'), 'drive');
      assert.equal(url.searchParams.get('q'), "'folder-a' in parents and trashed = false");
      assert.equal(url.searchParams.get('pageToken'), 'next');
      return Response.json({ files: [{ id: 'native-file', name: 'original.txt', mimeType: 'text/plain', size: String(bytes.length) }] });
    }
    assert.equal(url.pathname, '/drive/v3/files/native-file');
    return url.searchParams.get('alt') ? new Response(new Uint8Array(bytes))
      : Response.json({ name: 'original.txt', mimeType: 'text/plain', trashed: false });
  });
  const signal = new AbortController().signal;
  await provider.native.uploadFile('folder-a', 'original.txt', 'text/plain', path, bytes.length, signal);
  assert.equal(accepted, true);
  const { items } = await provider.native.listFiles('folder-a', 'next', signal);
  assert.equal(items[0].name, 'original.txt');
  const downloaded = await provider.native.downloadFile('native-file', signal);
  assert.equal(downloaded.name, 'original.txt');
  assert.deepEqual(await buffer(downloaded.stream), bytes);
});

function googleFixture() {
  const files = new Map<string, { content: Buffer; key: string }>();
  const sessions = new Map<string, string>();
  let allocated = 0;
  const requests = {
    uploads: 0, downloads: 0, loseResponse: false, includeChecksum: true, badChecksum: false, badLocation: false,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    assert.equal(init?.redirect, 'error');
    if (url.href === 'https://oauth2.googleapis.com/token') {
      assert.equal(method, 'POST');
      assert.equal((init?.body as URLSearchParams).get('grant_type'), 'refresh_token');
      assert.equal((init?.body as URLSearchParams).get('refresh_token'), credentials.refreshToken);
      return Response.json({ access_token: 'mock-access', expires_in: 3600 });
    }
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(headers.get('authorization'), 'Bearer mock-access');
    if (url.pathname === '/drive/v3/about') {
      assert.equal(url.searchParams.get('fields'), 'storageQuota(limit,usage)');
      return Response.json({ storageQuota: { limit: '40000', usage: '7500' } });
    }
    if (url.pathname === '/drive/v3/files/generateIds') {
      assert.equal(url.searchParams.get('space'), 'appDataFolder');
      return Response.json({ ids: ['file-' + ++allocated] });
    }
    if (url.pathname === '/upload/drive/v3/files') {
      if (method === 'POST') {
        const metadata = JSON.parse(init?.body as string);
        assert.equal(url.searchParams.get('uploadType'), 'resumable');
        assert.deepEqual(metadata.parents, ['appDataFolder']);
        assert.equal(metadata.name, metadata.appProperties.blackboxObject + '.bbs');
        if (files.has(metadata.id)) return new Response(null, { status: 409 });
        sessions.set(metadata.id, metadata.appProperties.blackboxObject);
        const origin = requests.badLocation ? 'https://unexpected.example' : url.origin;
        return new Response(null, { headers: { Location: origin + url.pathname + '?upload_id=' + metadata.id } });
      }
      assert.equal(method, 'PUT');
      const id = url.searchParams.get('upload_id')!;
      const key = sessions.get(id)!;
      assert.ok(key);
      const content = Buffer.from(await new Response(init?.body).arrayBuffer());
      assert.equal(headers.get('content-length'), String(content.length));
      assert.equal(headers.get('content-range'), `bytes 0-${content.length - 1}/${content.length}`);
      files.set(id, { content, key });
      requests.uploads++;
      if (requests.loseResponse) throw new TypeError('Mock interrupted response');
      return Response.json({ id });
    }
    assert.match(url.pathname, /^\/drive\/v3\/files\/file-\d+$/);
    const id = url.pathname.split('/').at(-1)!;
    const file = files.get(id);
    if (!file) return new Response(null, { status: 404 });
    if (method === 'DELETE') {
      files.delete(id);
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.get('alt') === 'media') {
      requests.downloads++;
      return new Response(new Uint8Array(file.content));
    }
    return Response.json({ id, appProperties: { blackboxObject: file.key }, size: String(file.content.length),
      sha256Checksum: requests.includeChecksum ? requests.badChecksum ? '0'.repeat(64) : checksum(file.content) : undefined });
  };
  return { provider: new GoogleDriveStorage(credentials, fetcher), files, requests };
}

test('Google Drive reports account quota and usage across services', async () => {
  const { provider } = googleFixture();
  assert.deepEqual(await provider.quota(new AbortController().signal), { totalBytes: 40_000, usedBytes: 7_500 });
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'blackbox-google-'));
  let drive: Drive | null = null;
  t.after(async () => {
    drive?.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, async open(googleProvider?: GoogleDriveStorage) {
    drive?.close();
    drive = null;
    drive = await Drive.open(directory, 1024, 1, { googleProvider });
    return drive;
  } };
}

const add = (drive: Drive, name: string, data: Buffer, importance: Importance) =>
  drive.upload({ parentId: ROOT_ID, name, importance }, () => Readable.from([data]));
const list = (drive: Drive) => drive.index.browse({ parentId: ROOT_ID, limit: 10, offset: 0, sort: 'name' }).items;

test('Google Drive copies only Highly Important encrypted objects and repairs a corrupt local copy', async (t) => {
  const { provider, files, requests } = googleFixture();
  const { open } = await fixture(t);
  const drive = await open(provider);
  const bytes = Buffer.from('unique file plaintext and name');
  const file = await add(drive, 'private-name.txt', bytes, 'highly-important');
  await add(drive, 'local.txt', bytes, 'important');
  assert.equal(file.protection, 'degraded');
  requests.includeChecksum = false;
  assert.equal(await drive.googleDrive.replicateNext(), true);
  assert.equal(await drive.googleDrive.replicateNext(), false);
  assert.equal(files.size, 1);
  assert.equal(requests.downloads, 1, 'verify through media when Google omits SHA-256');
  const [remote] = files.values();
  const key = drive.index.get(file.id).objectKey!;
  const path = drive.storage.path(key);
  assert.equal(remote.key, key);
  assert.equal(remote.content.includes(bytes), false);
  assert.equal(remote.content.includes(Buffer.from(file.name)), false);
  assert.deepEqual(await readFile(path), remote.content);
  assert.equal(list(drive).find((item) => item.id === file.id)?.protection, 'replicated');

  const corrupt = Buffer.from(remote.content);
  corrupt[48] ^= 1;
  await writeFile(path, corrupt);
  assert.deepEqual(await buffer((await drive.download(file.id)).stream), bytes);
  assert.deepEqual(await readFile(path), remote.content);
  assert.equal(requests.downloads, 2);
  await rm(path);
  assert.deepEqual(await buffer((await drive.download(file.id)).stream), bytes);
  assert.equal(requests.downloads, 3);

  files.clear();
  assert.equal(await drive.googleDrive.replicateNext(Date.now() + 25 * 60 * 60_000), true);
  assert.deepEqual([...files.keys()], ['file-2']);
});

test('a lost response reuses the Drive ID after restart, and permanent deletion waits for Drive', async (t) => {
  const { provider, files, requests } = googleFixture();
  const { open } = await fixture(t);
  let drive = await open(provider);
  const bytes = Buffer.from('upload once');
  const file = await add(drive, 'retriable.txt', bytes, 'highly-important');
  requests.loseResponse = true;
  await drive.googleDrive.replicateNext();
  assert.equal(drive.googleDrive.status(), 'retrying');
  assert.equal(list(drive)[0].protection, 'degraded');
  assert.equal(files.size, 1);
  drive = await open(provider);
  requests.loseResponse = false;
  await drive.googleDrive.replicateNext(Date.now() + 60_000);
  assert.equal(requests.uploads, 1);
  assert.equal(list(drive)[0].protection, 'replicated');
  drive.index.moveToTrash(file.id);
  drive = await open();
  assert.equal(drive.googleDrive.status(), 'reconnect');
  await assert.rejects(drive.purge(file.id), { status: 503 });
  assert.equal(files.size, 1);
  assert.ok(await readFile(drive.storage.path([...files.values()][0].key)));
  drive = await open(provider);
  await drive.purge(file.id);
  assert.equal(files.size, 0);
  assert.equal(drive.index.browse({ parentId: ROOT_ID, limit: 10, offset: 0, sort: 'name', trash: true }).items.length, 0);
});

test('the provider rejects untrusted upload URLs and incorrect remote checksums', async (t) => {
  const { provider, requests } = googleFixture();
  const { open } = await fixture(t);
  const drive = await open(provider);
  await add(drive, 'sensitive.txt', Buffer.from('fixture data'), 'highly-important');
  requests.badLocation = true;
  await drive.googleDrive.replicateNext();
  assert.equal(requests.uploads, 0);
  assert.equal(list(drive)[0].protection, 'degraded');
  requests.badLocation = false;
  requests.badChecksum = true;
  await drive.googleDrive.replicateNext(Date.now() + 60_000);
  assert.equal(requests.uploads, 1);
  assert.equal(list(drive)[0].protection, 'degraded');
});

test('saved Google credentials are encrypted and a different account binding is rejected', async (t) => {
  const { directory, open } = await fixture(t);
  await open();
  const master = await readFile(join(directory, 'storage.key'));
  await writeGoogleCredentials(directory, master, credentials);
  const path = join(directory, 'google-drive.credentials');
  assert.equal((await readFile(path)).includes(Buffer.from(credentials.refreshToken)), false);
  assert.deepEqual(await readGoogleCredentials(directory, master), credentials);
  assert.equal((await open()).googleDrive.status(), 'connected');
  await writeGoogleCredentials(directory, master, { ...credentials, binding: 'b'.repeat(64) });
  assert.equal((await open()).googleDrive.status(), 'reconnect');
});

test('overlapping provider repairs share one local repair slot', async (t) => {
  const { open } = await fixture(t);
  const drive = await open();
  const original = Buffer.from('parallel recovery fixture');
  const file = await add(drive, 'recover.txt', original, 'highly-important');
  const row = drive.index.get(file.id);
  const object = { key: row.objectKey!, size: row.size!, sha256: row.sha256!, format: row.storageFormat };
  const path = drive.storage.path(object.key);
  const stored = await readFile(path);
  await rm(path);
  const incoming = new Readable({ read() {} });
  const signal = new AbortController().signal;
  const first = drive.storage.recoverEncrypted(object, async () => incoming, signal);
  try {
    await assert.rejects(drive.storage.recoverEncrypted(object, async () => Readable.from([stored]), signal), { status: 409 });
  } finally {
    incoming.push(stored);
    incoming.push(null);
    await first;
  }
  assert.deepEqual(await buffer((await drive.download(file.id)).stream), original);
});
