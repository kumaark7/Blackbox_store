import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.ts';
import { lockDrive, openDatabase } from './database/open.ts';
import { loadStorageKey, writePrivateFile } from './storage/key.ts';
import { bindTerabox, exchangeTeraboxDevice, requestTeraboxDevice, teraboxApplication } from './storage/terabox-auth.ts';

const usage = 'npm run terabox:connect -w server -- "C:\\path\\to\\terabox-connect.json"';
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegHeader = Buffer.from([255, 216, 255]);

async function readApplication(path: string) {
  const absolute = isAbsolute(path) ? path : resolve(process.env.INIT_CWD ?? process.cwd(), path);
  let input: unknown;
  try {
    input = JSON.parse((await readFile(absolute, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Could not read the TeraBox application JSON. Check its path and syntax.');
  }
  return teraboxApplication(input);
}

async function main() {
  const [file, ...extra] = process.argv.slice(2);
  if (file === '--help') {
    console.log(usage);
    return;
  }
  if (!file || extra.length) throw new Error('Provide an application credential file. ' + usage);
  const application = await readApplication(file);
  const config = loadConfig();
  const lock = lockDrive(config.dataDir);
  let db: ReturnType<typeof openDatabase> | undefined;
  let temporary: string | undefined;
  const cancel = new AbortController();
  const interrupt = () => cancel.abort(new Error('TeraBox authorization was cancelled.'));
  process.once('SIGINT', interrupt);
  try {
    db = openDatabase(config.dataDir);
    const master = await loadStorageKey(config.dataDir, db);
    const { code, image, interval, expiresIn } = await requestTeraboxDevice(application, cancel.signal);
    const elapsed = AbortSignal.timeout(expiresIn * 1_000);
    const signal = AbortSignal.any([cancel.signal, elapsed]);
    const encoded = image.replace(/^data:image\/(png|jpeg);base64,/i, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('TeraBox returned an invalid QR image.');
    const bytes = Buffer.from(encoded, 'base64');
    const extension = bytes.subarray(0, pngHeader.length).equals(pngHeader) ? 'png'
      : bytes.subarray(0, jpegHeader.length).equals(jpegHeader) ? 'jpg' : null;
    if (!extension) throw new Error('TeraBox returned an unsupported QR image.');
    temporary = await mkdtemp(join(tmpdir(), 'blackbox-terabox-'));
    const qr = join(temporary, 'authorize.' + extension);
    await writePrivateFile(qr, bytes);
    console.log('Open this QR image and scan it with the TeraBox mobile app. Confirm access on your phone.');
    console.log(qr);
    try {
      for (;;) {
        await delay(interval * 1_000, undefined, { signal });
        const tokens = await exchangeTeraboxDevice(application, code, signal);
        if (!tokens) continue;
        await bindTerabox(db, config.dataDir, master, application, tokens, cancel.signal);
        console.log('TeraBox account and application folder verified. Start Blackbox Store to copy Backup files.');
        break;
      }
    } catch (error) {
      cancel.signal.throwIfAborted();
      if (elapsed.aborted) throw new Error('The TeraBox QR code expired. Run the command again.');
      throw error;
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    try { db?.close(); } finally { lock.close(); }
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'TeraBox could not be connected.');
  process.exitCode = 1;
});
