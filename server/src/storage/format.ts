import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { DriveError } from '../errors.ts';

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const HEADER = Buffer.from('BBSTORE1', 'ascii');
export const FRAME_OVERHEAD = 32 + 16;
export const DIGEST_BYTES = 32;

const unavailable = () => new DriveError(503, 'The stored file is unavailable or failed authentication.');

export function dataEnd(size: number) {
  return HEADER.length + size + Math.ceil(size / CHUNK_BYTES) * FRAME_OVERHEAD;
}

function frameContext(key: string, offset: number, size: number, footer: boolean) {
  const context = Buffer.alloc(HEADER.length + 36 + 8 + 4 + 1);
  HEADER.copy(context);
  context.write(key, HEADER.length, 36, 'ascii');
  context.writeBigUInt64BE(BigInt(offset), HEADER.length + 36);
  context.writeUInt32BE(size, HEADER.length + 44);
  context[context.length - 1] = footer ? 1 : 0;
  return context;
}

function frameKey(master: Buffer, salt: Buffer, context: Buffer) {
  return Buffer.from(hkdfSync('sha256', master, salt, context, 32));
}

const nonce = Buffer.alloc(12);

export function sealFrame(master: Buffer, key: string, offset: number, bytes: Buffer, footer = false) {
  // Every invocation derives a fresh key, including rewrites after an interrupted transfer.
  const salt = randomBytes(32);
  const context = frameContext(key, offset, bytes.length, footer);
  const cipher = createCipheriv('aes-256-gcm', frameKey(master, salt, context), nonce);
  cipher.setAAD(context);
  return Buffer.concat([salt, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}

export async function readExactly(file: FileHandle, length: number, position: number) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw unavailable();
    offset += bytesRead;
  }
  return buffer;
}

export async function writeExactly(file: FileHandle, buffer: Buffer, position: number) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten === 0) throw new Error('Could not write the stored file.');
    offset += bytesWritten;
  }
}

export async function readFrame(
  file: FileHandle, master: Buffer, key: string, offset: number, length: number, footer = false,
) {
  const frame = await readExactly(file, length + FRAME_OVERHEAD, dataEnd(offset));
  const context = frameContext(key, offset, length, footer);
  const decipher = createDecipheriv('aes-256-gcm', frameKey(master, frame.subarray(0, 32), context), nonce,
    { authTagLength: 16 });
  decipher.setAAD(context);
  decipher.setAuthTag(frame.subarray(32 + length));
  try {
    return Buffer.concat([decipher.update(frame.subarray(32, 32 + length)), decipher.final()]);
  } catch {
    throw unavailable();
  }
}

export async function checkHeader(file: FileHandle) {
  if (!(await readExactly(file, HEADER.length, 0)).equals(HEADER)) throw unavailable();
}
