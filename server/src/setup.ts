import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { OwnerAuth, passwordInput } from './auth/owner.ts';
import { loadConfig } from './config.ts';
import { lockDrive, openDatabase } from './database/open.ts';

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run setup in an interactive terminal.');
  }
  const config = loadConfig();
  const lock = lockDrive(config.dataDir);
  let db: ReturnType<typeof openDatabase> | undefined;
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  async function ask(prompt: string) {
    process.stdout.write(prompt);
    try {
      return await input.question('');
    } finally {
      process.stdout.write('\n');
    }
  }
  try {
    db = openDatabase(config.dataDir);
    const auth = new OwnerAuth(db, config.sessionSeconds);
    if (auth.configured()) throw new Error('The owner has already been configured.');
    const password = await ask('Owner password (12 to 128 characters): ');
    if (!passwordInput.safeParse(password).success) throw new Error('Enter a password of 12 to 128 characters.');
    if (await ask('Confirm password: ') !== password) throw new Error('The passwords do not match.');
    await auth.createOwner(password);
    console.log('Owner configured.');
  } finally {
    input.close();
    try { db?.close(); } finally { lock.close(); }
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
