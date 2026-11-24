import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.ts';
import { lockDrive, openDatabase } from './database/open.ts';
import { bindGoogleDrive, writeGoogleCredentials } from './storage/google-drive-credentials.ts';
import { googleBinding, googleDriveScope, requestGoogleToken } from './storage/google-drive.ts';
import type { OAuthClient } from './storage/google-drive.ts';
import { loadStorageKey } from './storage/key.ts';

async function receiveCode(client: OAuthClient) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const listener = createServer();
  await new Promise<void>((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as AddressInfo;
  const redirect = `http://127.0.0.1:${port}/oauth/callback`;
  const parameters = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirect, response_type: 'code',
    scope: googleDriveScope, access_type: 'offline', prompt: 'consent', state,
    code_challenge: challenge, code_challenge_method: 'S256' });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      listener.on('request', (request, response) => {
        const url = URL.parse(request.url ?? '/', redirect);
        const matching = request.method === 'GET' && url?.pathname === '/oauth/callback'
          && url.searchParams.get('state') === state && url.origin === new URL(redirect).origin;
        const value = matching ? url.searchParams.get('code') : null;
        response.writeHead(value ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Connection: 'close' });
        response.end(value ? 'Google authorization received. Return to your terminal.' : 'This authorization response could not be used.', () => {
          if (value) resolve(value);
          else if (matching && url.searchParams.has('error')) reject(new Error('Google authorization was declined.'));
        });
      });
      timeout = setTimeout(() => reject(new Error('Google authorization timed out. Run the command again.')), 5 * 60_000);
      console.log('Open this URL in a browser on this computer, then return to the terminal.');
      console.log('https://accounts.google.com/o/oauth2/v2/auth?' + parameters);
    });
    return { code, redirect_uri: redirect, code_verifier: verifier };
  } finally {
    clearTimeout(timeout);
    listener.close();
    listener.closeAllConnections();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const usage = 'npm run google-drive:connect -w server -- <desktop-client-json>';
  if (args[0] === '--help') {
    console.log(usage);
    return;
  }
  if (args.length !== 1) throw new Error(usage);
  const { installed } = JSON.parse((await readFile(args[0], 'utf8')).replace(/^\uFEFF/, ''));
  if (typeof installed?.client_id !== 'string' || !installed.client_id.endsWith('.apps.googleusercontent.com')
    || typeof installed.client_secret !== 'string' || !installed.client_secret) {
    throw new Error('Provide the downloaded JSON for a Google Desktop app OAuth client.');
  }
  const client = { clientId: installed.client_id as string, clientSecret: installed.client_secret as string };
  const { dataDir } = loadConfig();
  const lock = lockDrive(dataDir);
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(dataDir);
    const master = await loadStorageKey(dataDir, db);
    const authorization = await receiveCode(client);
    const tokens = await requestGoogleToken(client, { grant_type: 'authorization_code', ...authorization });
    if (!tokens.refreshToken) throw new Error('Google did not return an offline refresh token. Run the consent flow again.');
    const binding = await googleBinding(client.clientId, tokens.accessToken);
    bindGoogleDrive(db, binding);
    await writeGoogleCredentials(dataDir, master, { ...client, binding, refreshToken: tokens.refreshToken, clientType: 'installed' });
    db.exec('UPDATE google_drive_replicas SET retry_at = 0 WHERE verified = 0');
    console.log('Google Drive authorized. Start Blackbox Store to copy eligible files.');
  } finally {
    try { db?.close(); } finally { lock.close(); }
  }
}

main().catch((error: unknown) => {
  // Unstructured errors can contain OAuth URLs or credential-file content.
  const message = error instanceof SyntaxError ? 'The Desktop OAuth JSON could not be read.'
    : error instanceof TypeError ? 'The Google connection could not be completed.'
      : error instanceof Error ? error.message : 'The Google connection could not be completed.';
  console.error(message);
  process.exitCode = 1;
});
