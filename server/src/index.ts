import { buildApp } from './api/app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = await buildApp(config);
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await app.close();
  throw error;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().catch((error) => {
      app.log.error(error, 'Shutdown failed');
      process.exitCode = 1;
    });
  });
}
