import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { apiError, handleError, type AppEnv } from './http.js';
import { imapRoutes } from './routes/imap.js';
import { securityHeaders, serveWeb } from './static.js';

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  // En-têtes de sécurité sur toutes les réponses
  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(securityHeaders())) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
  });

  app.get('/healthz', (c) => c.text('ok'));

  // API de la v2, supprimée : seule une ancienne appli encore en cache l'appelle. Clear-Site-Data lui fait
  // oublier son service worker et ses données, le rechargement suivant charge la v3.
  app.all('/api/*', (c) => {
    c.header('Clear-Site-Data', '"storage"');
    c.header('Cache-Control', 'no-store');
    return apiError(c, 410, 'not_found', 'API v2 removed');
  });

  // Passerelle IMAP ; la découverte reçoit un petit JSON.
  app.use('/imap/discover', bodyLimit({ maxSize: 16 * 1024, onError: (c) => apiError(c, 413, 'validation', 'body too large') }));
  app.route('/imap', imapRoutes);

  app.notFound((c) => serveWeb(c) ?? c.text('Not found', 404));
  return app;
}
