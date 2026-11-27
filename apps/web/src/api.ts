export const ROOT_ID = '00000000-0000-4000-8000-000000000000';

export const labels = {
  'highly-important': 'Highly Important',
  important: 'Important',
  backup: 'Backup',
} as const;

export type Importance = keyof typeof labels;
export type Entry = {
  id: string;
  parentId: string;
  name: string;
  kind: 'folder' | 'file';
  importance: Importance | null;
  size: number | null;
  updatedAt: number;
  storage: 'cloud' | 'local' | null;
  protection: 'single-copy' | 'degraded' | 'replicated' | null;
  deletionPending: boolean;
  preview: 'image' | 'pdf' | null;
  thumbnail: 'image' | 'video' | null;
  cloudCopies: CloudProvider[];
};
export type Listing = {
  items: Entry[];
  breadcrumbs: { id: string; name: string }[];
  nextOffset: number | null;
};
export type AuthStatus = { authenticated: boolean; configured: boolean };
export type Sort = 'name' | 'updated' | 'size';
export type CloudStatus = 'off' | 'reconnect' | 'retrying' | 'connected';
export type CloudProvider = 'google-drive' | 'mega' | 'terabox' | 'telegram';
export const cloudNames: Record<CloudProvider, string> = {
  'google-drive': 'Google Drive', mega: 'MEGA', terabox: 'TeraBox', telegram: 'Telegram',
};
export type StorageUsage = {
  cloudOnly: boolean;
  appBytes: number;
  trashBytes: number;
  disk: { totalBytes: number; availableBytes: number } | null;
  cloud: {
    accounts: {
      id: CloudProvider;
      status: Exclude<CloudStatus, 'off'>;
      tracked: { files: number; bytes: number };
      quota: { totalBytes: number | null; usedBytes: number } | null;
    }[];
    priorities: { importance: Importance; files: number; bytes: number }[];
  };
};
export type SavedTransfer = {
  id: string;
  parentId: string;
  name: string;
  importance: Importance;
  size: number;
  received: number;
  completed: boolean;
};

export const sessionEnded = 'blackbox-session-ended';

export type TeraboxCleanup = { paths: string[]; confirmation: string };

export class ApiError extends Error {
  readonly teraboxCleanup?: TeraboxCleanup;

  constructor(message: string, teraboxCleanup?: TeraboxCleanup) {
    super(message);
    this.teraboxCleanup = teraboxCleanup;
  }
}

function cleanupDetails(body: unknown): TeraboxCleanup | undefined {
  if (!body || typeof body !== 'object' || !('teraboxCleanup' in body)) return;
  const value = body.teraboxCleanup;
  if (!value || typeof value !== 'object' || !('paths' in value) || !('confirmation' in value)) return;
  const { paths, confirmation } = value;
  if (Array.isArray(paths) && paths.every((path) => typeof path === 'string') && typeof confirmation === 'string') {
    return { paths, confirmation };
  }
}

function serverMessage(body: unknown) {
  return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : null;
}

async function request(path: string, options: RequestInit) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch('/api' + path, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(sessionEnded));
    const body: unknown = await response.json().catch(() => null);
    throw new ApiError(serverMessage(body) ?? 'The server could not complete the request.',
      response.status === 409 ? cleanupDetails(body) : undefined);
  }
  return response;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await request(path, options);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function getPreview(id: string, signal: AbortSignal) {
  const response = await request('/files/' + id + '/preview', { signal });
  return response.blob();
}

export function getEntries(query: { parentId: string; sort?: Sort; search?: string; offset?: number; trash?: boolean },
  signal?: AbortSignal) {
  const params = new URLSearchParams({ parentId: query.parentId, offset: String(query.offset ?? 0) });
  if (query.sort) params.set('sort', query.sort);
  if (query.search) params.set('search', query.search);
  if (query.trash) params.set('trash', '1');
  return api<Listing>('/entries?' + params, { signal });
}

const chunkBytes = 4 * 1024 * 1024;

async function fileFingerprint(file: File, signal: AbortSignal) {
  const hashes = new Uint8Array(Math.ceil(file.size / chunkBytes) * 32);
  for (let offset = 0, index = 0; offset < file.size; offset += chunkBytes, index++) {
    signal.throwIfAborted();
    const bytes = await file.slice(offset, offset + chunkBytes).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    hashes.set(new Uint8Array(digest), index * 32);
  }
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', hashes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sendChunk(id: string, offset: number, bytes: Blob, signal: AbortSignal, progress: (loaded: number) => void) {
  signal.throwIfAborted();
  const request = new XMLHttpRequest();
  return new Promise<SavedTransfer>((resolve, reject) => {
    request.open('PATCH', '/api/transfers/' + id);
    request.responseType = 'json';
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('Upload-Offset', String(offset));
    request.upload.addEventListener('progress', (event) => progress(offset + event.loaded));
    request.addEventListener('load', () => {
      if (request.status === 200) {
        resolve(request.response as SavedTransfer);
      } else {
        if (request.status === 401) window.dispatchEvent(new Event(sessionEnded));
        reject(new Error(serverMessage(request.response) ?? 'Upload failed.'));
      }
    });
    request.addEventListener('error', () => reject(new Error('The upload connection was lost.')));
    request.addEventListener('abort', () => reject(signal.reason));
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    request.addEventListener('loadend', () => signal.removeEventListener('abort', abort), { once: true });
    request.send(bytes);
  });
}

export async function uploadFile(file: File, parentId: string, importance: Importance, signal: AbortSignal,
  progress: (loaded: number, status: string) => void) {
  const fingerprint = await fileFingerprint(file, signal);
  let transfer = await api<SavedTransfer>('/transfers', {
    method: 'POST', signal, body: JSON.stringify({ name: file.name, parentId, importance, size: file.size, fingerprint }),
  });
  while (transfer.received < file.size) {
    const offset = transfer.received;
    progress(offset, 'Uploading');
    transfer = await sendChunk(transfer.id, offset, file.slice(offset, offset + chunkBytes), signal,
      (loaded) => progress(loaded, 'Uploading'));
  }
  progress(file.size, 'Verifying');
  await api<SavedTransfer>('/transfers/' + transfer.id + '/complete', { method: 'POST', signal });
}
