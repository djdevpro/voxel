import { serve } from '@hono/node-server';
import { config } from './config.js';
import { createApp } from './app.js';
import { closeAllBackends } from './backend/pool.js';
import { purgeOldKv } from './kv.js';

const app = createApp();
purgeOldKv();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[voxel] Voxel (passerelle IMAP) à l'écoute sur http://${info.address}:${info.port}`);
});

// Les flux SSE sont longs : pas de délai d'inactivité côté Node.
server.setTimeout?.(0);

const shutdown = () => {
  server.close();
  void closeAllBackends();
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
