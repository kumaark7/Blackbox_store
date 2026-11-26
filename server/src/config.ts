import { resolve } from 'node:path';
import { z } from 'zod';
import { megaRemotePattern } from './storage/mega-rclone.ts';

const environment = z.object({
  HOST: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4174),
  APP_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  DATA_DIR: z.string().min(1).default('../.data'),
  CLOUD_ONLY_UPLOADS: z.enum(['true', 'false']).optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1_073_741_824),
  MAX_CONCURRENT_UPLOADS: z.coerce.number().int().min(1).max(8).default(2),
  UPLOAD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(86_400_000).default(7_200_000),
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  MEGA_RCLONE_REMOTE: z.string().regex(megaRemotePattern).optional(),
  MEGA_RCLONE_CONFIG: z.string().min(1).optional(),
  MEGA_RCLONE_EXECUTABLE: z.string().min(1).default('rclone'),
  TELEGRAM_CLIENT_DIR: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().regex(/^[\w-]+\.apps\.googleusercontent\.com$/).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).max(1024).optional(),
  GOOGLE_OAUTH_CLIENT_TYPE: z.enum(['web', 'installed']).default('web'),
  TERABOX_CLIENT_ID: z.string().min(1).optional(),
  TERABOX_CLIENT_SECRET: z.string().min(1).optional(),
  TERABOX_PRIVATE_SECRET: z.string().min(1).optional(),
  TERABOX_APP_FOLDER: z.string().min(1).optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const values = environment.parse(env);
  const origin = new URL(values.APP_ORIGIN);
  const secureCookies = origin.protocol === 'https:';
  if (
    (origin.protocol !== 'http:' && !secureCookies) ||
    origin.origin !== values.APP_ORIGIN ||
    (!secureCookies && !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname))
  ) {
    throw new Error('APP_ORIGIN must be an exact HTTPS origin or a loopback HTTP origin.');
  }
  return {
    host: values.HOST, port: values.PORT, origin: origin.origin, secureCookies,
    dataDir: resolve(values.DATA_DIR),
    cloudOnly: values.CLOUD_ONLY_UPLOADS === undefined ? secureCookies : values.CLOUD_ONLY_UPLOADS === 'true',
    maxUploadBytes: values.MAX_UPLOAD_BYTES, maxConcurrentUploads: values.MAX_CONCURRENT_UPLOADS,
    uploadTimeoutMs: values.UPLOAD_TIMEOUT_MS, sessionSeconds: values.SESSION_HOURS * 3600,
    mega: values.MEGA_RCLONE_REMOTE ? { remote: values.MEGA_RCLONE_REMOTE, executable: values.MEGA_RCLONE_EXECUTABLE,
      configPath: values.MEGA_RCLONE_CONFIG && resolve(values.MEGA_RCLONE_CONFIG) } : undefined,
    megaExecutable: values.MEGA_RCLONE_EXECUTABLE,
    telegramClientDir: values.TELEGRAM_CLIENT_DIR && resolve(values.TELEGRAM_CLIENT_DIR),
    googleOAuth: values.GOOGLE_OAUTH_CLIENT_ID && values.GOOGLE_OAUTH_CLIENT_SECRET ? {
      clientId: values.GOOGLE_OAUTH_CLIENT_ID, clientSecret: values.GOOGLE_OAUTH_CLIENT_SECRET,
      clientType: values.GOOGLE_OAUTH_CLIENT_TYPE,
    } : undefined,
    teraboxApplication: values.TERABOX_CLIENT_ID && values.TERABOX_CLIENT_SECRET && values.TERABOX_PRIVATE_SECRET && values.TERABOX_APP_FOLDER ? {
      clientId: values.TERABOX_CLIENT_ID, clientSecret: values.TERABOX_CLIENT_SECRET,
      privateSecret: values.TERABOX_PRIVATE_SECRET, appFolder: values.TERABOX_APP_FOLDER,
    } : undefined,
  };
}

export type Config = ReturnType<typeof loadConfig>;
