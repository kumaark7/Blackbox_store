import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DriveError } from '../errors.ts';

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.exec('BEGIN IMMEDIATE');
    const migrations = ['001-initial.sql', '002-trash-purges.sql', '003-encrypted-transfers.sql', '004-google-drive.sql',
      '005-mega.sql', '006-terabox.sql', '007-telegram.sql', '008-telegram-upload-bot.sql'];
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version < 0 || version > migrations.length) {
      throw new Error('Unsupported metadata schema version.');
    }
    for (const migration of migrations.slice(version)) {
      db.exec(readFileSync(new URL(migration, import.meta.url), 'utf8'));
    }
    if (version < migrations.length) db.exec('PRAGMA user_version = ' + migrations.length);
    db.exec('COMMIT');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function lockDrive(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(dataDir, 'instance.sqlite'));
  try {
    lock.exec('BEGIN IMMEDIATE');
    return lock;
  } catch (error) {
    lock.close();
    if (typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === 5) {
      throw new DriveError(503, 'Another server is already using this data directory.');
    }
    throw error;
  }
}
