import { loadConfig } from './config.ts';
import { lockDrive, openDatabase } from './database/open.ts';
import { connectMega } from './storage/mega-rclone.ts';

async function main() {
  if (process.argv[2] === '--help') {
    console.log('Set MEGA_RCLONE_REMOTE and run npm run mega:connect -w server with Blackbox Store stopped.');
    return;
  }
  const config = loadConfig();
  if (!config.mega) throw new Error('Set MEGA_RCLONE_REMOTE to your rclone MEGA remote and dedicated folder.');
  const lock = lockDrive(config.dataDir);
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(config.dataDir);
    await connectMega(db, config.mega);
    console.log('MEGA folder verified. Start Blackbox Store to copy eligible files.');
  } finally {
    try { db?.close(); } finally { lock.close(); }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'MEGA could not be connected.');
  process.exitCode = 1;
});
