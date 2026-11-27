import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';

type ThumbnailFormat = { kind: 'image' | 'video'; demuxer: string };
const formats = new Map<string, ThumbnailFormat>([
  ['.jpg', { kind: 'image', demuxer: 'jpeg_pipe' }],
  ['.jpeg', { kind: 'image', demuxer: 'jpeg_pipe' }],
  ['.png', { kind: 'image', demuxer: 'png_pipe' }],
  ['.gif', { kind: 'image', demuxer: 'gif' }],
  ['.webp', { kind: 'image', demuxer: 'webp_pipe' }],
  ['.mp4', { kind: 'video', demuxer: 'mov' }],
  ['.m4v', { kind: 'video', demuxer: 'mov' }],
  ['.mov', { kind: 'video', demuxer: 'mov' }],
  ['.webm', { kind: 'video', demuxer: 'matroska' }],
  ['.mkv', { kind: 'video', demuxer: 'matroska' }],
  ['.avi', { kind: 'video', demuxer: 'avi' }],
]);
const maxImageBytes = 20 * 1024 * 1024;
const maxVideoBytes = 1024 * 1024 * 1024;
const maxThumbnailBytes = 256 * 1024;

function thumbnailFormat(name: string, size: number | null) {
  const format = formats.get(extname(name).toLowerCase());
  if (!format || size === null || size <= 0 || size > (format.kind === 'image' ? maxImageBytes : maxVideoBytes)) return null;
  return format;
}

export function thumbnailKind(name: string, size: number | null) {
  return thumbnailFormat(name, size)?.kind ?? null;
}

async function renderThumbnail(executable: string, demuxer: string, seekable: boolean, open: () => Promise<Readable>) {
  const directory = seekable ? await mkdtemp(join(tmpdir(), 'blackbox-thumbnail-')) : undefined;
  try {
    return await decodeThumbnail(/[\\/]/.test(executable) ? resolve(executable) : executable, demuxer, seekable, open, directory);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function decodeThumbnail(executable: string, demuxer: string, seekable: boolean, open: () => Promise<Readable>, cwd?: string) {
  const signal = AbortSignal.timeout(45_000);
  const child = spawn(executable, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '67108864', '-filter_threads', '1',
    '-protocol_whitelist', seekable ? 'cache,pipe' : 'pipe', '-threads', '1', '-f', demuxer,
    ...(seekable ? ['-read_ahead_limit', '-1'] : []), '-i', seekable ? 'cache:pipe:0' : 'pipe:0',
    '-map', '0:V:0', '-an', '-sn', '-dn', '-frames:v', '1',
    '-vf', 'scale=min(360\\,iw):min(240\\,ih):force_original_aspect_ratio=decrease',
    '-threads', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1',
  ], { cwd, windowsHide: true, signal, stdio: ['pipe', 'pipe', 'ignore'] });
  let processError = false;
  child.on('error', () => { processError = true; });
  const exit = new Promise<number | null>((resolve) => child.once('close', resolve));
  const output = buffer(child.stdout).catch(() => null);
  let inputFailed = false;
  try {
    if (!(await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    }))) return null;
    const source = await Promise.race([
      open().then((stream) => {
        if (!signal.aborted) return stream;
        stream.destroy();
        return null;
      }),
      new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true })),
    ]);
    if (!source) return null;
    await pipeline(source, child.stdin, { signal }).catch((error: NodeJS.ErrnoException) => {
      // FFmpeg can finish the first frame before it consumes the entire stream.
      inputFailed = error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE';
    });
    const [code, thumbnail] = await Promise.all([exit, output]);
    if (processError || inputFailed || code !== 0 || !thumbnail || thumbnail.length > maxThumbnailBytes
      || thumbnail[0] !== 0xff || thumbnail[1] !== 0xd8 || thumbnail.at(-2) !== 0xff || thumbnail.at(-1) !== 0xd9) return null;
    return thumbnail;
  } finally {
    child.kill();
    await exit;
  }
}

export class FileThumbnails {
  private readonly executable: string;
  private readonly cache = new Map<string, Buffer>();
  private readonly pending = new Map<string, Promise<Buffer | null>>();
  private readonly active = new Set<Promise<Buffer | null>>();

  constructor(executable: string) {
    this.executable = executable;
  }

  get(name: string, size: number, checksum: string, open: () => Promise<Readable>) {
    const format = thumbnailFormat(name, size);
    if (!format) return Promise.resolve(null);
    const key = format.demuxer + ':' + checksum;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 50) return Promise.resolve(null);
    const task = this.generate(format, open).then((thumbnail) => {
      if (thumbnail) {
        this.cache.set(key, thumbnail);
        if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value!);
      }
      return thumbnail;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private async generate(format: ThumbnailFormat, open: () => Promise<Readable>) {
    while (this.active.size >= 2) await Promise.race(this.active);
    const task = renderThumbnail(this.executable, format.demuxer, format.kind === 'video', open).catch(() => null);
    this.active.add(task);
    try {
      return await task;
    } finally {
      this.active.delete(task);
    }
  }
}
