import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import { DriveError } from '../errors.ts';
import { readSealedJson, writeSealedJson } from './sealed-json.ts';

const credentialId = '00000000-0000-0000-0000-000000000004';
const credentialPath = (dir: string) => join(dir, 'mega.credentials');
const stored = z.strictObject({
  email: z.email().max(254), obscured: z.string().regex(/^[a-zA-Z0-9_-]{22,1600}$/),
  folder: z.string().max(180).regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/),
});
export type MegaCredentials = z.infer<typeof stored>;

export function managedMega(credentials: MegaCredentials, executable: string) {
  return { remote: 'blackboxweb:' + credentials.folder, executable, configPath: process.platform === 'win32' ? 'NUL' : '/dev/null',
    configEnv: { RCLONE_CONFIG_BLACKBOXWEB_TYPE: 'mega', RCLONE_CONFIG_BLACKBOXWEB_USER: credentials.email,
      RCLONE_CONFIG_BLACKBOXWEB_PASS: credentials.obscured } };
}

export async function readMegaCredentials(dir: string, key: Buffer) {
  const result = await readSealedJson(credentialPath(dir), key, credentialId);
  return result ? stored.parse(result) : null;
}

export function saveMegaCredentials(dir: string, key: Buffer, credentials: MegaCredentials) {
  return writeSealedJson(credentialPath(dir), key, credentialId, stored.parse(credentials));
}

export function obscureMegaPassword(executable: string, password: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const unavailable = () => reject(new DriveError(503, 'Blackbox could not prepare the MEGA password with rclone. Check the rclone installation on the server.'));
    const child = spawn(executable, ['obscure', '-'], { windowsHide: true, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 1602) child.kill();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new DriveError(503, 'The Blackbox service could not find rclone. Install it on the server or set MEGA_RCLONE_EXECUTABLE to its full path.'));
      } else {
        unavailable();
      }
    });
    child.stdin.on('error', unavailable);
    child.on('close', (status) => {
      if (status === 0 && /^[a-zA-Z0-9_-]{22,1600}$/.test(output.trim())) resolve(output.trim());
      else unavailable();
    });
    child.stdin.end(password + '\n');
  });
}
