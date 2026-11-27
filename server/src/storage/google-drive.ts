import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { DriveError } from '../errors.ts';
import type { Ciphertext, CloudProvider, NativeCloud, NativeListing } from './adapter.ts';
import { reportedQuota } from './quota.ts';

export const googleDriveScope = 'https://www.googleapis.com/auth/drive.appdata';
export const googleDriveWebScopes = googleDriveScope + ' https://www.googleapis.com/auth/drive';
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
  readonly native: NativeCloud = {
    listFiles: (parent, cursor, signal) => this.listNative(parent, cursor, signal),
    downloadFile: (id, signal) => this.downloadNative(id, signal),
    uploadFile: (parent, name, mime, path, bytes, signal) => this.uploadNative(parent, name, mime, path, bytes, signal),
  };
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
    await this.uploadContent({ id, name: object.key + '.bbs', parents: ['appDataFolder'],
      mimeType: 'application/octet-stream', appProperties: { blackboxObject: object.key } },
    'application/octet-stream', object.bytes, sourcePath, signal);
  }

  private async uploadContent(metadata: object, mime: string, bytes: number, sourcePath: string, signal: AbortSignal, native = false) {
    if (native && bytes === 0) {
      const response = await this.request(filesApi, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata) }, signal);
      await this.requireNativeAccess(response);
      await response.body?.cancel();
      return;
    }
    const initiation = await this.request(uploadApi + '?uploadType=resumable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(bytes),
        'X-Upload-Content-Type': mime },
      body: JSON.stringify(metadata),
    }, signal);
    if (!native && initiation.status === 409) {
      await initiation.body?.cancel();
      return;
    }
    if (native) await this.requireNativeAccess(initiation);
    else await requireSuccess(initiation);
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
        headers: { 'Content-Type': mime, 'Content-Length': String(bytes),
          'Content-Range': `bytes 0-${bytes - 1}/${bytes}` },
      }, signal, mediaTimeout);
      await requireSuccess(result);
      await result.body?.cancel();
    } finally {
      source.destroy();
    }
  }

  private async requireNativeAccess(response: Response) {
    if (response.status === 403) {
      const result = await response.json().catch(() => null);
      if (result?.error?.errors?.some?.((issue: { reason?: string }) => issue.reason === 'insufficientPermissions')
        || result?.error?.details?.some?.((issue: { reason?: string }) => issue.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
        throw new DriveError(409, 'Reconnect Google Drive in Account connections and approve access to your Drive files.');
      }
      throw new DriveError(403, 'Google Drive denied access to this file or folder.');
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new DriveError(404, 'Google Drive file or folder not found.');
    }
    await requireSuccess(response);
  }

  private async listNative(parent: string, cursor: string | undefined, signal: AbortSignal): Promise<NativeListing> {
    const shared = parent === '@shared';
    if (!shared && !idPattern.test(parent)) throw new DriveError(400, 'Invalid Google Drive folder.');
    const filter = shared ? 'sharedWithMe' : "'" + parent + "' in parents";
    const query = new URLSearchParams({ q: filter + ' and trashed = false', spaces: 'drive',
      orderBy: 'folder,name_natural', pageSize: '100', fields: 'nextPageToken,files(id,name,mimeType,size)' });
    if (cursor) query.set('pageToken', cursor);
    const result = await this.request(filesApi + '?' + query, {}, signal);
    await this.requireNativeAccess(result);
    const data = await result.json() as { nextPageToken?: string; files?: { id: string; name: string; mimeType: string; size?: string }[] };
    const items = (data.files ?? []).filter((file) => idPattern.test(file.id)).map((file) => {
      const folder = file.mimeType === 'application/vnd.google-apps.folder';
      const size = Number(file.size);
      return { id: file.id, name: file.name, folder, size: Number.isSafeInteger(size) && size >= 0 ? size : null,
        openUrl: !folder && file.mimeType.startsWith('application/vnd.google-apps.')
          ? 'https://drive.google.com/open?id=' + file.id : undefined };
    });
    if (parent === 'root' && !cursor) items.unshift({ id: '@shared', name: 'Shared with me', folder: true, size: null, openUrl: undefined });
    return { items, next: data.nextPageToken };
  }

  private async downloadNative(id: string, signal: AbortSignal) {
    const url = this.fileUrl(id);
    const info = await this.request(url + '?fields=name,mimeType,trashed', {}, signal);
    await this.requireNativeAccess(info);
    const file = await info.json();
    if (file.trashed) throw new DriveError(404, 'Google Drive file not found.');
    if (typeof file.name !== 'string' || typeof file.mimeType !== 'string' || file.mimeType.startsWith('application/vnd.google-apps.')) {
      throw new DriveError(415, 'Open this item in Google Drive.');
    }
    const result = await this.request(url + '?alt=media', {}, signal, mediaTimeout);
    await this.requireNativeAccess(result);
    if (!result.body) throw unavailable('Google Drive returned an empty response.');
    return { name: file.name, stream: Readable.fromWeb(result.body as ReadableStream<Uint8Array>) };
  }

  private async uploadNative(parent: string, name: string, mime: string, path: string, bytes: number, signal: AbortSignal) {
    if (!idPattern.test(parent)) throw new DriveError(400, 'Invalid Google Drive folder.');
    await this.uploadContent({ name, parents: [parent], mimeType: mime }, mime, bytes, path, signal, true);
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
