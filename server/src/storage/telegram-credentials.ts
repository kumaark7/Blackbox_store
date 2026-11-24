import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { readSealedJson, writeSealedJson } from './sealed-json.ts';
import { MtprotoChannel } from './telegram-mtproto.ts';
import { TelegramStorage } from './telegram.ts';
import type { TelegramLogin } from './telegram-mtproto.ts';

const id = z.string().regex(/^[1-9][0-9]{0,15}$/);
const application = z.strictObject({
  apiId: z.number().int().min(1).max(2_147_483_647),
  apiHash: z.string().regex(/^[0-9a-f]{32}$/i),
  channelId: id,
});
const login = application.extend({
  session: z.string().min(16).max(2048).regex(/^[A-Za-z0-9+/=_-]+$/),
  userId: id,
  accessHash: z.string().regex(/^-?[0-9]{1,19}$/),
});

const credentialId = '00000000-0000-0000-0000-000000000003';
const credentialPath = (dataDir: string) => join(dataDir, 'telegram.credentials');
const bindingOf = ({ userId, channelId }: TelegramLogin) => createHash('sha256')
  .update(JSON.stringify([userId, channelId])).digest('hex');
const storedBinding = (db: DatabaseSync) => db.prepare('SELECT binding FROM telegram_account WHERE id = 1').get()?.binding;

export function telegramApplication(value: unknown) {
  const result = application.safeParse(value);
  if (!result.success) throw new Error('Provide the Telegram apiId, apiHash and numeric channelId in the setup JSON.');
  return result.data;
}

export async function bindTelegram(db: DatabaseSync, dataDir: string, key: Buffer, authorized: TelegramLogin) {
  const result = login.safeParse(authorized);
  if (!result.success) throw new Error('Telegram returned an invalid account session.');
  const binding = bindingOf(result.data);
  const current = storedBinding(db);
  if (current && binding !== current) throw new Error('Reconnect the original Telegram account and private channel.');
  await writeSealedJson(credentialPath(dataDir), key, credentialId, result.data);
  db.prepare('INSERT OR IGNORE INTO telegram_account (id, binding) VALUES (1, ?)').run(binding);
  db.exec('UPDATE telegram_replicas SET retry_at = 0 WHERE verified = 0');
}

export async function openTelegram(db: DatabaseSync, dataDir: string, key: Buffer, clientDir?: string) {
  const expected = storedBinding(db);
  if (!expected) return null;
  const stored = login.safeParse(await readSealedJson(credentialPath(dataDir), key, credentialId));
  if (!stored.success || expected !== bindingOf(stored.data)) return null;
  return new TelegramStorage(db, new MtprotoChannel(stored.data, clientDir));
}
