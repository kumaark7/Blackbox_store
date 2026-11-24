import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { DriveError } from '../errors.ts';
import type { Ciphertext, CloudProvider } from './adapter.ts';

export type TelegramPost = { id: number; caption: string; bytes: number | null };

export interface TelegramChannel {
  check(signal: AbortSignal): Promise<void>;
  latestId(signal: AbortSignal): Promise<number>;
  byId(id: number, signal: AbortSignal): Promise<TelegramPost | null>;
  find(caption: string, after: number, signal: AbortSignal): Promise<TelegramPost | null>;
  send(caption: string, randomId: string, path: string, bytes: number, signal: AbortSignal): Promise<void>;
  download(id: number, signal: AbortSignal): AsyncIterable<Buffer>;
  delete(id: number, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export function telegramUnavailable() {
  return new DriveError(503, 'Telegram could not complete the operation. Check the private channel connection and retry.');
}

const messageId = (id: number) => Number.isInteger(id) && id >= 0 && id <= 2_147_483_647;
const replicaId = /^(0|[1-9][0-9]{0,9}):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export class TelegramStorage implements CloudProvider {
  private readonly db: DatabaseSync;
  private readonly channel: TelegramChannel;

  constructor(db: DatabaseSync, channel: TelegramChannel) {
    this.db = db;
    this.channel = channel;
  }

  async allocate(signal: AbortSignal) {
    await this.channel.check(signal);
    const last = await this.channel.latestId(signal);
    if (!messageId(last)) throw telegramUnavailable();
    return last + ':' + randomUUID();
  }

  private async locate(id: string, signal: AbortSignal) {
    const match = replicaId.exec(id);
    if (!match || !messageId(Number(match[1]))) throw telegramUnavailable();
    const after = Number(match[1]);
    const caption = 'blackbox-' + match[2];
    await this.channel.check(signal);
    const row = this.db.prepare('SELECT message_id AS messageId FROM telegram_replicas WHERE remote_id = ?').get(id);
    if (!row) throw telegramUnavailable();
    const saved = row.messageId as number | null;
    const post = saved === null ? await this.channel.find(caption, after, signal) : await this.channel.byId(saved, signal);
    if (post) {
      if (post.caption !== caption || !messageId(post.id) || post.id <= after || (saved !== null && saved !== post.id)) {
        throw telegramUnavailable();
      }
      if (saved === null) {
        this.db.prepare('UPDATE telegram_replicas SET message_id = ? WHERE remote_id = ?').run(post.id, id);
      }
    }
    return { caption, post };
  }

  async upload(id: string, object: Ciphertext, sourcePath: string, signal: AbortSignal) {
    const { caption, post } = await this.locate(id, signal);
    if (post) throw telegramUnavailable();
    const randomId = createHash('sha256').update('blackbox telegram post:' + id).digest().readBigInt64LE().toString();
    await this.channel.send(caption, randomId, sourcePath, object.bytes, signal);
  }

  async verify(id: string, object: Ciphertext, signal: AbortSignal) {
    const { post } = await this.locate(id, signal);
    if (!post) return false;
    if (post.bytes !== object.bytes) throw telegramUnavailable();
    const hash = createHash('sha256');
    let total = 0;
    for await (const part of this.channel.download(post.id, signal)) {
      total += part.length;
      if (total > object.bytes) throw telegramUnavailable();
      hash.update(part);
    }
    if (total !== object.bytes || hash.digest('hex') !== object.checksum) throw telegramUnavailable();
    return true;
  }

  async download(id: string, signal: AbortSignal, bytes: number) {
    const { post } = await this.locate(id, signal);
    if (!post || post.bytes !== bytes) throw telegramUnavailable();
    return Readable.from(this.channel.download(post.id, signal), { objectMode: false });
  }

  async delete(id: string, signal: AbortSignal) {
    const { post } = await this.locate(id, signal);
    if (!post) return;
    await this.channel.delete(post.id, signal);
    if (await this.channel.byId(post.id, signal)) throw telegramUnavailable();
  }

  close() {
    return this.channel.close();
  }
}
