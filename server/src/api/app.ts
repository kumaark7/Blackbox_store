import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OwnerAuth, passwordInput } from '../auth/owner.ts';
import type { Config } from '../config.ts';
import { DriveError, TeraboxCleanupRequired } from '../errors.ts';
import { Drive } from '../files/drive.ts';
import { IMPORTANCE, ROOT_ID } from '../files/index.ts';
import { checkedPreview, requirePreviewType } from '../files/preview.ts';
import { CHUNK_BYTES } from '../storage/format.ts';
import { cloudUsage, localUsage } from '../storage/usage.ts';
import { connectionInput, Connections } from './connections.ts';

const id = z.uuid();
const itemParams = z.object({ id });
const name = z.string().min(1).max(180);
const importance = z.enum(IMPORTANCE);
const destination = z.strictObject({ parentId: id.default(ROOT_ID), name });
const uploadQuery = destination.extend({ importance });
const transferInput = uploadQuery.extend({ size: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) });
const transferOffset = z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(z.number().int().nonnegative());
const change = z.strictObject({ parentId: id.optional(), name: name.optional(), importance: importance.optional() })
  .refine((input) => Object.values(input).some((value) => value !== undefined));
const listing = z.object({
  parentId: id.default(ROOT_ID),
  search: z.string().trim().min(1).max(180).optional(),
  sort: z.enum(['name', 'updated', 'size']).default('name'),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  trash: z.enum(['0', '1']).optional().transform((value) => value === '1'),
});

function attachment(filename: string) {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => {
    return '%' + character.charCodeAt(0).toString(16).toUpperCase();
  });
  return 'attachment; filename="download"; filename*=UTF-8\'\'' + encoded;
}

async function receiveUpload<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  limit: number,
  timeoutMs: number,
  receive: (source: () => Readable, signal: AbortSignal) => Promise<T>,
) {
  const rawBody = request.body;
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
    throw new DriveError(415, 'Use application/octet-stream to upload files.');
  }
  if (Number(request.headers['content-length']) > limit) {
    reply.header('Connection', 'close');
    throw new DriveError(413, 'The file exceeds the upload limit.');
  }

  const source = rawBody instanceof Readable ? rawBody
    : request.headers['content-length'] === '0' ? Readable.from([]) : null;
  if (!source) throw new DriveError(400, 'The upload body is missing.');
  const timeout = AbortSignal.timeout(timeoutMs);
  const disconnected = new AbortController();
  const abort = () => disconnected.abort();
  const abortOnClose = () => {
    if (!reply.raw.writableFinished) abort();
  };
  const input = new PassThrough();
  request.raw.once('aborted', abort);
  reply.raw.once('close', abortOnClose);
  source.once('error', abort);
  try {
    return await receive(() => source.pipe(input), AbortSignal.any([timeout, disconnected.signal]));
  } catch (error) {
    if (!request.raw.complete) reply.header('Connection', 'close');
    if (timeout.aborted) throw new DriveError(408, 'The upload timed out.');
    if (disconnected.signal.aborted) throw new DriveError(400, 'The upload connection closed.');
    throw error;
  } finally {
    source.unpipe(input);
    request.raw.off('aborted', abort);
    reply.raw.off('close', abortOnClose);
    source.off('error', abort);
    input.destroy();
  }
}

export async function buildApp(config: Config, options: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    disableRequestLogging: true,
    bodyLimit: 16 * 1024,
    exposeHeadRoutes: false,
  });
  const drive = await Drive.open(config.dataDir, config.maxUploadBytes, config.maxConcurrentUploads,
    { mega: config.mega, megaExecutable: config.megaExecutable, telegramClientDir: config.telegramClientDir,
      cloudOnly: config.cloudOnly });
  const auth = new OwnerAuth(drive.index.db, config.sessionSeconds);
  const connections = new Connections(drive, auth, config);
  let cacheCleanup: Promise<void> | undefined;
  const cacheTimer = setInterval(() => {
    cacheCleanup ??= drive.expireCloudTransfers()
      .catch((error) => app.log.error(error, 'Upload cache cleanup failed'))
      .finally(() => { cacheCleanup = undefined; });
  }, 60_000).unref();
  const sessionName = config.secureCookies ? '__Host-blackbox_session' : 'blackbox_session';
  const token = (request: FastifyRequest) => request.cookies[sessionName];
  app.addHook('onClose', async () => {
    clearInterval(cacheTimer);
    try {
      await cacheCleanup;
      await connections.close();
      await Promise.all([drive.googleDrive.stop(), drive.mega.stop(), drive.terabox.stop(), drive.telegram.stop()]);
    } finally { drive.close(); }
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    const frames = request.url.split('?')[0] === '/connections' ? 'blob: https://www.terabox.com' : 'blob:';
    reply.header('Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob:; frame-src " + frames);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof TeraboxCleanupRequired) {
      return reply.code(409).send({ error: error.message, teraboxCleanup: { paths: error.paths, confirmation: error.confirmation } });
    }
    if (error instanceof DriveError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Check the request fields and try again.' });
    const status = typeof error === 'object' && error !== null && 'statusCode' in error
      && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      const message = status === 429 ? 'Too many login attempts. Try again in a minute.'
        : status === 413 ? 'The request exceeds the size limit.'
        : status === 415 ? 'Unsupported request content type.' : 'The request could not be processed.';
      return reply.code(status).send({ error: message });
    }
    request.log.error({ code: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined },
      'API request failed');
    return reply.code(500).send({ error: 'The server could not complete the request.' });
  });

  try {
    await app.register(cookie);
    await app.register(async (api) => {
      await api.register(rateLimit, { global: false });
      api.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
      api.addHook('onRequest', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== config.origin) {
          throw new DriveError(403, 'This request must come from the configured app origin.');
        }
      });

      const sessionOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'strict' as const, path: '/' };

      api.get('/health', async () => ({ ok: true }));
      api.get('/auth/status', async (request) => ({
        authenticated: auth.authenticated(token(request)), configured: auth.configured(),
      }));
      api.post('/auth/login', {
        config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: () => 'owner' } },
      }, async (request, reply) => {
        const input = z.strictObject({ password: passwordInput }).parse(request.body);
        const session = await auth.login(input.password);
        reply.setCookie(sessionName, session, { ...sessionOptions, maxAge: config.sessionSeconds });
        return { authenticated: true };
      });
      api.post('/auth/logout', async (request, reply) => {
        if (token(request)) connections.cancel(token(request)!);
        auth.logout(token(request));
        return reply.clearCookie(sessionName, sessionOptions).code(204).send();
      });
      api.get('/connections/google/callback', async (request, reply) => {
        const result = z.object({ state: z.string().length(32), code: z.string().min(1).max(2048).optional(),
          error: z.string().max(200).optional() }).safeParse(request.query);
        const accepted = result.success && connections.googleResponse(result.data.state, result.data.error ? undefined : result.data.code);
        if (!accepted) return reply.type('text/plain').code(400).send('This Google login request has expired or was invalid.');
        return reply.type('text/html').send('<!doctype html><html lang="en"><meta charset="utf-8"><title>Blackbox Store</title>'
          + '<meta http-equiv="refresh" content="0;url=/connections"><a href="/connections">Return to Blackbox Store</a></html>');
      });

      api.register(async (secured) => {
        secured.addHook('onRequest', async (request) => {
          if (!auth.authenticated(token(request))) throw new DriveError(401, 'Sign in to continue.');
        });
        secured.get('/account/sessions', async (request) => auth.sessionInfo(token(request)!));
        secured.post('/account/sessions/revoke-others', async (request, reply) => {
          auth.revokeOtherSessions(token(request)!);
          connections.cancelRevoked();
          return reply.code(204).send();
        });
        secured.post('/account/password', {
          config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: () => 'owner' } },
        }, async (request, reply) => {
          const input = z.strictObject({ current: passwordInput, password: passwordInput }).parse(request.body);
          await auth.changePassword(token(request)!, input.current, input.password);
          connections.cancelRevoked();
          return reply.clearCookie(sessionName, sessionOptions).code(204).send();
        });
        secured.get('/connections', async (request) => connections.status(token(request)!));
        secured.post('/connections', {
          config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: () => 'owner' } },
        }, async (request, reply) => reply.code(202).send(await connections.start(token(request)!, connectionInput.parse(request.body))));
        secured.post('/connections/answer', async (request, reply) => {
          const { id, value } = z.strictObject({ id: z.string().length(32), value: z.string().min(1).max(1024) }).parse(request.body);
          connections.answer(token(request)!, id, value);
          return reply.code(204).send();
        });
        secured.delete('/connections/flow', async (request, reply) => {
          connections.cancel(token(request)!);
          return reply.code(204).send();
        });
        secured.get('/connections/qr', async (request, reply) => {
          const qr = connections.qr(token(request)!);
          return reply.type(qr.type).send(qr.bytes);
        });
        secured.get('/entries', async (request) => drive.index.browse(listing.parse(request.query)));
        secured.get('/storage', async () => ({ googleDrive: drive.googleDrive.status(), mega: drive.mega.status(),
          terabox: drive.terabox.status(), telegram: drive.telegram.status(), cloudOnly: drive.cloudOnly }));
        secured.get('/storage/usage', async () => {
          const [local, cloud] = await Promise.all([
            drive.cloudOnly ? { appBytes: 0, trashBytes: 0, disk: null }
              : localUsage(config.dataDir, drive.storage.directory, drive.index.trashObjectKeys()),
            cloudUsage(drive),
          ]);
          return { ...local, cloud, cloudOnly: drive.cloudOnly };
        });
        secured.post('/folders', async (request, reply) => {
          const input = destination.parse(request.body);
          return reply.code(201).send(drive.index.createFolder(input.parentId, input.name));
        });
        secured.patch('/entries/:id', async (request) => {
          return drive.index.edit(itemParams.parse(request.params).id, change.parse(request.body));
        });
        secured.delete('/entries/:id', async (request, reply) => {
          drive.index.moveToTrash(itemParams.parse(request.params).id);
          return reply.code(204).send();
        });
        secured.post('/entries/:id/restore', async (request) => {
          return drive.index.restore(itemParams.parse(request.params).id);
        });
        secured.delete('/entries/:id/permanent', async (request, reply) => {
          const input = z.strictObject({ teraboxConfirmation: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(request.body ?? {});
          await drive.purge(itemParams.parse(request.params).id, input.teraboxConfirmation);
          return reply.code(204).send();
        });
        secured.post('/entries/:id/copy', async (request, reply) => {
          const input = destination.parse(request.body);
          const entry = await drive.copy(itemParams.parse(request.params).id, input.parentId, input.name,
            AbortSignal.timeout(config.uploadTimeoutMs));
          return reply.code(201).send(entry);
        });
        secured.post('/uploads', async (request, reply) => {
          const query = uploadQuery.parse(request.query);
          const entry = await receiveUpload(request, reply, config.maxUploadBytes, config.uploadTimeoutMs,
            (source, signal) => drive.upload({ ...query, signal }, source));
          return reply.code(201).send(entry);
        });
        secured.get('/transfers', async () => ({ transfers: drive.listTransfers(), maxUploadBytes: config.maxUploadBytes }));
        secured.post('/transfers', async (request) => drive.startTransfer(transferInput.parse(request.body)));
        secured.get('/transfers/:id', async (request) => drive.transferStatus(itemParams.parse(request.params).id));
        secured.patch('/transfers/:id', async (request, reply) => {
          const { id } = itemParams.parse(request.params);
          const offset = transferOffset.parse(request.headers['upload-offset']);
          return receiveUpload(request, reply, CHUNK_BYTES, config.uploadTimeoutMs,
            (source, signal) => drive.appendTransfer(id, offset, source, signal));
        });
        secured.post('/transfers/:id/complete', async (request) => {
          const { id } = itemParams.parse(request.params);
          const signal = AbortSignal.timeout(config.uploadTimeoutMs);
          try {
            return await drive.finishTransfer(id, signal);
          } catch (error) {
            if (signal.aborted) throw new DriveError(408, 'Upload verification timed out. Retry to finish this upload.');
            throw error;
          }
        });
        secured.delete('/transfers/:id', async (request, reply) => {
          await drive.discardTransfer(itemParams.parse(request.params).id);
          return reply.code(204).send();
        });
        secured.get('/files/:id/download', async (request, reply) => {
          const download = await drive.download(itemParams.parse(request.params).id);
          return reply.type('application/octet-stream')
            .header('Content-Disposition', attachment(download.name))
            .header('Content-Length', download.size)
            .send(download.stream);
        });
        secured.get('/files/:id/preview', async (request, reply) => {
          const { id } = itemParams.parse(request.params);
          const entry = drive.index.get(id);
          if (entry.kind !== 'file' || entry.size === null) throw new DriveError(404, 'File not found.');
          const type = requirePreviewType(entry.name, entry.size);
          const file = await drive.download(id);
          const stream = await checkedPreview(file.stream, type);
          return reply.type(type)
            .header('Content-Disposition', attachment(file.name))
            .header('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'")
            .header('Content-Length', file.size)
            .send(stream);
        });
      });
    }, { prefix: '/api' });

    const webRoot = fileURLToPath(new URL('../../../apps/web/dist/', import.meta.url));
    if (existsSync(join(webRoot, 'index.html'))) {
      await app.register(serveStatic, { root: webRoot, serve: false, cacheControl: false });
      await app.register(serveStatic, { root: join(webRoot, 'assets'), prefix: '/assets/', decorateReply: false, index: false });
      app.get('/login', async (_request, reply) => {
        return reply.header('Cache-Control', 'no-store').sendFile('index.html');
      });
      for (const path of ['/', '/drive', '/connections', '/connections/telegram-help', '/account']) {
        app.get(path, async (request, reply) => {
          reply.header('Cache-Control', 'no-store');
          if (!auth.authenticated(token(request))) return reply.redirect('/login');
          return reply.sendFile('index.html');
        });
      }
    }
    await app.ready();
    await connections.restore();
    drive.googleDrive.start();
    drive.mega.start();
    drive.terabox.start();
    drive.telegram.start();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
