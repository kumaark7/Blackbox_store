import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { Ciphertext, CloudProvider } from './adapter.ts';
import { readExactly } from './format.ts';
import { reportedQuota } from './quota.ts';
import { jsonFromTerabox, record, teraboxIdentifier, trustedTeraboxUrl, unavailableTerabox } from './terabox-auth.ts';
import type { TeraboxAuth } from './terabox-auth.ts';

const blockBytes = 16 * 1024 * 1024;
type RemoteFile = { fid: string; bytes: number };

export class TeraboxStorage implements CloudProvider {
  private readonly auth: TeraboxAuth;
  private readonly fetcher: typeof fetch;

  constructor(auth: TeraboxAuth, fetcher = fetch) {
    this.auth = auth;
    this.fetcher = fetcher;
  }

  async allocate(signal: AbortSignal) {
    signal.throwIfAborted();
    return randomUUID();
  }

  private path(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw unavailableTerabox();
    return `${this.auth.appFolder}/blackbox-${id}.bbs`;
  }

  private async api(endpoint: string, params: Record<string, string>, signal: AbortSignal, body?: Record<string, string>) {
    const { api, accessToken } = await this.auth.session(signal);
    const url = new URL('/openapi/api/' + endpoint, api);
    url.search = new URLSearchParams({ ...params, access_tokens: accessToken }).toString();
    return jsonFromTerabox(this.fetcher, url, signal, body && new URLSearchParams(body));
  }

  async quota(signal: AbortSignal) {
    const result = await this.api('quota', {}, signal);
    if (result.errno !== 0) throw unavailableTerabox();
    return reportedQuota(result.total, result.used);
  }

  private async metadata(path: string, signal: AbortSignal): Promise<RemoteFile | null> {
    const result = await this.api('filemetas', { target: JSON.stringify([path]), dlink: '0' }, signal);
    if (result.errno === -9) return null;
    if (result.errno !== 0 || !Array.isArray(result.list)) throw unavailableTerabox();
    if (result.list.length === 0) return null;
    if (result.list.length !== 1) throw unavailableTerabox();
    const entry = record(result.list[0]);
    const { size } = entry;
    if (entry.path !== path || entry.isdir !== 0 || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw unavailableTerabox();
    }
    return { fid: teraboxIdentifier(entry.fs_id), bytes: size };
  }

  async upload(id: string, object: Ciphertext, sourcePath: string, signal: AbortSignal) {
    const path = this.path(id);
    const file = await open(sourcePath, 'r');
    try {
      const count = Math.max(1, Math.ceil(object.bytes / blockBytes));
      const base = Math.floor(object.bytes / count);
      const extra = object.bytes % count;
      const readBlock = (index: number) => readExactly(file,
        base + (index < extra ? 1 : 0), index * base + Math.min(index, extra));
      const hashes: string[] = [];
      for (let index = 0; index < count; index++) {
        signal.throwIfAborted();
        hashes.push(createHash('md5').update(await readBlock(index)).digest('hex'));
      }
      const blockList = JSON.stringify(hashes);
      const prepared = await this.api('precreate', {}, signal, { path, autoinit: '1', block_list: blockList });
      if (prepared.errno !== 0) throw unavailableTerabox();
      if (prepared.return_type === 2) return;
      const { uploadid, block_list: blocks } = prepared;
      if (prepared.return_type !== 1 || typeof uploadid !== 'string' || !uploadid || !Array.isArray(blocks)) throw unavailableTerabox();
      const needed = blocks.length === 0 ? [0] : blocks.map((index: unknown) =>
        typeof index === 'string' && /^(0|[1-9]\d*)$/.test(index) ? Number(index) : index);
      if (new Set(needed).size !== needed.length || !needed.every((index): index is number =>
        typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < count)) {
        throw unavailableTerabox();
      }
      for (const index of needed) {
        signal.throwIfAborted();
        const { upload, accessToken } = await this.auth.session(signal);
        const url = new URL('/rest/2.0/pcs/superfile2', upload);
        url.search = new URLSearchParams({ method: 'upload', app_id: '250528', path, uploadid,
          partseq: String(index), access_tokens: accessToken }).toString();
        const data = new FormData();
        data.set('file', new Blob([new Uint8Array(await readBlock(index))]), 'block');
        const uploaded = await jsonFromTerabox(this.fetcher, url, signal, data);
        if (uploaded.md5 !== hashes[index] || uploaded.uploadid !== uploadid || uploaded.partseq !== index) throw unavailableTerabox();
      }
      const created = await this.api('create', {}, signal, { path, size: String(object.bytes), uploadid, block_list: blockList, rtype: '0' });
      if (created.errno !== 0 || created.path !== path) throw unavailableTerabox();
    } finally {
      await file.close();
    }
  }

  private async openBytes(remote: RemoteFile, signal: AbortSignal) {
    const result = await this.api('download', { fidlist: `[${remote.fid}]`, type: 'dlink' }, signal);
    if (result.errno !== 0 || !Array.isArray(result.dlink) || result.dlink.length !== 1) throw unavailableTerabox();
    const link = record(result.dlink[0]);
    if (teraboxIdentifier(link.fs_id) !== remote.fid || typeof link.dlink !== 'string') throw unavailableTerabox();
    const url = trustedTeraboxUrl(link.dlink);
    const { accessToken } = await this.auth.session(signal);
    // Keep the encoding of the provider's signed query intact.
    if (url.searchParams.has('access_tokens')) throw unavailableTerabox();
    url.search += (url.search ? '&' : '?') + 'access_tokens=' + encodeURIComponent(accessToken);
    try {
      const response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) });
      const length = response.headers.get('content-length');
      if (!response.ok || !response.body || (length !== null && length !== String(remote.bytes))) {
        await response.body?.cancel();
        throw unavailableTerabox();
      }
      return Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
    } catch {
      throw unavailableTerabox();
    }
  }

  async download(id: string, signal: AbortSignal, bytes: number) {
    const remote = await this.metadata(this.path(id), signal);
    if (!remote || remote.bytes !== bytes) throw unavailableTerabox();
    return this.openBytes(remote, signal);
  }

  async verify(id: string, object: Ciphertext, signal: AbortSignal) {
    const remote = await this.metadata(this.path(id), signal);
    if (!remote || remote.bytes !== object.bytes) return false;
    const source = await this.openBytes(remote, signal);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > object.bytes) return false;
      hash.update(chunk);
    }
    return bytes === object.bytes && hash.digest('hex') === object.checksum;
  }

  async delete(id: string, signal: AbortSignal) {
    const path = this.path(id);
    if (!await this.metadata(path, signal)) return { path, moved: false };
    const response = await this.api('filemanager', { opera: 'delete', async: '0' }, signal, { filelist: JSON.stringify([path]) });
    if (response.errno !== 0 || !Array.isArray(response.info) || response.info.length !== 1) throw unavailableTerabox();
    const deleted = record(response.info[0]);
    if (deleted.errno !== 0 || deleted.path !== path || await this.metadata(path, signal)) throw unavailableTerabox();
    return { path, moved: true };
  }
}
