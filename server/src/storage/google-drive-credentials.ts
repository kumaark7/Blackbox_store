import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { GoogleCredentials } from './google-drive.ts';
import { readSealedJson, writeSealedJson } from './sealed-json.ts';

const filename = 'google-drive.credentials';
const credentialsId = '00000000-0000-0000-0000-000000000001';

export function bindGoogleDrive(db: DatabaseSync, binding: string) {
  const current = db.prepare('SELECT binding FROM google_drive_account WHERE id = 1').get()?.binding;
  if (current && current !== binding) {
    throw new Error('Use the original Google account and Desktop OAuth client for this data directory.');
  }
  if (!current) db.prepare('INSERT INTO google_drive_account (id, binding) VALUES (1, ?)').run(binding);
}

export async function readGoogleCredentials(dataDir: string, master: Buffer) {
  const saved = await readSealedJson(join(dataDir, filename), master, credentialsId) as Partial<GoogleCredentials> | null;
  if (!saved) return null;
  if (typeof saved.clientId !== 'string' || !saved.clientId || typeof saved.clientSecret !== 'string'
    || !saved.clientSecret || typeof saved.refreshToken !== 'string' || !saved.refreshToken
    || typeof saved.binding !== 'string' || !/^[a-f0-9]{64}$/.test(saved.binding)) {
    throw new Error('Invalid Google Drive credentials.');
  }
  return saved as GoogleCredentials;
}

export function writeGoogleCredentials(dataDir: string, master: Buffer, credentials: GoogleCredentials) {
  return writeSealedJson(join(dataDir, filename), master, credentialsId, credentials);
}
