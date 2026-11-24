import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { DriveError } from '../errors.ts';
import type { Ciphertext, CloudProvider } from './adapter.ts';
import { reportedQuota } from './quota.ts';

export const googleDriveScope = 'https://www.googleapis.com/auth/drive.appdata';
const googleApi = 'https://www.googleapis.com';
const tokenApi = 'https://oauth2.googleapis.com/token';
const filesApi = googleApi + '/drive/v3/files';
const uploadApi = googleApi + '/upload/drive/v3/files';
const fields = 'id,size,sha256Checksum,appProperties';
const requestTimeout = 30_000;
const mediaTimeout = 15 * 60_000;
const idPattern = /^[a-zA-Z0-9_-]{1,256}$/;

export type OAuthClient = { clientId: string; clientSecret: string };
export type GoogleCredentials = OAuthClient & { refreshToken: string; binding: string; clientType?: 'web' | 'installed' };
type StreamingInit = RequestInit & { duplex?: 'half' };

const unavailable = (message: string) => new DriveError(503, message);

async function requireSuccess(response: Response) {
  if (response.ok) return;
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) {
    throw unavailable('Google Drive refused access. Check the authorization and storage quota.');
  }
  throw unavailable('Google Drive is temporarily unavailable.');
}

export async function requestGoogleToken(client: OAuthClient, fields: Record<string, string>,
  fetcher = fetch, signal?: AbortSignal) {
  const response = await fetcher(tokenApi, {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)])
      : AbortSignal.timeout(requestTimeout),
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...fields }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw unavailable('Google could not authorize the connection. Check the OAuth client or reconnect Google Drive.');
  }
  const token = await response.json();
  if (typeof token.access_token !== 'string' || !token.access_token || typeof token.expires_in !== 'number'
    || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw unavailable('Google returned an invalid access token.');
  }
  return { accessToken: token.access_token as string, expiresIn: token.expires_in as number,
    refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token as string : undefined };
}

export async function googleBinding(clientId: string, accessToken: string, fetcher = fetch) {
  const response = await fetcher(googleApi + '/drive/v3/about?fields=user(permissionId)', {
    headers: { Authorization: 'Bearer ' + accessToken }, redirect: 'error', signal: AbortSignal.timeout(requestTimeout),
  });
  await requireSuccess(response);
  const body = await response.json();
  if (typeof body.user?.permissionId !== 'string' || !body.user.permissionId) {
    throw unavailable('Google Drive did not identify the authorized account.');
  }
  return createHash('sha256').update(clientId).update('\0').update(body.user.permissionId).digest('hex');
}

export class GoogleDriveStorage implements CloudProvider {
  readonly binding: string;
  private readonly credentials: GoogleCredentials;
  private readonly fetcher: typeof fetch;
  private accessToken = '';
  private refreshAt = 0;
  private refreshing?: Promise<void>;

  constructor(credentials: GoogleCredentials, fetcher = fetch) {
    this.credentials = credentials;
    this.binding = credentials.binding;
    this.fetcher = fetcher;
  }

  private async token(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.refreshAt > Date.now()) return this.accessToken;
    this.refreshing ??= requestGoogleToken(this.credentials, {
      grant_type: 'refresh_token', refresh_token: this.credentials.refreshToken,
    }, this.fetcher).then(({ accessToken, expiresIn }) => {
      this.accessToken = accessToken;
      this.refreshAt = Date.now() + Math.max(0, expiresIn - 60) * 1000;
    }).finally(() => { this.refreshing = undefined; });
    await this.refreshing;
    signal.throwIfAborted();
    return this.accessToken;
  }

  private async request(url: string, init: StreamingInit = {}, outer?: AbortSignal, timeout = requestTimeout) {
    const timer = AbortSignal.timeout(timeout);
    const signal = outer ? AbortSignal.any([timer, outer]) : timer;
    const token = await this.token(signal);
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + token);
    const response = await this.fetcher(url, { ...init, headers, signal, redirect: 'error' });
    if (response.status === 401 && this.accessToken === token) this.refreshAt = 0;
    return response;
  }

  private fileUrl(id: string) {
    if (!idPattern.test(id)) throw unavailable('Google Drive returned an invalid file ID.');
    return filesApi + '/' + id;
  }

  async quota(signal: AbortSignal) {
    const response = await this.request(googleApi + '/drive/v3/about?fields=storageQuota(limit,usage)', {}, signal);
    await requireSuccess(response);
    const { storageQuota } = await response.json();
    return reportedQuota(storageQuota?.limit, storageQuota?.usage);
  }

  async allocate(signal: AbortSignal) {
    const response = await this.request(filesApi + '/generateIds?count=1&space=appDataFolder', {}, signal);
    await requireSuccess(response);
    const { ids } = await response.json();
    const id = ids?.[0];
    if (typeof id !== 'string' || !idPattern.test(id)) throw unavailable('Google Drive did not allocate a file ID.');
    return id;
  }

  async upload(id: string, object: Ciphertext, sourcePath: string, signal: AbortSignal) {
    this.fileUrl(id);
    const initiation = await this.request(uploadApi + '?uploadType=resumable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(object.bytes),
        'X-Upload-Content-Type': 'application/octet-stream' },
      body: JSON.stringify({ id, name: object.key + '.bbs', parents: ['appDataFolder'],
        mimeType: 'application/octet-stream', appProperties: { blackboxObject: object.key } }),
    }, signal);
    if (initiation.status === 409) {
      await initiation.body?.cancel();
      return;
    }
    await requireSuccess(initiation);
    const location = initiation.headers.get('location');
    await initiation.body?.cancel();
    const session = location && URL.parse(location);
    if (!session || session.origin !== googleApi || session.username || session.password
      || session.pathname !== new URL(uploadApi).pathname || !session.searchParams.has('upload_id')) {
      throw unavailable('Google Drive returned an invalid upload session.');
    }
    const source = createReadStream(sourcePath, { signal });
    try {
      const result = await this.request(session.href, {
        method: 'PUT', duplex: 'half', body: Readable.toWeb(source) as BodyInit,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.bytes),
          'Content-Range': `bytes 0-${object.bytes - 1}/${object.bytes}` },
      }, signal, mediaTimeout);
      await requireSuccess(result);
      await result.body?.cancel();
    } finally {
      source.destroy();
    }
  }

  async verify(id: string, object: Ciphertext, signal: AbortSignal) {
    const response = await this.request(this.fileUrl(id) + '?fields=' + fields, {}, signal);
    if (response.status === 404) {
      await response.body?.cancel();
      return false;
    }
    await requireSuccess(response);
    const found = await response.json();
    if (found.id !== id || found.appProperties?.blackboxObject !== object.key || found.size !== String(object.bytes)) {
      throw unavailable('The Google Drive replica metadata did not match.');
    }
    if (typeof found.sha256Checksum === 'string') {
      if (found.sha256Checksum.toLowerCase() !== object.checksum) throw unavailable('The Google Drive replica checksum did not match.');
      return true;
    }
    const source = await this.download(id, signal);
    const checksum = createHash('sha256');
    let size = 0;
    for await (const bytes of source) {
      size += bytes.length;
      if (size > object.bytes) break;
      checksum.update(bytes);
    }
    if (size !== object.bytes || checksum.digest('hex') !== object.checksum) {
      throw unavailable('The Google Drive replica checksum did not match.');
    }
    return true;
  }

  async download(id: string, signal: AbortSignal) {
    const response = await this.request(this.fileUrl(id) + '?alt=media', {}, signal, mediaTimeout);
    await requireSuccess(response);
    if (!response.body) throw unavailable('Google Drive returned an empty response.');
    return Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  }

  async delete(id: string, signal?: AbortSignal) {
    const response = await this.request(this.fileUrl(id), { method: 'DELETE' }, signal);
    if (response.status !== 404) await requireSuccess(response);
    await response.body?.cancel();
  }
}
