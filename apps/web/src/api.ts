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
  storage: 'local' | null;
  protection: 'single-copy' | 'degraded' | null;
  deletionPending: boolean;
};
export type Listing = {
  items: Entry[];
  breadcrumbs: { id: string; name: string }[];
  nextOffset: number | null;
};
export type AuthStatus = { authenticated: boolean; configured: boolean };
export type Sort = 'name' | 'updated' | 'size';

export const sessionEnded = 'blackbox-session-ended';

function serverMessage(body: unknown) {
  return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : null;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch('/api' + path, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(sessionEnded));
    const body: unknown = await response.json().catch(() => null);
    throw new Error(serverMessage(body) ?? 'The server could not complete the request.');
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function getEntries(query: { parentId: string; sort?: Sort; search?: string; offset?: number; trash?: boolean },
  signal?: AbortSignal) {
  const params = new URLSearchParams({ parentId: query.parentId, offset: String(query.offset ?? 0) });
  if (query.sort) params.set('sort', query.sort);
  if (query.search) params.set('search', query.search);
  if (query.trash) params.set('trash', '1');
  return api<Listing>('/entries?' + params, { signal });
}

export function uploadFile(file: File, parentId: string, importance: Importance,
  onProgress: (loaded: number, verifying: boolean) => void) {
  const request = new XMLHttpRequest();
  const result = new Promise<Entry>((resolve, reject) => {
    const query = new URLSearchParams({ name: file.name, parentId, importance });
    request.open('POST', '/api/uploads?' + query);
    request.responseType = 'json';
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.addEventListener('progress', (event) => onProgress(event.loaded, false));
    request.upload.addEventListener('load', () => onProgress(file.size, true));
    request.addEventListener('load', () => {
      if (request.status === 201) {
        resolve(request.response as Entry);
      } else {
        if (request.status === 401) window.dispatchEvent(new Event(sessionEnded));
        reject(new Error(serverMessage(request.response) ?? 'Upload failed.'));
      }
    });
    request.addEventListener('error', () => reject(new Error('The upload connection was lost.')));
    request.addEventListener('abort', () => reject(new DOMException('Upload cancelled.', 'AbortError')));
    request.send(file);
  });
  return { result, cancel: () => request.abort() };
}
