import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { buildApp } from '../src/api/app.ts';
import { OwnerAuth } from '../src/auth/owner.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/database/open.ts';

const origin = 'https://blackbox.test';
const password = 'fixture-password-only';

async function fixture(t: TestContext, configureOwner = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'blackbox-api-'));
  let app: Awaited<ReturnType<typeof buildApp>> | undefined = undefined;
  t.after(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const config = loadConfig({ DATA_DIR: dataDir, APP_ORIGIN: origin, MAX_UPLOAD_BYTES: '32' });
  const db = openDatabase(dataDir);
  try {
    if (configureOwner) {
      const auth = new OwnerAuth(db, config.sessionSeconds);
      await auth.createOwner(password);
      await assert.rejects(auth.createOwner(password), { status: 409 });
      const row = db.prepare('SELECT password_hash FROM owner').get();
      assert.match(String(row?.password_hash), /^\$argon2id\$/);
    }
  } finally {
    db.close();
  }
  const ready = await buildApp(config, { logger: false });
  app = ready;
  const login = () => ready.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password } });
  return { app: ready, login, dataDir };
}

test('first-run status and authenticated endpoints reject unauthenticated requests', async (t) => {
  const { app, login } = await fixture(t, false);
  const status = await app.inject('/api/auth/status');
  assert.deepEqual(status.json(), { authenticated: false, configured: false });
  assert.equal((await login()).statusCode, 503);
  assert.equal((await app.inject('/api/entries')).statusCode, 401);
  const deniedUpload = await app.inject({
    method: 'POST', url: '/api/uploads?name=test&importance=backup',
    headers: { origin, 'content-type': 'application/octet-stream' }, payload: Buffer.from('test'),
  });
  assert.equal(deniedUpload.statusCode, 401);
});

test('owner session has secure cookie attributes, CSRF checks, and server-side revocation', async (t) => {
  const { app, login, dataDir } = await fixture(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } })).statusCode, 403);
  const response = await login();
  assert.equal(response.statusCode, 200, response.body);
  const setCookie = String(response.headers['set-cookie']);
  assert.match(setCookie, /^__Host-blackbox_session=/);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/i);
  const cookie = setCookie.split(';')[0];
  const db = openDatabase(dataDir);
  try {
    const row = db.prepare('SELECT token_hash FROM sessions').get();
    assert.match(String(row?.token_hash), /^[a-f0-9]{64}$/);
    assert.equal(setCookie.includes(String(row?.token_hash)), false);
  } finally {
    db.close();
  }
  assert.equal((await app.inject({ url: '/api/entries', headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/folders', headers: { cookie, origin: 'https://different.test' }, payload: { name: 'Denied' },
  })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin } })).statusCode, 204);
  assert.equal((await app.inject({ url: '/api/entries', headers: { cookie } })).statusCode, 401);
});

test('folder, binary upload, download, edit, trash and restore work over HTTP', async (t) => {
  const { app, login } = await fixture(t);
  const response = await login();
  assert.equal(response.statusCode, 200, response.body);
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const headers = { cookie, origin };
  const folder = await app.inject({ method: 'POST', url: '/api/folders', headers, payload: { name: 'Docs' } });
  assert.equal(folder.statusCode, 201, folder.body);
  const parentId = String(folder.json().id);

  const payload = Buffer.from([100, 255, 4, 12, 0]);
  const binary = { ...headers, 'content-type': 'application/octet-stream' };
  const upload = await app.inject({
    method: 'POST', url: '/api/uploads?name=caf%C3%A9.bin&importance=highly-important&parentId=' + parentId,
    headers: binary, payload,
  });
  assert.equal(upload.statusCode, 201, upload.body);
  const entry = upload.json();
  assert.equal(entry.size, payload.length);
  assert.equal(entry.protection, 'degraded');
  const downloadUrl = '/api/files/' + entry.id + '/download';

  assert.equal((await app.inject(downloadUrl)).statusCode, 401);
  const downloaded = await app.inject({ url: downloadUrl, headers: { cookie } });
  assert.equal(downloaded.statusCode, 200, downloaded.body);
  assert.deepEqual(downloaded.rawPayload, payload);
  assert.match(String(downloaded.headers['content-disposition']), /attachment.*caf%C3%A9.bin/);
  assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');

  const itemUrl = '/api/entries/' + entry.id;
  const patched = await app.inject({
    method: 'PATCH', url: itemUrl, headers, payload: { name: 'new.bin', importance: 'important' },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().name, 'new.bin');
  assert.equal((await app.inject({ method: 'DELETE', url: itemUrl, headers })).statusCode, 204);
  assert.equal((await app.inject({ url: downloadUrl, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: itemUrl + '/restore', headers })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: downloadUrl, headers })).rawPayload, payload);

  const tooLarge = await app.inject({
    method: 'POST', url: '/api/uploads?name=too-big&importance=backup', headers: binary, payload: Buffer.alloc(33),
  });
  assert.equal(tooLarge.statusCode, 413, tooLarge.body);
});

test('login is throttled across client IP addresses', async (t) => {
  const { app } = await fixture(t);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin }, remoteAddress: '127.0.0.' + attempt,
      payload: { password: 'incorrect-password' },
    });
    assert.equal(response.statusCode, attempt <= 5 ? 401 : 429, response.body);
  }
});

test('only the signed-in owner can permanently delete a trashed file', async (t) => {
  const { app, login, dataDir } = await fixture(t);
  const session = await login();
  assert.equal(session.statusCode, 200);
  const cookie = String(session.headers['set-cookie']).split(';')[0];
  const headers = { cookie, origin };
  const upload = await app.inject({
    method: 'POST', url: '/api/uploads?name=discard.bin&importance=backup',
    headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('discard'),
  });
  assert.equal(upload.statusCode, 201, upload.body);
  const item = '/api/entries/' + upload.json().id;
  const permanent = item + '/permanent';
  assert.equal((await app.inject({ method: 'DELETE', url: permanent, headers: { origin } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: permanent, headers: { cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: permanent, headers })).statusCode, 404);
  assert.equal((await readdir(join(dataDir, 'objects'))).length, 1);

  assert.equal((await app.inject({ method: 'DELETE', url: item, headers })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: permanent, headers })).statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: item + '/restore', headers })).statusCode, 404);
  const trash = await app.inject({ url: '/api/entries?trash=1', headers });
  assert.deepEqual(trash.json().items, []);
  assert.deepEqual(await readdir(join(dataDir, 'objects')), []);
});
