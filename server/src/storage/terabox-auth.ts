import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DriveError } from '../errors.ts';
import { readSealedJson, writeSealedJson } from './sealed-json.ts';

const issuer = 'https://www.terabox.com';
const credentialId = '00000000-0000-0000-0000-000000000002';
const credentialPath = (dataDir: string) => join(dataDir, 'terabox.credentials');

export type TeraboxApplication = { clientId: string; clientSecret: string; privateSecret: string; appFolder: string };
export type TeraboxTokens = { accessToken: string; refreshToken: string; expiresAt: number };
export type TeraboxCredentials = TeraboxApplication & TeraboxTokens & { binding: string };
type Session = { api: string; upload: string; accessToken: string };

export function unavailableTerabox() {
  return new DriveError(503, 'TeraBox could not complete the operation. Check its account connection and retry.');
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailableTerabox();
  return value as Record<string, unknown>;
}

export function teraboxIdentifier(value: unknown) {
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  throw unavailableTerabox();
}

export function parseProviderJson(body: string): Record<string, unknown> {
  const parse = JSON.parse as (json: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
  return record(parse(body, (key, value, context) =>
    (key === 'fs_id' || key === 'user_id') && typeof value === 'number' ? context?.source ?? value : value));
}

export function trustedTeraboxUrl(value: string) {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !['terabox.com', 'terabox.app'].some((domain) => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
    throw new DriveError(503, 'TeraBox returned an unrecognized service address.');
  }
  return url;
}

function regionalOrigin(value: unknown) {
  if (typeof value !== 'string') throw unavailableTerabox();
  const url = trustedTeraboxUrl(value.startsWith('https://') ? value : 'https://' + value);
  if (url.pathname !== '/' || url.search) throw unavailableTerabox();
  return url.origin;
}

export async function jsonFromTerabox(fetcher: typeof fetch, url: URL, signal: AbortSignal, body?: FormData | URLSearchParams) {
  try {
    const response = await fetcher(url, { method: body ? 'POST' : 'GET', body, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(body instanceof FormData && body.has('file') ? 180_000 : 30_000)]) });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailableTerabox();
    }
    return parseProviderJson(await response.text());
  } catch {
    throw unavailableTerabox();
  }
}

function succeeded(result: Record<string, unknown>) {
  if (result.errno !== 0) throw unavailableTerabox();
  return record(result.data);
}

const shortString = (value: unknown, limit = 4096): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= limit && !/\p{Cc}/u.test(value);

export function teraboxApplication(input: unknown): TeraboxApplication {
  const fields = record(input);
  const { clientId, clientSecret, privateSecret, appFolder } = fields;
  if (!shortString(clientId, 256) || !shortString(clientSecret, 1024) || !shortString(privateSecret, 1024)
    || !shortString(appFolder, 500) || !appFolder.startsWith('/') || appFolder.includes('\\')) {
    throw new Error('Provide the approved TeraBox clientId, clientSecret, privateSecret and appFolder.');
  }
  const folder = appFolder.replace(/\/+$/, '');
  const parts = folder.slice(1).split('/');
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Use the exact TeraBox application folder assigned by the Open Platform.');
  }
  return { clientId, clientSecret, privateSecret, appFolder: folder };
}

function tokenForm(application: TeraboxApplication) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { clientId, clientSecret, privateSecret } = application;
  const sign = createHash('md5').update([clientId, timestamp, clientSecret, privateSecret].join('_')).digest('hex');
  const form = new FormData();
  for (const [key, value] of Object.entries({ client_id: clientId, client_secret: clientSecret, timestamp, sign })) form.set(key, value);
  return form;
}

function readTokens(data: Record<string, unknown>): TeraboxTokens {
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: ttl } = data;
  if (!shortString(accessToken) || !shortString(refreshToken) || typeof ttl !== 'number'
    || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 7 * 86_400) throw unavailableTerabox();
  return { accessToken, refreshToken, expiresAt: Date.now() + ttl * 1_000 };
}

export async function requestTeraboxDevice(application: TeraboxApplication, signal: AbortSignal, fetcher = fetch) {
  const url = new URL('/oauth/devicecode', issuer);
  url.searchParams.set('client_id', application.clientId);
  const data = succeeded(await jsonFromTerabox(fetcher, url, signal));
  const { device_code: code, qrcode_url: image, interval, expires_in: expiresIn } = data;
  if (!shortString(code) || !shortString(image, 256 * 1024) || typeof interval !== 'number' || !Number.isSafeInteger(interval)
    || interval < 1 || typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn > 3600
    || expiresIn <= interval) throw unavailableTerabox();
  return { code, image, interval, expiresIn };
}

export async function exchangeTeraboxDevice(application: TeraboxApplication, code: string, signal: AbortSignal, fetcher = fetch) {
  const form = tokenForm(application);
  form.set('grant_type', 'device_code');
  form.set('code', code);
  const result = await jsonFromTerabox(fetcher, new URL('/oauth/gettoken', issuer), signal, form);
  if (result.errno === 400001) return null;
  return readTokens(succeeded(result));
}

export async function exchangeTeraboxWeb(application: TeraboxApplication, code: string, signal: AbortSignal, fetcher = fetch) {
  const form = tokenForm(application);
  form.set('grant_type', 'authorization_code');
  form.set('code', code);
  return readTokens(succeeded(await jsonFromTerabox(fetcher, new URL('/oauth/gettoken', issuer), signal, form)));
}

async function inspectToken(application: TeraboxApplication, token: string, signal: AbortSignal, fetcher: typeof fetch) {
  const form = new FormData();
  form.set('access_token', token);
  const data = succeeded(await jsonFromTerabox(fetcher, new URL('/oauth/tokeninfo', issuer), signal, form));
  if (data.client_id !== application.clientId) throw unavailableTerabox();
  const binding = createHash('sha256').update(JSON.stringify([application.clientId, teraboxIdentifier(data.user_id), application.appFolder])).digest('hex');
  return { binding, api: regionalOrigin(data.api_domain), upload: regionalOrigin(data.upload_domain) };
}

export async function bindTerabox(db: DatabaseSync, dataDir: string, master: Buffer, application: TeraboxApplication,
  tokens: TeraboxTokens, signal: AbortSignal, fetcher = fetch) {
  const target = await inspectToken(application, tokens.accessToken, signal, fetcher);
  const current = db.prepare('SELECT binding FROM terabox_account WHERE id = 1').get()?.binding;
  if (current && target.binding !== current) throw new Error('Reconnect the original TeraBox account and application folder.');
  const folder = new URL('/openapi/api/list', target.api);
  folder.search = new URLSearchParams({ access_tokens: tokens.accessToken, dir: application.appFolder, num: '1', page: '1' }).toString();
  if ((await jsonFromTerabox(fetcher, folder, signal)).errno !== 0) {
    throw new Error('TeraBox could not open the assigned application folder. Check its exact path.');
  }
  const credentials = { ...application, ...tokens, binding: target.binding };
  await writeSealedJson(credentialPath(dataDir), master, credentialId, credentials);
  db.prepare('INSERT OR IGNORE INTO terabox_account (id, binding) VALUES (1, ?)').run(credentials.binding);
  db.exec('UPDATE terabox_replicas SET retry_at = 0 WHERE verified = 0');
}

export class TeraboxAuth {
  readonly appFolder: string;
  private credentials: TeraboxCredentials;
  private readonly save: (credentials: TeraboxCredentials) => Promise<void>;
  private readonly fetcher: typeof fetch;
  private cache?: Session & { until: number };
  private updating?: Promise<Session>;
  private unsaved = false;

  constructor(credentials: TeraboxCredentials, save: (credentials: TeraboxCredentials) => Promise<void>, fetcher = fetch) {
    this.credentials = credentials;
    this.appFolder = credentials.appFolder;
    this.save = save;
    this.fetcher = fetcher;
  }

  session(signal: AbortSignal): Promise<Session> {
    signal.throwIfAborted();
    if (this.cache && this.cache.until > Date.now()) return Promise.resolve(this.cache);
    this.updating ??= this.update(signal).finally(() => { this.updating = undefined; });
    return this.updating;
  }

  private async update(signal: AbortSignal): Promise<Session> {
    let current = this.credentials;
    if (this.unsaved) {
      await this.save(current);
      this.unsaved = false;
    }
    if (current.expiresAt <= Date.now() + 60_000) {
      const form = tokenForm(current);
      form.set('refresh_token', current.refreshToken);
      const result = await jsonFromTerabox(this.fetcher, new URL('/oauth/refreshtoken', issuer), signal, form);
      current = { ...current, ...readTokens(succeeded(result)) };
      this.credentials = current;
      this.unsaved = true;
      await this.save(current);
      this.unsaved = false;
    }
    const locations = await inspectToken(current, current.accessToken, signal, this.fetcher);
    if (locations.binding !== current.binding) throw unavailableTerabox();
    const { api, upload } = locations;
    const session = { api, upload, accessToken: current.accessToken };
    this.cache = { ...session, until: Math.min(current.expiresAt - 60_000, Date.now() + 3_600_000) };
    return session;
  }
}

export async function readTeraboxCredentials(db: DatabaseSync, dataDir: string, master: Buffer): Promise<TeraboxCredentials | null> {
  const encrypted = await readSealedJson(credentialPath(dataDir), master, credentialId);
  if (!encrypted) return null;
  const saved = record(encrypted);
  const application = teraboxApplication(saved);
  const { accessToken, refreshToken, expiresAt, binding } = saved;
  const expected = db.prepare('SELECT binding FROM terabox_account WHERE id = 1').get()?.binding;
  if (!shortString(accessToken) || !shortString(refreshToken) || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)
    || typeof binding !== 'string' || !/^[a-f0-9]{64}$/.test(binding) || binding !== expected) throw unavailableTerabox();
  return { ...application, accessToken, refreshToken, expiresAt, binding };
}

export async function readTeraboxAuth(db: DatabaseSync, dataDir: string, master: Buffer) {
  const saved = await readTeraboxCredentials(db, dataDir, master);
  if (!saved) return null;
  return new TeraboxAuth(saved,
    (credentials) => writeSealedJson(credentialPath(dataDir), master, credentialId, credentials));
}
