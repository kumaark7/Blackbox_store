import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { buildApp } from '../src/api/app.ts';
import type { Connections } from '../src/api/connections.ts';
import { OwnerAuth } from '../src/auth/owner.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/database/open.ts';
import { previewKind, requirePreviewType } from '../src/files/preview.ts';
import { DIGEST_BYTES, FRAME_OVERHEAD, dataEnd } from '../src/storage/format.ts';

const origin = 'https://blackbox.test';
const password = 'fixture-password-only';

test('hosted storage rejects uploads without a connected account before writing file bytes', async (t) => {
  const { app, login, dataDir } = await fixture(t, true, '32', { CLOUD_ONLY_UPLOADS: 'true' });
  const session = (await login()).cookies[0];
  const headers = { cookie: session.name + '=' + session.value, origin };
  const start = await app.inject({ method: 'POST', url: '/api/transfers', headers,
    payload: { name: 'blocked.bin', importance: 'backup', size: 4, fingerprint: '0'.repeat(64) } });
  assert.equal(start.statusCode, 409);
  assert.match(start.body, /Connect TeraBox or Telegram Backup Channel/);
  const raw = await app.inject({ method: 'POST', url: '/api/uploads?name=blocked.bin&importance=important',
    headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('data') });
  assert.equal(raw.statusCode, 409);
  assert.match(raw.body, /Connect MEGA/);
  assert.deepEqual(await readdir(join(dataDir, 'objects')), []);
  const usage = await app.inject({ url: '/api/storage/usage', headers });
  assert.equal(usage.json().cloudOnly, true);
  assert.equal(usage.json().disk, null);
});

test('authenticated resumable uploads save offsets, enforce origin and support empty files', async (t) => {
  const { app, login } = await fixture(t);
  const session = (await login()).cookies[0];
  const cookie = session.name + '=' + session.value;
  const headers = { cookie, origin };
  const bytes = Buffer.from('request body');
  const hash = (input: Buffer) => createHash('sha256').update(input).digest();
  const payload = { name: 'resume.bin', importance: 'backup', size: bytes.length, fingerprint: hash(hash(bytes)).toString('hex') };
  assert.equal((await app.inject('/api/transfers')).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/transfers', headers: { cookie }, payload })).statusCode, 403);
  const start = await app.inject({ method: 'POST', url: '/api/transfers', headers, payload });
  assert.equal(start.statusCode, 200, start.body);
  const { id } = start.json();
  const url = '/api/transfers/' + id;
  const patchHeaders = { ...headers, 'content-type': 'application/octet-stream', 'upload-offset': '0' };
  const patch = await app.inject({ method: 'PATCH', url, headers: patchHeaders, payload: bytes });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal((await app.inject({ url, headers })).json().received, bytes.length);
  assert.equal((await app.inject({ method: 'PATCH', url, headers: patchHeaders, payload: bytes })).statusCode, 409);
  const done = await app.inject({ method: 'POST', url: url + '/complete', headers });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().completed, true);
  const download = await app.inject({ url: '/api/files/' + id + '/download', headers });
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, bytes);
  assert.deepEqual((await app.inject({ url: '/api/transfers', headers })).json().transfers, []);

  const empty = await app.inject({ method: 'POST', url: '/api/transfers', headers,
    payload: { ...payload, name: 'empty.bin', size: 0, fingerprint: hash(Buffer.alloc(0)).toString('hex') } });
  assert.equal(empty.statusCode, 200, empty.body);
  const emptyDone = await app.inject({ method: 'POST', url: '/api/transfers/' + empty.json().id + '/complete', headers });
  assert.equal(emptyDone.statusCode, 200, emptyDone.body);
  assert.equal(emptyDone.json().completed, true);
});

async function fixture(t: TestContext, configureOwner = true, maxUploadBytes = '32', env: NodeJS.ProcessEnv = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'blackbox-api-'));
  let app: Awaited<ReturnType<typeof buildApp>> | undefined = undefined;
  t.after(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const config = loadConfig({ CLOUD_ONLY_UPLOADS: 'false', ...env, DATA_DIR: dataDir, APP_ORIGIN: origin, MAX_UPLOAD_BYTES: maxUploadBytes });
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
  assert.equal((await app.inject('/api/storage')).statusCode, 401);
  assert.equal((await app.inject('/api/storage/usage')).statusCode, 401);
  const deniedUpload = await app.inject({
    method: 'POST', url: '/api/uploads?name=test&importance=backup',
    headers: { origin, 'content-type': 'application/octet-stream' }, payload: Buffer.from('test'),
  });
  assert.equal(deniedUpload.statusCode, 401);
});

test('previews require authentication and recognized content while downloads remain attachments', async (t) => {
  const { app, login } = await fixture(t, true, '128');
  const session = (await login()).cookies[0];
  const headers = { origin, cookie: session.name + '=' + session.value };
  async function upload(name: string, bytes: Buffer) {
    const response = await app.inject({ method: 'POST', url: '/api/uploads?importance=backup&name=' + encodeURIComponent(name),
      headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH9sAAAAASUVORK5CYII=', 'base64');
  const pdf = Buffer.from('%PDF-1.7\n%%EOF');
  const imageEntry = await upload('photo.PNG', png);
  const pdfEntry = await upload('report.pdf', pdf);
  const videoEntry = await upload('clip.mp4', Buffer.from('invalid video fixture'));
  assert.equal(imageEntry.preview, 'image');
  assert.equal(pdfEntry.preview, 'pdf');
  assert.equal(imageEntry.thumbnail, 'image');
  assert.equal(videoEntry.thumbnail, 'video');
  assert.equal(pdfEntry.thumbnail, null);
  assert.equal((await app.inject('/api/files/' + imageEntry.id + '/thumbnail')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/files/' + videoEntry.id + '/thumbnail', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/files/' + pdfEntry.id + '/thumbnail', headers })).statusCode, 404);

  for (const [id, type, bytes] of [[imageEntry.id, 'image/png', png], [pdfEntry.id, 'application/pdf', pdf]] as const) {
    const path = '/api/files/' + id;
    assert.equal((await app.inject(path + '/preview')).statusCode, 401);
    const preview = await app.inject({ url: path + '/preview', headers });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.headers['content-type'], type);
    assert.equal(preview.headers['x-content-type-options'], 'nosniff');
    assert.equal(preview.headers['cache-control'], 'no-store');
    assert.match(String(preview.headers['content-security-policy']), /sandbox/);
    assert.match(String(preview.headers['content-disposition']), /^attachment/);
    assert.deepEqual(preview.rawPayload, bytes);
    const download = await app.inject({ url: path + '/download', headers });
    assert.equal(download.headers['content-type'], 'application/octet-stream');
    assert.deepEqual(download.rawPayload, bytes);
  }

  const html = Buffer.from('<script>alert(1)</script>');
  const disguised = await upload('disguised.pdf', html);
  const rejected = await app.inject({ url: '/api/files/' + disguised.id + '/preview', headers });
  assert.equal(rejected.statusCode, 415);
  assert.match(String(rejected.headers['content-type']), /application\/json/);
  assert.equal(rejected.body.includes(String(html)), false);
  const svg = await upload('interactive.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  assert.equal(svg.preview, null);
  assert.equal((await app.inject({ url: '/api/files/' + svg.id + '/preview', headers })).statusCode, 415);
  assert.equal((await app.inject({ url: '/api/entries/' + imageEntry.id, method: 'DELETE', headers })).statusCode, 204);
  assert.equal((await app.inject({ url: '/api/files/' + imageEntry.id + '/preview', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/files/' + imageEntry.id + '/thumbnail', headers })).statusCode, 404);
  assert.equal(previewKind('big.pdf', 20 * 1024 * 1024 + 1), null);
  assert.throws(() => requirePreviewType('big.pdf', 20 * 1024 * 1024 + 1), { status: 413 });
});

test('login management protects mutations, revokes other sessions, and invalidates all sessions after a password change', async (t) => {
  const { app, login } = await fixture(t);
  const session = (await login()).cookies[0];
  const other = (await login()).cookies[0];
  const headers = { origin, cookie: session.name + '=' + session.value };
  const otherHeaders = { origin, cookie: other.name + '=' + other.value };
  const info = '/api/account/sessions';
  assert.equal((await app.inject(info)).statusCode, 401);
  assert.equal((await app.inject({ url: info, headers })).json().activeSessions, 2);
  assert.equal((await app.inject({ method: 'POST', url: info + '/revoke-others', headers: { cookie: headers.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: info + '/revoke-others', headers })).statusCode, 204);
  assert.equal((await app.inject({ url: info, headers: otherHeaders })).statusCode, 401);
  assert.equal((await app.inject({ url: info, headers })).json().activeSessions, 1);
  const newPassword = 'changed-fixture-password';
  const change = { method: 'POST', url: '/api/account/password', headers } as const;
  assert.equal((await app.inject({ ...change, payload: { current: 'incorrect password', password: newPassword } })).statusCode, 403);
  assert.equal((await app.inject({ ...change, payload: { current: password, password: newPassword } })).statusCode, 204);
  assert.equal((await app.inject({ url: info, headers })).statusCode, 401);
  assert.equal((await login()).statusCode, 401);
  const authenticated = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password: newPassword } });
  assert.equal(authenticated.statusCode, 200);
});

test('Google connects from the site with a session-bound OAuth flow and activates the replica adapter', async (t) => {
  const clientId = 'fixture.apps.googleusercontent.com';
  const clientSecret = 'fixture-secret';
  const { app, login, dataDir } = await fixture(t, true, '32', {
    GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
  });
  const session = (await login()).cookies[0];
  const other = (await login()).cookies[0];
  const headers = { origin, cookie: session.name + '=' + session.value };
  const url = '/api/connections';
  const callback = url + '/google/callback';
  const payload = { provider: 'googleDrive' };
  assert.equal((await app.inject(url)).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, headers: { cookie: headers.cookie }, payload })).statusCode, 403);
  const override = await app.inject({ method: 'POST', url, headers,
    payload: { ...payload, clientId: 'other.apps.googleusercontent.com', clientSecret: 'other-secret' } });
  assert.equal(override.statusCode, 400);
  const start = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(start.statusCode, 202, start.body);
  type ConnectionStatus = ReturnType<Connections['status']>;
  async function observe(status: (response: ConnectionStatus) => boolean) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = (await app.inject({ url, headers })).json<ConnectionStatus>();
      if (status(response)) return response;
      await delay(20);
    }
    assert.fail('Expected connection state was not reached.');
  }
  const consent = await observe((response) => response.flow?.step?.kind === 'google');
  assert.equal(start.json().googleReady, true);
  assert.equal(start.json().flow.step.kind, 'google');
  assert.equal(start.body.includes(clientSecret), false);
  assert.equal(consent.providers.googleDrive, 'off');
  assert.ok(consent.flow?.step?.kind === 'google');
  const authorization = new URL(consent.flow.step.url);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('client_id'), clientId);
  assert.equal(authorization.searchParams.get('redirect_uri'), origin + callback);
  assert.ok(authorization.searchParams.get('scope')?.split(' ').includes('https://www.googleapis.com/auth/drive'));
  const state = authorization.searchParams.get('state');
  const otherFlow = (await app.inject({ url, headers: { cookie: other.name + '=' + other.value } })).json();
  assert.equal(otherFlow.flow, null);
  assert.equal((await app.inject(callback + '?state=' + 'x'.repeat(32) + '&code=ignored')).statusCode, 400);
  const nativeFile = Buffer.from('original contents');
  const mock = t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const endpoint = new URL(input);
    if (endpoint.hostname === 'oauth2.googleapis.com') {
      const params = init.body as URLSearchParams;
      assert.equal(params.get('client_secret'), clientSecret);
      if (params.get('grant_type') === 'refresh_token') {
        assert.equal(params.get('refresh_token'), 'fixture-refresh');
      } else {
        assert.equal(params.get('code'), 'fixture-auth-code');
        assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'),
          authorization.searchParams.get('code_challenge'));
      }
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
    }
    if (endpoint.pathname === '/drive/v3/files') {
      assert.equal(endpoint.searchParams.get('spaces'), 'drive');
      return Response.json({ files: [{ id: 'folder-a', name: 'Existing folder', mimeType: 'application/vnd.google-apps.folder' }] });
    }
    if (endpoint.pathname === '/upload/drive/v3/files') {
      if (init.method === 'POST') {
        assert.deepEqual(JSON.parse(String(init.body)), { name: 'original.txt', parents: ['folder-a'], mimeType: 'text/plain' });
        return new Response(null, { headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test' } });
      }
      assert.equal(init.method, 'PUT');
      assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()), nativeFile);
      return Response.json({ id: 'new-file' });
    }
    assert.equal(endpoint.pathname, '/drive/v3/about');
    return Response.json({ user: { permissionId: 'fixture-account' } });
  });
  const redirect = await app.inject(callback + '?state=' + state + '&code=fixture-auth-code');
  assert.equal(redirect.statusCode, 200);
  assert.match(redirect.body, /url=\/connections/);
  const connected = await observe((response) => response.flow?.status === 'connected');
  assert.equal(connected.providers.googleDrive, 'connected');
  assert.equal(JSON.stringify(connected).includes('fixture-refresh'), false);
  assert.equal(mock.mock.callCount(), 2);
  assert.equal((await app.inject(callback + '?state=' + state + '&code=fixture-auth-code')).statusCode, 400);

  const nativeUrl = '/api/cloud/google';
  assert.equal((await app.inject(nativeUrl + '/files')).statusCode, 401);
  const nativeFiles = await app.inject({ url: nativeUrl + '/files', headers });
  assert.equal(nativeFiles.statusCode, 200, nativeFiles.body);
  assert.ok(nativeFiles.json().items.some((item: { name: string }) => item.name === 'Existing folder'));
  const nativeUpload = await app.inject({ method: 'POST', url: nativeUrl + '/uploads?parent=folder-a&name=original.txt&mime=text%2Fplain',
    headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: nativeFile });
  assert.equal(nativeUpload.statusCode, 204, nativeUpload.body);
  assert.deepEqual(await readdir(join(dataDir, 'objects')), []);
  const providerCalls = mock.mock.callCount();

  const disconnect = { method: 'DELETE', url: url + '/google' } as const;
  assert.equal((await app.inject({ ...disconnect, headers: { origin } })).statusCode, 401);
  assert.equal((await app.inject({ ...disconnect, headers: { ...headers, origin: 'https://other.test' } })).statusCode, 403);
  const disconnected = await app.inject({ ...disconnect, headers });
  assert.equal(disconnected.statusCode, 200, disconnected.body);
  assert.equal(disconnected.json().providers.googleDrive, 'reconnect');
  assert.equal(disconnected.json().googleReady, true);
  assert.equal(disconnected.json().flow, null);
  await assert.rejects(readFile(join(dataDir, 'google-drive.credentials')), { code: 'ENOENT' });
  const db = openDatabase(dataDir);
  try {
    assert.ok(db.prepare('SELECT binding FROM google_drive_account WHERE id = 1').get()?.binding);
  } finally {
    db.close();
  }
  assert.equal(mock.mock.callCount(), providerCalls);
});

test('TeraBox offers private QR and browser consent and remembers the verified application', async (t) => {
  const application = { clientId: 'app-key', clientSecret: 'secret-key', privateSecret: 'private-key', appFolder: '/apps/Blackbox' };
  const { app, login } = await fixture(t, true, '32', {
    TERABOX_CLIENT_ID: application.clientId, TERABOX_CLIENT_SECRET: application.clientSecret,
    TERABOX_PRIVATE_SECRET: application.privateSecret, TERABOX_APP_FOLDER: application.appFolder,
  });
  const session = (await login()).cookies[0];
  const other = (await login()).cookies[0];
  const headers = { origin, cookie: session.name + '=' + session.value };
  const expected = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const payload = { provider: 'terabox' };
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    const endpoint = new URL(input);
    switch (endpoint.pathname) {
      case '/oauth/devicecode':
        return Response.json({ errno: 0, data: { device_code: 'fixture-device-code', qrcode_url: expected.toString('base64'), interval: 1, expires_in: 30 } });
      case '/oauth/gettoken': {
        const form = init.body as FormData;
        assert.equal(form.get('code'), form.get('grant_type') === 'authorization_code' ? 'fixture-web-code' : 'fixture-device-code');
        return Response.json({ errno: 0, data: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 } });
      }
      case '/oauth/tokeninfo':
        return Response.json({ errno: 0, data: { client_id: application.clientId, user_id: '123456', api_domain: 'www.terabox.com',
          upload_domain: 'www.terabox.com' } });
      case '/openapi/api/list':
        assert.equal(endpoint.searchParams.get('dir'), application.appFolder);
        return Response.json({ errno: 0 });
      default: assert.fail('Unexpected provider request');
    }
  });
  const url = '/api/connections';
  const override = await app.inject({ method: 'POST', url, headers, payload: { ...payload, ...application } });
  assert.equal(override.statusCode, 400);
  const start = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(start.statusCode, 202, start.body);
  assert.equal(start.json().teraboxReady, true);
  assert.equal(start.body.includes(application.privateSecret), false);
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return;
      await delay(25);
    }
    assert.fail('Expected QR connection state was not reached.');
  };
  await waitFor(async () => {
    const response = await app.inject({ url: url + '/qr', headers });
    if (response.statusCode === 404) return false;
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^image\/png/);
    assert.deepEqual(response.rawPayload, expected);
    return true;
  });
  assert.equal((await app.inject({ url: url + '/qr', headers: { cookie: other.name + '=' + other.value } })).statusCode, 404);
  await waitFor(async () => (await app.inject({ url, headers })).json().providers.terabox === 'connected');
  assert.equal((await app.inject({ url: url + '/qr', headers })).statusCode, 404);
  const reconnect = await app.inject({ method: 'POST', url, headers, payload: { provider: 'terabox', method: 'web' } });
  assert.equal(reconnect.statusCode, 202, reconnect.body);
  assert.equal(reconnect.json().teraboxReady, true);
  let promptId = '';
  await waitFor(async () => {
    const step = (await app.inject({ url, headers })).json().flow?.step;
    if (step?.kind !== 'teraboxWeb') return false;
    const loginUrl = new URL(step.url);
    assert.equal(loginUrl.origin + loginUrl.pathname, 'https://www.terabox.com/wap/outside/login');
    assert.equal(loginUrl.searchParams.get('clientId'), application.clientId);
    promptId = step.id;
    return true;
  });
  const answer = { method: 'POST', url: url + '/answer', payload: { id: promptId, value: 'fixture-web-code' } } as const;
  assert.equal((await app.inject({ ...answer, headers: { origin, cookie: other.name + '=' + other.value } })).statusCode, 409);
  assert.equal((await app.inject({ ...answer, headers })).statusCode, 204);
  await waitFor(async () => (await app.inject({ url, headers })).json().flow?.status === 'connected');
});

test('Telegram Upload Bot checks the private sender and stores each priority selection once', async (t) => {
  const botToken = '123456:fixture-authentication-token';
  const user = { id: 501234 };
  const chat = { id: user.id, type: 'private' };
  const document = { file_id: 'fixture-id', file_name: 'via-telegram.txt', file_size: 7 };
  const message = { message_id: 14, from: user, chat, document };
  const callback = { from: user, message: { chat }, data: 'important:14' };
  const updates = [
    { update_id: 10, message: { ...message, message_id: 13, from: { id: 99999 }, chat: { id: 99999, type: 'private' } } },
    { update_id: 11, message },
    { update_id: 12, callback_query: { ...callback, id: 'wrong-sender', from: { id: 99999 } } },
    { update_id: 13, callback_query: { ...callback, id: 'owner-selection' } },
    { update_id: 14, callback_query: { ...callback, id: 'repeat-selection' } },
  ];
  const prompts: string[] = [];
  const callbacks: string[] = [];
  let downloaded = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.telegram.org');
    assert.equal(init.redirect, 'error');
    const ok = (result: unknown) => Response.json({ ok: true, result });
    if (url.pathname === '/file/bot' + botToken + '/documents/fixture.txt') {
      downloaded++;
      return new Response('example');
    }
    const body = JSON.parse(String(init.body));
    switch (url.pathname.split('/').at(-1)) {
      case 'getMe': return ok({ id: 123456, username: 'BlackboxFixtureBot', is_bot: true });
      case 'getWebhookInfo': return ok({ url: '' });
      case 'getUpdates':
        await delay(15, undefined, { signal: init.signal ?? undefined });
        return ok(updates.filter((update) => update.update_id >= body.offset));
      case 'sendMessage':
        assert.equal(body.chat_id, String(user.id));
        if (body.reply_markup) assert.equal(body.reply_markup.inline_keyboard.length, 3);
        prompts.push(body.text);
        return ok({});
      case 'answerCallbackQuery':
        callbacks.push(body.callback_query_id);
        return ok(true);
      case 'getFile':
        assert.equal(body.file_id, document.file_id);
        return ok({ file_path: 'documents/fixture.txt', file_size: 7 });
      default: assert.fail('Unexpected Telegram request');
    }
  });
  const { app, login, dataDir } = await fixture(t);
  const session = (await login()).cookies[0];
  const headers = { origin, cookie: session.name + '=' + session.value };
  const response = await app.inject({ method: 'POST', url: '/api/connections', headers,
    payload: { provider: 'telegramBot', botToken, ownerId: String(user.id) } });
  assert.equal(response.statusCode, 202, response.body);
  for (let attempt = 0; attempt < 100 && callbacks.length < 2; attempt++) await delay(25);
  assert.deepEqual(callbacks, ['owner-selection', 'repeat-selection']);
  assert.equal(downloaded, 1);
  assert.deepEqual(prompts, ['Choose a storage priority for via-telegram.txt.', 'Saved via-telegram.txt in My files as Important.']);
  const entries = (await app.inject({ url: '/api/entries', headers })).json().items;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].importance, 'important');
  const download = await app.inject({ url: '/api/files/' + entries[0].id + '/download', headers });
  assert.equal(download.body, 'example');
  const settings = await app.inject({ url: '/api/connections', headers });
  assert.equal(settings.json().providers.telegramBot, 'connected');
  assert.equal(settings.json().providers.telegram, 'off');
  assert.equal(settings.body.includes(botToken), false);
  const saved = await readFile(join(dataDir, 'telegram-upload-bot.credentials'));
  assert.equal(saved.includes(botToken), false);
});

test('storage usage reports the server disk and counts nested Recycle Bin objects once', async (t) => {
  const { app, login } = await fixture(t);
  const session = (await login()).cookies[0];
  const headers = { origin, cookie: session.name + '=' + session.value };
  assert.equal((await app.inject({ url: '/api/storage', headers })).json().telegram, 'off');
  const folder = (await app.inject({ method: 'POST', url: '/api/folders', headers, payload: { name: 'Thumbnails' } })).json();
  const bytes = Buffer.from('local stored bytes');
  const upload = await app.inject({ method: 'POST', url: '/api/uploads?importance=backup&name=one.bin&parentId=' + folder.id,
    headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes });
  assert.equal(upload.statusCode, 201, upload.body);
  const file = upload.json();
  const physicalLength = dataEnd(bytes.length) + DIGEST_BYTES + FRAME_OVERHEAD;
  const usage = async () => {
    const response = await app.inject({ url: '/api/storage/usage', headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    return response.json();
  };
  const initial = await usage();
  assert.equal(initial.trashBytes, 0);
  assert.deepEqual(initial.cloud, { accounts: [], priorities: [
    { importance: 'highly-important', files: 0, bytes: 0 },
    { importance: 'important', files: 0, bytes: 0 },
    { importance: 'backup', files: 0, bytes: 0 },
  ] });
  assert.ok(initial.appBytes > physicalLength);
  assert.ok(initial.disk === null || (initial.disk.availableBytes >= 0 && initial.disk.totalBytes > 0));

  assert.equal((await app.inject({ method: 'DELETE', url: '/api/entries/' + file.id, headers })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/entries/' + folder.id, headers })).statusCode, 204);
  assert.equal((await usage()).trashBytes, physicalLength);
  const purge = await app.inject({ method: 'DELETE', url: '/api/entries/' + folder.id + '/permanent', headers });
  assert.equal(purge.statusCode, 204, purge.body);
  assert.equal((await usage()).trashBytes, 0);
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
  const matchingPriority = await app.inject({ url: '/api/entries?priority=highly-important&limit=1', headers });
  assert.equal(matchingPriority.statusCode, 200, matchingPriority.body);
  assert.deepEqual(matchingPriority.json().items.map(({ id }: { id: string }) => id), [entry.id]);
  assert.equal(matchingPriority.json().nextOffset, null);
  const nestedPriority = await app.inject({ url: '/api/entries?parentId=' + parentId + '&priority=important', headers });
  assert.deepEqual(nestedPriority.json().items, []);
  const missingReplica = await app.inject({ url: '/api/entries?provider=google-drive&priority=highly-important', headers });
  assert.deepEqual(missingReplica.json().items, []);
  assert.equal((await app.inject({ url: '/api/entries?provider=unknown', headers })).statusCode, 400);
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
