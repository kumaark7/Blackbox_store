import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { loadConfig } from './config.ts';
import { lockDrive, openDatabase } from './database/open.ts';
import { loadStorageKey } from './storage/key.ts';
import { bindTelegram, telegramApplication } from './storage/telegram-credentials.ts';
import { authorizeTelegram } from './storage/telegram-mtproto.ts';

const usage = 'npm run telegram:connect -w server -- "C:\\path\\to\\telegram-connect.json"';

async function main() {
  const [file, ...extra] = process.argv.slice(2);
  if (file === '--help') {
    console.log(usage);
    return;
  }
  if (!file || extra.length) throw new Error('Provide the Telegram application JSON. ' + usage);
  const config = loadConfig();
  let json: unknown;
  try {
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
    json = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Could not read the Telegram application JSON. Check its path and syntax.');
  }
  const application = telegramApplication(json);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run the Telegram connector in an interactive terminal.');
  const lock = lockDrive(config.dataDir);
  let db: ReturnType<typeof openDatabase> | undefined;
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const stop = new AbortController();
  reader.on('SIGINT', () => stop.abort());
  async function ask(message: string) {
    process.stdout.write(message + ': ');
    try {
      return await reader.question('', { signal: stop.signal });
    } finally {
      process.stdout.write('\n');
    }
  }
  try {
    db = openDatabase(config.dataDir);
    const key = await loadStorageKey(config.dataDir, db);
    const login = await authorizeTelegram(application, ask, config.telegramClientDir);
    await bindTelegram(db, config.dataDir, key, login);
    console.log('Telegram account and private channel verified. Start Blackbox Store to copy Backup files.');
  } finally {
    reader.close();
    try { db?.close(); } finally { lock.close(); }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Telegram could not be connected.');
  process.exitCode = 1;
});
