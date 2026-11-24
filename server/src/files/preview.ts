import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { DriveError } from '../errors.ts';

const maxPreviewBytes = 20 * 1024 * 1024;
const imageTypes = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function mediaType(name: string) {
  const extension = extname(name).toLowerCase();
  return extension === '.pdf' ? 'application/pdf' : imageTypes.get(extension);
}

export function previewKind(name: string, size: number | null) {
  if (size === null || size === 0 || size > maxPreviewBytes) return null;
  const type = mediaType(name);
  return type === 'application/pdf' ? 'pdf' : type ? 'image' : null;
}

export function requirePreviewType(name: string, size: number) {
  const type = mediaType(name);
  if (!type || size === 0) throw new DriveError(415, 'This file cannot be previewed. You can still download it.');
  if (size > maxPreviewBytes) throw new DriveError(413, 'Previews support files up to 20 MiB. Download this file to open it.');
  return type;
}

function matchesSignature(type: string, prefix: Buffer) {
  switch (type) {
    case 'application/pdf': return /^%PDF-[12]\.\d/.test(prefix.toString('latin1'));
    case 'image/png': return prefix.subarray(0, 8).equals(pngSignature);
    case 'image/jpeg': return prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
    case 'image/gif': return /^GIF8[79]a/.test(prefix.toString('latin1'));
    case 'image/webp': return prefix.toString('latin1', 0, 4) === 'RIFF' && prefix.toString('latin1', 8, 12) === 'WEBP';
    default: return false;
  }
}

export async function checkedPreview(source: Readable, type: string) {
  const iterator = source[Symbol.asyncIterator]();
  const blocks: Buffer[] = [];
  const prefix = Buffer.alloc(12);
  let length = 0;
  try {
    while (length < prefix.length) {
      const next = await iterator.next();
      if (next.done) break;
      const bytes: Buffer = next.value;
      blocks.push(bytes);
      length += bytes.copy(prefix, length, 0, prefix.length - length);
    }
    if (!matchesSignature(type, prefix.subarray(0, length))) {
      throw new DriveError(415, 'The file contents do not match this preview format.');
    }
  } catch (error) {
    source.destroy();
    throw error;
  }
  const stream = Readable.from((async function* () {
    yield* blocks;
    yield* iterator;
  })(), { objectMode: false });
  stream.once('close', () => source.destroy());
  return stream;
}
