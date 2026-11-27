import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { OwnerAuth } from '../auth/owner.ts';
import type { Config } from '../config.ts';
import { DriveError } from '../errors.ts';
import type { Drive } from '../files/drive.ts';
import { bindGoogleDrive, readGoogleCredentials, removeGoogleCredentials, writeGoogleCredentials } from '../storage/google-drive-credentials.ts';
import { googleBinding, googleDriveScope, GoogleDriveStorage, requestGoogleToken } from '../storage/google-drive.ts';
import { loadStorageKey } from '../storage/key.ts';
import { managedMega, obscureMegaPassword, readMegaCredentials, saveMegaCredentials } from '../storage/mega-credentials.ts';
import { connectMega, openMega } from '../storage/mega-rclone.ts';
import { bindTelegram, openTelegram, telegramApplication } from '../storage/telegram-credentials.ts';
import { authorizeTelegram } from '../storage/telegram-mtproto.ts';
import { TelegramUploadBot, uploadBotInput } from '../storage/telegram-upload-bot.ts';
import { bindTerabox, exchangeTeraboxDevice, exchangeTeraboxWeb, readTeraboxAuth, readTeraboxCredentials,
  requestTeraboxDevice, teraboxApplication } from '../storage/terabox-auth.ts';
import type { TeraboxApplication, TeraboxTokens } from '../storage/terabox-auth.ts';
import { TeraboxStorage } from '../storage/terabox.ts';

const secret = z.string().min(1).max(1024);
export const connectionInput = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('googleDrive') }),
  z.strictObject({ provider: z.literal('mega'), email: z.email().max(254),
    password: secret.refine((value) => !/[\r\n]/.test(value) && Buffer.byteLength(value) <= 1024),
    folder: z.string().max(180).regex(/^[\w-]+(?:\/[\w-]+)*$/).optional() }),
  z.strictObject({ provider: z.literal('terabox'), method: z.enum(['web', 'qr']).default('qr') }),
  z.strictObject({ provider: z.literal('telegram'), apiId: z.number().int().min(1).max(2_147_483_647),
    apiHash: z.string().regex(/^[a-f0-9]{32}$/i), channelId: z.string().regex(/^[1-9][0-9]{0,15}$/) }),
  uploadBotInput.extend({ provider: z.literal('telegramBot') }),
]);
type Input = z.infer<typeof connectionInput>;
type Step = { kind: 'google'; url: string } | { kind: 'qr' } | { kind: 'input'; id: string; message: string }
  | { kind: 'teraboxWeb'; id: string; url: string };
type Job = {
  owner: string; provider: Input['provider']; controller: AbortController; signal: AbortSignal;
  status: 'pending' | 'connected' | 'failed'; error?: string; step?: Step;
  reply?: (value: string) => void; state?: string; qr?: { bytes: Buffer; type: string };
  ready?: () => void;
};

const googleCallback = '/api/connections/google/callback';
const nonce = () => randomBytes(24).toString('base64url');
const mismatch = /^(Use the original|Reconnect the original|The specified channel|Install the Telegram|Sign in as the Telegram)/;

export class Connections {
  private job?: Job;
  private running?: Promise<void>;
  private closed = false;
  private readonly drive: Drive;
  private readonly auth: OwnerAuth;
  private readonly config: Config;
  private readonly uploadBot: TelegramUploadBot;
  private googleClient: Config['googleOAuth'];
  private teraApp?: TeraboxApplication;

  constructor(drive: Drive, auth: OwnerAuth, config: Config) {
    this.drive = drive;
    this.auth = auth;
    this.config = config;
    this.googleClient = config.googleOAuth;
    this.teraApp = config.teraboxApplication;
    this.uploadBot = new TelegramUploadBot(drive, config.dataDir, config.maxUploadBytes, config.uploadTimeoutMs);
  }

  async restore() {
    const { db } = this.drive.index;
    const dir = this.config.dataDir;
    const key = await loadStorageKey(dir, db, true);
    const [google, tera] = await Promise.all([
      readGoogleCredentials(dir, key).catch(() => null), readTeraboxCredentials(db, dir, key).catch(() => null),
      this.uploadBot.restore(),
    ]);
    if (google) {
      const { clientId, clientSecret, clientType } = google;
      this.googleClient = { clientId, clientSecret, clientType: clientType
        ?? (this.config.googleOAuth?.clientId === clientId ? this.config.googleOAuth.clientType : this.config.secureCookies ? 'web' : 'installed') };
    }
    if (tera) this.teraApp = teraboxApplication(tera);
  }

  status(owner: string) {
    const job = this.job;
    return {
      providers: { googleDrive: this.drive.googleDrive.status(), mega: this.drive.mega.status(),
        terabox: this.drive.terabox.status(), telegram: this.drive.telegram.status(), telegramBot: this.uploadBot.status() },
      telegramBotUsername: this.uploadBot.username,
      googleReady: Boolean(this.googleClient && !(this.googleClient.clientType === 'installed' && this.config.secureCookies)),
      teraboxReady: Boolean(this.teraApp),
      flow: job?.owner === owner ? { provider: job.provider, status: job.status, error: job.error, step: job.step } : null,
    };
  }

  async disconnectGoogle(owner: string) {
    if (this.closed || this.running) throw new DriveError(409, 'Wait for the current account connection to finish.');
    this.running = this.drive.replaceCloudConnection(this.drive.googleDrive, async () => {
      await removeGoogleCredentials(this.config.dataDir);
      return null;
    });
    try {
      await this.running;
      if (this.job?.provider === 'googleDrive') this.job = undefined;
      return this.status(owner);
    } finally {
      this.running = undefined;
    }
  }

  async start(owner: string, input: Input) {
    if (this.closed || this.running) throw new DriveError(409, 'An account connection is already in progress.');
    if (input.provider === 'terabox' && !this.teraApp) {
      throw new DriveError(503, 'TeraBox sign-in is unavailable until the site administrator enables it.');
    }
    const controller = new AbortController();
    const job: Job = { owner, provider: input.provider, controller, status: 'pending',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]) };
    const ready = input.provider === 'googleDrive' ? new Promise<void>((resolve) => { job.ready = resolve; }) : undefined;
    this.job = job;
    this.running = this.connect(job, input).then(() => { job.status = 'connected'; }).catch((error: unknown) => {
      job.status = 'failed';
      job.error = job.signal.aborted ? 'The connection expired or was canceled. Start again.'
        : error instanceof DriveError || (error instanceof Error && mismatch.test(error.message)) ? error.message
          : 'The provider connection failed. Check your credentials and setup, then try again.';
    }).finally(() => {
      job.ready?.();
      delete job.step; delete job.state; delete job.qr; delete job.reply;
      this.running = undefined;
    });
    await ready;
    return this.status(owner);
  }

  answer(owner: string, id: string, value: string) {
    const job = this.job;
    if (job?.owner !== owner || (job.step?.kind !== 'input' && job.step?.kind !== 'teraboxWeb')
      || job.step.id !== id || !job.reply || job.signal.aborted) {
      throw new DriveError(409, 'This login prompt has expired.');
    }
    job.reply(value);
  }

  googleResponse(state: string, code?: string) {
    const job = this.job;
    if (!job?.state || job.state !== state || job.signal.aborted || !this.auth.authenticated(job.owner)) return false;
    if (code && job.reply) job.reply(code);
    else job.controller.abort();
    return true;
  }

  qr(owner: string) {
    const job = this.job;
    if (job?.owner !== owner || !job.qr || job.signal.aborted) throw new DriveError(404, 'No QR code is available.');
    return job.qr;
  }

  cancel(owner: string) {
    if (this.job?.owner === owner) this.job.controller.abort();
  }

  cancelRevoked() {
    if (this.job && !this.auth.authenticated(this.job.owner)) this.job.controller.abort();
  }

  async close() {
    this.closed = true;
    this.job?.controller.abort();
    await this.running;
    await this.uploadBot.stop();
  }

  private prompt(job: Job, step: Step) {
    job.signal.throwIfAborted();
    job.step = step;
    return new Promise<string>((resolve, reject) => {
      const abort = () => { delete job.reply; reject(job.signal.reason); };
      job.signal.addEventListener('abort', abort, { once: true });
      job.reply = (value) => {
        job.signal.removeEventListener('abort', abort);
        delete job.reply; delete job.state; delete job.step;
        resolve(value);
      };
      job.ready?.();
    });
  }

  private check(job: Job) {
    job.signal.throwIfAborted();
    if (!this.auth.authenticated(job.owner)) throw new DriveError(403, 'Sign in again and restart the connection.');
  }

  private async connect(job: Job, input: Input) {
    const { db } = this.drive.index;
    const { dataDir } = this.config;
    const key = await loadStorageKey(dataDir, db, true);
    this.check(job);
    switch (input.provider) {
      case 'googleDrive': {
        if (!this.googleClient) throw new DriveError(503, 'Google Drive sign-in is unavailable until the site administrator enables it.');
        const { clientId, clientSecret, clientType } = this.googleClient;
        if (clientType === 'installed' && this.config.secureCookies) {
          throw new DriveError(400, 'Use a Google Web application OAuth client for this HTTPS site.');
        }
        const client = { clientId, clientSecret };
        const redirect = this.config.origin + googleCallback;
        const verifier = nonce() + nonce();
        job.state = nonce();
        const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code',
          scope: googleDriveScope, access_type: 'offline', prompt: 'consent', state: job.state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
        const code = await this.prompt(job, { kind: 'google', url: 'https://accounts.google.com/o/oauth2/v2/auth?' + query });
        this.check(job);
        const tokens = await requestGoogleToken(client, { grant_type: 'authorization_code', code,
          redirect_uri: redirect, code_verifier: verifier }, fetch, job.signal);
        if (!tokens.refreshToken) throw new DriveError(503, 'Google did not return offline access. Retry the consent flow.');
        const binding = await googleBinding(clientId, tokens.accessToken);
        const credentials = { ...client, clientType, binding, refreshToken: tokens.refreshToken };
        await this.drive.replaceCloudConnection(this.drive.googleDrive, async () => {
          this.check(job);
          bindGoogleDrive(db, binding);
          await writeGoogleCredentials(dataDir, key, credentials);
          db.exec('UPDATE google_drive_replicas SET retry_at = 0 WHERE verified = 0');
          return new GoogleDriveStorage(credentials);
        });
        this.googleClient = { ...client, clientType };
        break;
      }
      case 'mega': {
        const obscured = await obscureMegaPassword(this.config.megaExecutable, input.password, job.signal);
        const saved = await readMegaCredentials(dataDir, key).catch(() => null);
        const folder = input.folder ?? saved?.folder ?? this.config.mega?.remote.split(':')[1] ?? 'BlackboxStore';
        const credentials = { email: input.email, obscured, folder };
        const mega = managedMega(credentials, this.config.megaExecutable);
        await this.drive.replaceCloudConnection(this.drive.mega, async () => {
          this.check(job);
          await connectMega(db, mega, undefined, job.signal);
          this.check(job);
          await saveMegaCredentials(dataDir, key, credentials);
          const provider = openMega(db, mega);
          if (!provider) throw new Error('MEGA configuration was unavailable.');
          return provider;
        });
        break;
      }
      case 'terabox': {
        const app = teraboxApplication(this.teraApp);
        if (input.method === 'web') {
          const url = 'https://www.terabox.com/wap/outside/login?' + new URLSearchParams({ clientId: app.clientId });
          const code = await this.prompt(job, { kind: 'teraboxWeb', id: nonce(), url });
          this.check(job);
          await this.installTerabox(job, key, app, await exchangeTeraboxWeb(app, code, job.signal));
          break;
        }
        const device = await requestTeraboxDevice(app, job.signal);
        const prefix = /^data:image\/(png|jpeg);base64,/i;
        const image = device.image.replace(prefix, '');
        if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(image) || image.length > 200_000) throw new Error('Invalid QR image.');
        const bytes = Buffer.from(image, 'base64');
        const type = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
          : bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) ? 'image/jpeg' : undefined;
        if (!type) throw new Error('Invalid QR format.');
        job.qr = { bytes, type };
        job.step = { kind: 'qr' };
        const signal = AbortSignal.any([job.signal, AbortSignal.timeout(device.expiresIn * 1000)]);
        for (;;) {
          await delay(device.interval * 1000, undefined, { signal });
          this.check(job);
          const tokens = await exchangeTeraboxDevice(app, device.code, signal);
          if (!tokens) continue;
          delete job.qr; delete job.step;
          await this.installTerabox(job, key, app, tokens);
          break;
        }
        break;
      }
      case 'telegram': {
        const { apiId, apiHash, channelId } = input;
        const login = await authorizeTelegram(telegramApplication({ apiId, apiHash, channelId }),
          (message) => this.prompt(job, { kind: 'input', id: nonce(), message }), this.config.telegramClientDir, job.signal);
        await this.drive.replaceCloudConnection(this.drive.telegram, async () => {
          this.check(job);
          await bindTelegram(db, dataDir, key, login);
          const provider = await openTelegram(db, dataDir, key, this.config.telegramClientDir);
          if (!provider) throw new Error('Telegram credentials were unavailable.');
          return provider;
        });
        break;
      }
      case 'telegramBot': {
        const { botToken, ownerId } = input;
        await this.uploadBot.connect({ botToken, ownerId }, key, job.signal, () => this.check(job));
        break;
      }
    }
  }

  private async installTerabox(job: Job, key: Buffer, app: TeraboxApplication, tokens: TeraboxTokens) {
    const { db } = this.drive.index;
    const { dataDir } = this.config;
    await this.drive.replaceCloudConnection(this.drive.terabox, async () => {
      this.check(job);
      await bindTerabox(db, dataDir, key, app, tokens, job.signal);
      const auth = await readTeraboxAuth(db, dataDir, key);
      if (!auth) throw new Error('TeraBox credentials were unavailable.');
      return new TeraboxStorage(auth);
    });
    this.teraApp = app;
  }
}
