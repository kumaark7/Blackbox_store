import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FRAME_OVERHEAD, HEADER, checkHeader, readFrame, sealFrame } from './format.ts';
import { missingFile, syncDirectory, writePrivateFile } from './key.ts';

const maxBytes = 16 * 1024;

export async function readSealedJson(path: string, master: Buffer, id: string): Promise<unknown> {
  const file = await open(path, 'r').catch((error) => {
    if (missingFile(error)) return null;
    throw error;
  });
  if (!file) return null;
  try {
    const { size } = await file.stat();
    const bytes = size - HEADER.length - FRAME_OVERHEAD;
    if (bytes <= 0 || bytes > maxBytes) throw new Error('Invalid encrypted credentials.');
    await checkHeader(file);
    const decoded = await readFrame(file, master, id, 0, bytes);
    return JSON.parse(decoded.toString('utf8'));
  } finally { await file.close(); }
}

export async function writeSealedJson(path: string, master: Buffer, id: string, payload: object) {
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length > maxBytes) throw new Error('Encrypted credentials exceed the supported size.');
  const temporary = path + '.' + randomUUID();
  try {
    await writePrivateFile(temporary, Buffer.concat([HEADER, sealFrame(master, id, 0, bytes)]));
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}
