import { resolve } from 'node:path';
import { z } from 'zod';

const environment = z.object({
  HOST: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4174),
  APP_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  DATA_DIR: z.string().min(1).default('../.data'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1_073_741_824),
  MAX_CONCURRENT_UPLOADS: z.coerce.number().int().min(1).max(8).default(2),
  UPLOAD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(86_400_000).default(7_200_000),
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
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
    maxUploadBytes: values.MAX_UPLOAD_BYTES, maxConcurrentUploads: values.MAX_CONCURRENT_UPLOADS,
    uploadTimeoutMs: values.UPLOAD_TIMEOUT_MS, sessionSeconds: values.SESSION_HOURS * 3600,
  };
}

export type Config = ReturnType<typeof loadConfig>;
