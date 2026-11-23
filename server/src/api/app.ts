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
import { DriveError } from '../errors.ts';
import { Drive } from '../files/drive.ts';
import { IMPORTANCE, ROOT_ID } from '../files/index.ts';

const id = z.uuid();
const itemParams = z.object({ id });
const name = z.string().min(1).max(180);
const importance = z.enum(IMPORTANCE);
const destination = z.strictObject({ parentId: id.default(ROOT_ID), name });
const uploadQuery = destination.extend({ importance });
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

async function receiveUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  drive: Drive,
  config: Config,
) {
  const rawBody = request.body;
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
    throw new DriveError(415, 'Use application/octet-stream to upload files.');
  }
  const query = uploadQuery.parse(request.query);
  if (Number(request.headers['content-length']) > config.maxUploadBytes) {
    reply.header('Connection', 'close');
    throw new DriveError(413, 'The file exceeds the upload limit.');
  }

  const source = rawBody instanceof Readable ? rawBody
    : request.headers['content-length'] === '0' ? Readable.from([]) : null;
  if (!source) throw new DriveError(400, 'The upload body is missing.');
  const timeout = AbortSignal.timeout(config.uploadTimeoutMs);
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
    const entry = await drive.upload({ ...query, signal: AbortSignal.any([timeout, disconnected.signal]) }, () => {
      return source.pipe(input);
    });
    return reply.code(201).send(entry);
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
  const drive = await Drive.open(config.dataDir, config.maxUploadBytes, config.maxConcurrentUploads);
  const auth = new OwnerAuth(drive.index.db, config.sessionSeconds);
  const sessionName = config.secureCookies ? '__Host-blackbox_session' : 'blackbox_session';
  const token = (request: FastifyRequest) => request.cookies[sessionName];
  app.addHook('onClose', async () => drive.close());

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
  });

  app.setErrorHandler((error, request, reply) => {
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
        auth.logout(token(request));
        return reply.clearCookie(sessionName, sessionOptions).code(204).send();
      });

      api.register(async (secured) => {
        secured.addHook('onRequest', async (request) => {
          if (!auth.authenticated(token(request))) throw new DriveError(401, 'Sign in to continue.');
        });
        secured.get('/entries', async (request) => drive.index.browse(listing.parse(request.query)));
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
          await drive.purge(itemParams.parse(request.params).id);
          return reply.code(204).send();
        });
        secured.post('/entries/:id/copy', async (request, reply) => {
          const input = destination.parse(request.body);
          const entry = await drive.copy(itemParams.parse(request.params).id, input.parentId, input.name,
            AbortSignal.timeout(config.uploadTimeoutMs));
          return reply.code(201).send(entry);
        });
        secured.post('/uploads', async (request, reply) => receiveUpload(request, reply, drive, config));
        secured.get('/files/:id/download', async (request, reply) => {
          const download = await drive.download(itemParams.parse(request.params).id);
          return reply.type('application/octet-stream')
            .header('Content-Disposition', attachment(download.name))
            .header('Content-Length', download.size)
            .send(download.stream);
        });
      });
    }, { prefix: '/api' });

    const webRoot = fileURLToPath(new URL('../../../apps/web/dist/', import.meta.url));
    if (existsSync(join(webRoot, 'index.html'))) {
      await app.register(serveStatic, { root: webRoot, serve: false, cacheControl: false });
      await app.register(serveStatic, { root: join(webRoot, 'assets'), prefix: '/assets/', decorateReply: false, index: false });
      app.get('/', async (_request, reply) => reply.header('Cache-Control', 'no-store').redirect('/login'));
      app.get('/login', async (_request, reply) => {
        return reply.header('Cache-Control', 'no-store').sendFile('index.html');
      });
      app.get('/drive', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!auth.authenticated(token(request))) return reply.redirect('/login');
        return reply.sendFile('index.html');
      });
    }
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
