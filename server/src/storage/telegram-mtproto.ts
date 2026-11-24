import { createRequire } from 'node:module';
import { join } from 'node:path';
import { telegramUnavailable } from './telegram.ts';
import type { TelegramChannel, TelegramPost } from './telegram.ts';

export type TelegramApplication = { apiId: number; apiHash: string; channelId: string };
export type TelegramLogin = TelegramApplication & { session: string; userId: string; accessHash: string };
type Session = { save(): string };
type Long = { toString(): string };
type User = { id: Long; bot?: boolean };
type Channel = { id: Long; accessHash?: Long; creator?: boolean; broadcast?: boolean; left?: boolean;
  username?: string; usernames?: { active?: boolean }[] };
type Message = { id: number; className?: string; message?: string; document?: { size?: Long } };
type Authentication = { phoneNumber: () => Promise<string>; phoneCode: () => Promise<string>;
  password: () => Promise<string>; onError: () => never };
type Client = {
  start(auth: Authentication): Promise<void>;
  connect(): Promise<unknown>;
  destroy(): Promise<void>;
  setLogLevel(level: string): void;
  getMe(): Promise<User | undefined>;
  getEntity(peer: unknown): Promise<unknown>;
  iterDialogs(): AsyncIterable<{ entity?: unknown }>;
  getMessages(peer: unknown, options: { limit: number } | { ids: number[] }): Promise<(Message | undefined)[]>;
  iterMessages(peer: unknown, options: { minId: number; limit: number; reverse: boolean }): AsyncIterable<Message>;
  uploadFile(options: { file: unknown; workers: number; maxBufferSize: number; onProgress: (value: number) => void }): Promise<unknown>;
  invoke(request: unknown): Promise<unknown>;
  iterDownload(message: Message, options: { signal: AbortSignal; requestTimeout: number }): AsyncIterable<Buffer>;
};
type TlConstructor = new (fields: Record<string, unknown>) => unknown;
type Api = { Channel: new (...args: never[]) => Channel; InputPeerChannel: TlConstructor; InputChannel: TlConstructor;
  InputMediaUploadedDocument: TlConstructor; DocumentAttributeFilename: TlConstructor;
  messages: { SendMedia: TlConstructor }; channels: { DeleteMessages: TlConstructor } };

const maxCiphertextBytes = 2_000_000_000;
const requestMs = 30_000;

function loadLibrary(clientDir?: string) {
  try {
    const require = createRequire(clientDir ? join(clientDir, 'package.json') : import.meta.url);
    const { TelegramClient, Api } = require('teleproto') as {
      TelegramClient: new (session: Session, apiId: number, apiHash: string, options: Record<string, unknown>) => Client;
      Api: Api;
    };
    const { StringSession } = require('teleproto/sessions') as { StringSession: new (session?: string) => Session };
    const { CustomFile } = require('teleproto/client/uploads') as {
      CustomFile: new (name: string, size: number, path: string) => unknown;
    };
    const long = createRequire(require.resolve('teleproto'))('big-integer') as (value: string) => Long;
    return { TelegramClient, Api, StringSession, CustomFile, long };
  } catch {
    throw new Error('Install the Telegram MTProto client and check TELEGRAM_CLIENT_DIR. See docs/TELEGRAM_SETUP.md.');
  }
}

function clientFrom(library: ReturnType<typeof loadLibrary>, app: TelegramApplication, session: Session) {
  const client = new library.TelegramClient(session, app.apiId, app.apiHash, {
    connectionRetries: 2, requestRetries: 2, floodSleepThreshold: 0,
    maxConcurrentDownloads: 1,
  });
  client.setLogLevel('none');
  return client;
}

function privateChannel(api: Api, entity: unknown, id: string): entity is Channel {
  return entity instanceof api.Channel && entity.id.toString() === id && entity.broadcast === true
    && entity.creator === true && !entity.left && !entity.username && !entity.usernames?.some(({ active }) => active);
}

export async function authorizeTelegram(app: TelegramApplication, ask: (message: string) => Promise<string>,
  clientDir?: string, signal?: AbortSignal) {
  const library = loadLibrary(clientDir);
  const session = new library.StringSession();
  const client = clientFrom(library, app, session);
  try {
    const authorize = async () => {
      await client.start({
        phoneNumber: () => ask('Telegram phone number with country code'),
        phoneCode: () => ask('Telegram login code'),
        password: () => ask('Telegram two-step verification password'),
        onError: () => { throw new Error('Telegram sign-in failed. Check your credentials and try again.'); },
      });
      signal?.throwIfAborted();
      const user = await client.getMe();
      if (!user || user.bot) throw new Error('Sign in as the Telegram account that owns the private channel.');
      for await (const { entity } of client.iterDialogs()) {
        signal?.throwIfAborted();
        if (privateChannel(library.Api, entity, app.channelId) && entity.accessHash) {
          const saved = session.save();
          if (!saved) throw telegramUnavailable();
          return { ...app, session: saved, userId: user.id.toString(), accessHash: entity.accessHash.toString() };
        }
      }
      throw new Error('The specified channel must be a private broadcast channel owned by this account.');
    };
    if (!signal) return await authorize();
    let abort = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      signal.throwIfAborted();
      return await Promise.race([authorize(), stopped]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  } finally {
    await client.destroy();
  }
}

async function bounded<T>(signal: AbortSignal, operation: () => Promise<T>) {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation(), cancelled]);
  } catch {
    throw telegramUnavailable();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export class MtprotoChannel implements TelegramChannel {
  private readonly library: ReturnType<typeof loadLibrary>;
  private readonly client: Client;
  private readonly login: TelegramLogin;
  private readonly peer: unknown;
  private readonly channel: unknown;
  private connected?: Promise<void>;

  constructor(login: TelegramLogin, clientDir?: string) {
    this.login = login;
    this.library = loadLibrary(clientDir);
    const { Api, long, StringSession } = this.library;
    this.client = clientFrom(this.library, login, new StringSession(login.session));
    const params = { channelId: long(login.channelId), accessHash: long(login.accessHash) };
    this.peer = new Api.InputPeerChannel(params);
    this.channel = new Api.InputChannel(params);
  }

  async check(signal: AbortSignal) {
    await bounded(AbortSignal.any([signal, AbortSignal.timeout(requestMs)]), async () => {
      this.connected ??= (async () => {
        await this.client.connect();
        const user = await this.client.getMe();
        if (!user || user.bot || user.id.toString() !== this.login.userId) throw telegramUnavailable();
      })().catch((error: unknown) => { this.connected = undefined; throw error; });
      await this.connected;
      const entity = await this.client.getEntity(this.peer);
      if (!privateChannel(this.library.Api, entity, this.login.channelId)) throw telegramUnavailable();
    });
  }

  async latestId(signal: AbortSignal) {
    const [latest] = await bounded(AbortSignal.any([signal, AbortSignal.timeout(requestMs)]),
      () => this.client.getMessages(this.peer, { limit: 1 }));
    return latest?.id ?? 0;
  }

  private async message(id: number, signal: AbortSignal) {
    const [message] = await bounded(AbortSignal.any([signal, AbortSignal.timeout(requestMs)]),
      () => this.client.getMessages(this.peer, { ids: [id] }));
    return message?.className === 'MessageEmpty' ? undefined : message;
  }

  private post(message: Message): TelegramPost {
    const size = message.document?.size;
    return { id: message.id, caption: message.message ?? '', bytes: size === undefined ? null : Number(size.toString()) };
  }

  async byId(id: number, signal: AbortSignal) {
    const message = await this.message(id, signal);
    return message ? this.post(message) : null;
  }

  async find(caption: string, after: number, signal: AbortSignal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    return bounded(deadline, async () => {
      for await (const message of this.client.iterMessages(this.peer, { minId: after, limit: Infinity, reverse: true })) {
        deadline.throwIfAborted();
        if (message.message === caption) return this.post(message);
      }
      return null;
    });
  }

  async send(caption: string, randomId: string, path: string, bytes: number, signal: AbortSignal) {
    if (bytes > maxCiphertextBytes) throw telegramUnavailable();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
    const { Api, CustomFile, long } = this.library;
    const fileName = caption + '.bbs';
    await bounded(deadline, async () => {
      const file = await this.client.uploadFile({ file: new CustomFile(fileName, bytes, path), workers: 1,
        maxBufferSize: 8 * 1024 * 1024, onProgress: () => deadline.throwIfAborted() });
      deadline.throwIfAborted();
      const media = new Api.InputMediaUploadedDocument({
        file, mimeType: 'application/octet-stream', forceFile: true,
        attributes: [new Api.DocumentAttributeFilename({ fileName })],
      });
      await this.client.invoke(new Api.messages.SendMedia({ peer: this.peer, media, message: caption, randomId: long(randomId), silent: true }));
    });
  }

  async *download(id: number, signal: AbortSignal) {
    const message = await this.message(id, signal);
    if (!message?.document) throw telegramUnavailable();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
    yield* this.client.iterDownload(message, { signal: deadline, requestTimeout: requestMs });
  }

  async delete(id: number, signal: AbortSignal) {
    await bounded(AbortSignal.any([signal, AbortSignal.timeout(requestMs)]),
      () => this.client.invoke(new this.library.Api.channels.DeleteMessages({ channel: this.channel, id: [id] })));
  }

  close() {
    return this.client.destroy();
  }
}
