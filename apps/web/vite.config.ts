import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../../', import.meta.url)), '');
  const apiHost = env.HOST === '::1' ? '[::1]' : '127.0.0.1';
  const target = 'http://' + apiHost + ':' + (env.PORT || '4174');
  return {
    plugins: [react(), {
      name: 'protect-drive-page',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const path = request.url?.split('?')[0];
          if (!['GET', 'HEAD'].includes(request.method ?? '') || !['/', '/drive', '/drive/'].includes(path ?? '')) {
            return next();
          }
          response.setHeader('Cache-Control', 'no-store');
          if (path !== '/') {
            try {
              const status = await fetch(target + '/api/auth/status', {
                headers: { cookie: request.headers.cookie ?? '' },
                signal: AbortSignal.timeout(3000),
              });
              if (status.ok && (await status.json()).authenticated === true) return next();
            } catch {
              // Fall back to sign-in if the API cannot confirm the session.
            }
          }
          response.writeHead(302, { Location: '/login' }).end();
        });
      },
    }],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      headers: { 'Cache-Control': 'no-store' },
      proxy: { '/api': { target } },
    },
  };
});
