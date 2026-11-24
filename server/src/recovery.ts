import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { loadConfig } from './config.ts';
import { backupDrive, restoreDrive } from './storage/recovery.ts';

async function main() {
  const args = process.argv.slice(2);
  const [action, path, destination] = args;
  const usage = 'npm run recovery -w server -- backup <new-backup-dir> or restore <backup-dir> <new-data-dir>';
  if (action === '--help') {
    console.log(usage);
    return;
  }
  const backup = action === 'backup' && args.length === 2;
  const restore = action === 'restore' && args.length === 3;
  if (!backup && !restore) throw new Error(usage);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run recovery in an interactive terminal.');
  const hidden = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: hidden, terminal: true, historySize: 0 });
  async function ask(prompt: string) {
    process.stdout.write(prompt);
    try { return await input.question(''); } finally { process.stdout.write('\n'); }
  }
  let passphrase: string;
  try {
    passphrase = await ask('Recovery passphrase: ');
    if (backup && await ask('Confirm recovery passphrase: ') !== passphrase) throw new Error('The passphrases do not match.');
  } finally { input.close(); }
  if (backup) {
    await backupDrive(loadConfig().dataDir, path, passphrase);
    console.log('Verified backup created.');
  } else {
    await restoreDrive(path, destination, passphrase);
    console.log('Verified drive restored. Set DATA_DIR to the restored directory before starting the server.');
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
