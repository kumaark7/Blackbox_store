import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DriveError } from '../errors.ts';
import type { Drive } from '../files/drive.ts';
import { IMPORTANCE, ROOT_ID, validateName } from '../files/index.ts';
import type { Importance } from '../files/index.ts';
import { loadStorageKey } from './key.ts';
import { readSealedJson, writeSealedJson } from './sealed-json.ts';

const credentialId = '00000000-0000-0000-0000-000000000005';
const apiOrigin = 'https://api.telegram.org';
const maxFileBytes = 20_000_000;
const expiry = 15 * 60_000;
const cursorLifetime = 6 * 24 * 60 * 60_000;
const names = { 'highly-important': 'Highly Important', important: 'Important', backup: 'Backup' };
const authFields = {
  botToken: z.string().regex(/^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,200}$/),
  ownerId: z.string().regex(/^[1-9][0-9]{0,15}$/),
};
export const uploadBotInput = z.strictObject(authFields);
type BotInput = z.infer<typeof uploadBotInput>;
const stored = uploadBotInput.extend({
  botId: z.string().regex(/^[1-9][0-9]{4,19}$/), username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
});
type Credentials = z.infer<typeof stored>;
type User = { id: number; is_bot?: boolean };
type Chat = { id: number; type: string };
type Document = { file_id: string; file_name?: string; file_size?: number };
type Message = { message_id: number; chat: Chat; from?: User; document?: Document; text?: string };
type Callback = { id: string; from: User; message?: Message; data?: string };
type Update = { update_id: number; message?: Message; callback_query?: Callback };
type Pending = { name: string; fileId: string; until: number };

class BotApi {
  private readonly base: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(token: string, fetcher: typeof fetch) {
    this.base = apiOrigin + '/bot' + token + '/';
    this.token = token;
    this.fetcher = fetcher;
  }

  async call<T>(method: string, payload: object, signal: AbortSignal, ms = 12_000) {
    const response = await this.fetcher(this.base + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DriveError(503, 'Telegram Bot API refused the request. Check the token or bot configuration.');
    }
    const result = await response.json() as { ok?: boolean; result: T };
    if (result.ok !== true) throw new DriveError(503, 'Telegram Bot API refused the request.');
    return result.result;
  }

  async file(fileId: string, limit: number, signal: AbortSignal) {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId }, signal);
    const path = file.file_path;
    if (!path || !path.split('/').every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')) {
      throw new DriveError(502, 'Telegram returned an invalid file path.');
    }
    if ((file.file_size ?? 0) > limit) throw new DriveError(413, 'The document exceeds this bot’s file limit.');
    const response = await this.fetcher(apiOrigin + '/file/bot' + this.token + '/' + path, { redirect: 'error', signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new DriveError(502, 'Telegram could not provide the file.');
    }
    const body = response.body as unknown as AsyncIterable<Uint8Array>;
    return Readable.from((async function* () {
      let size = 0;
      for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > limit) throw new DriveError(413, 'The document exceeds this bot’s file limit.');
        yield Buffer.from(chunk);
      }
    })(), { objectMode: false });
  }
}

export class TelegramUploadBot {
  private readonly drive: Drive;
  private readonly dataDir: string;
  private readonly limit: number;
  private readonly timeout: number;
  private readonly fetcher: typeof fetch;
  private credentials?: Credentials;
  private controller?: AbortController;
  private running?: Promise<void>;
  private failed = false;
  private retrying = false;

  constructor(drive: Drive, dataDir: string, maxBytes: number, timeout: number, fetcher = fetch) {
    this.drive = drive;
    this.dataDir = dataDir;
    this.limit = Math.min(maxBytes, maxFileBytes);
    this.timeout = timeout;
    this.fetcher = fetcher;
  }

  status() {
    return this.credentials ? this.retrying ? 'retrying' : 'connected' : this.failed ? 'reconnect' : 'off';
  }

  get username() { return this.credentials?.username; }

  async restore() {
    try {
      const { db } = this.drive.index;
      const key = await loadStorageKey(this.dataDir, db, true);
      const raw = await readSealedJson(join(this.dataDir, 'telegram-upload-bot.credentials'), key, credentialId);
      if (raw) this.start(stored.parse(raw));
    } catch {
      this.failed = true;
    }
  }

  async connect(input: BotInput, key: Buffer, signal: AbortSignal, check: () => void) {
    const api = new BotApi(input.botToken, this.fetcher);
    const bot = await api.call<{ id: number; username: string; is_bot: boolean }>('getMe', {}, signal);
    const botId = String(bot.id);
    if (!bot.is_bot || botId !== input.botToken.split(':')[0]) throw new DriveError(400, 'This token does not identify a Telegram bot.');
    const credentials = stored.parse({ ...input, botId, username: bot.username });
    const webhook = await api.call<{ url?: string }>('getWebhookInfo', {}, signal);
    if (webhook.url) throw new DriveError(409, 'Use a dedicated bot without a webhook.');
    const previous = this.credentials;
    check();
    await this.stop();
    try {
      check();
      await writeSealedJson(join(this.dataDir, 'telegram-upload-bot.credentials'), key, credentialId, credentials);
      this.start(credentials);
    } catch (error) {
      if (previous) this.start(previous);
      throw error;
    }
  }

  async stop() {
    this.controller?.abort();
    await this.running;
    this.running = undefined;
  }

  private start(credentials: Credentials) {
    this.credentials = credentials;
    this.retrying = false;
    this.controller = new AbortController();
    this.running = this.poll(credentials, this.controller.signal).catch(() => { this.retrying = true; });
  }

  private async poll(credentials: Credentials, signal: AbortSignal) {
    const api = new BotApi(credentials.botToken, this.fetcher);
    const { db } = this.drive.index;
    const row = db.prepare('SELECT next_update, updated_at FROM telegram_bot_offsets WHERE bot_id = ?').get(credentials.botId);
    const save = db.prepare(`INSERT INTO telegram_bot_offsets (bot_id, next_update, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET next_update = excluded.next_update, updated_at = excluded.updated_at`);
    let offset = Number(row?.next_update ?? 0);
    let updated = Number(row?.updated_at ?? 0);
    const pending = new Map<number, Pending>();
    while (!signal.aborted) {
      try {
        // Telegram may randomize the next update ID after a week without updates.
        if (updated + cursorLifetime < Date.now()) offset = 0;
        const updates = await api.call<Update[]>('getUpdates', {
          offset, timeout: 20, limit: 20, allowed_updates: ['message', 'callback_query'],
        }, signal, 27_000);
        this.retrying = false;
        for (const update of updates) {
          signal.throwIfAborted();
          if (!Number.isSafeInteger(update.update_id + 1) || update.update_id < offset) continue;
          offset = update.update_id + 1;
          updated = Date.now();
          // A restart expires unselected files and avoids replaying an upload already submitted.
          save.run(credentials.botId, offset, updated);
          await this.handle(api, credentials.ownerId, update, pending, signal);
        }
      } catch {
        if (signal.aborted) return;
        this.retrying = true;
        await delay(5_000, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  private async handle(api: BotApi, owner: string, update: Update, pending: Map<number, Pending>, signal: AbortSignal) {
    const send = (text: string, reply_markup?: object) => api.call('sendMessage', { chat_id: owner, text, reply_markup }, signal);
    const allowed = (from: User | undefined, chat: Chat | undefined) =>
      !!from && !from.is_bot && String(from.id) === owner && chat?.type === 'private' && String(chat.id) === owner;
    for (const [id, item] of pending) if (item.until <= Date.now()) pending.delete(id);
    const callback = update.callback_query;
    if (callback) {
      if (!allowed(callback.from, callback.message?.chat)) return;
      const parts = /^(highly-important|important|backup):([0-9]{1,10})$/.exec(callback.data ?? '');
      const importance = parts?.[1] as Importance | undefined;
      const id = Number(parts?.[2]);
      const item = pending.get(id);
      await api.call('answerCallbackQuery', { callback_query_id: callback.id,
        text: item && importance ? 'Uploading to Blackbox Store' : 'This selection expired. Send the file again.' }, signal);
      if (!item || !importance) return;
      pending.delete(id);
      const uploadSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]);
      try {
        const file = await this.drive.upload({ parentId: ROOT_ID, name: item.name, importance, signal: uploadSignal },
          () => api.file(item.fileId, this.limit, uploadSignal));
        await send('Saved ' + file.name + ' in My files as ' + names[importance] + '.');
      } catch (failure) {
        if (!signal.aborted) await send(failure instanceof DriveError && failure.status === 409
          ? 'A file with that name already exists. Rename it and send it again.'
          : 'Blackbox could not finish the upload. Check My files before sending it again.');
      }
      return;
    }
    const message = update.message;
    if (!message || !allowed(message.from, message.chat)) return;
    const doc = message.document;
    if (!doc) {
      if (message.text === '/start') await send('Send a document as a file, then choose its storage priority.');
      return;
    }
    if ((doc.file_size ?? 0) > this.limit) {
      await send('This file exceeds the bot’s limit of ' + this.limit.toLocaleString('en-US') + ' bytes. Use Blackbox Store to upload larger files.');
      return;
    }
    if (pending.size >= 20) {
      await send('Choose a priority for a previous document before sending more.');
      return;
    }
    let name: string;
    try { name = validateName(doc.file_name || 'telegram-' + message.message_id); }
    catch {
      await send('Rename the document and send it again.');
      return;
    }
    pending.set(message.message_id, { name, fileId: doc.file_id, until: Date.now() + expiry });
    await send('Choose a storage priority for ' + name + '.', {
      inline_keyboard: IMPORTANCE.map((importance) => [{ text: names[importance], callback_data: importance + ':' + message.message_id }]),
    });
  }
}
