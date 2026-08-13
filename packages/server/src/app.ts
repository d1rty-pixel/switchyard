import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ConfigError, SwitchyardError } from './core/errors.js';
import { logger } from './core/logger.js';
import { registerApi } from './routes/api.js';
import type { ServiceManager } from './core/manager.js';
import type { EventBus } from './core/events.js';

export interface AppOptions {
  manager: ServiceManager;
  bus: EventBus;
  version: string;
  configPathOverride?: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Built frontend location, relative to `packages/server/dist`. */
function webRoot(): string | undefined {
  const candidates = [
    resolve(here, '../../web/dist'),
    resolve(here, '../../../web/dist'),
    resolve(process.cwd(), 'packages/web/dist'),
  ];
  return candidates.find((candidate) => existsSync(resolve(candidate, 'index.html')));
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // pino's own Logger type is structurally narrower than Fastify's; the
    // instance is compatible at runtime.
    loggerInstance: logger.child({ module: 'http' }) as unknown as FastifyBaseLogger,
    disableRequestLogging: true,
    bodyLimit: 64 * 1024,
  });

  app.addHook('onResponse', (request, reply, done) => {
    // One compact line per request; SSE streams are logged on open only.
    request.log.debug(
      {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
    done();
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof SwitchyardError) {
      reply.code(error.statusCode);
      return reply.send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    // A bad configuration file is the caller's problem to fix, not a server
    // fault, and the per-issue list is the entire useful part of the answer —
    // falling through to the generic handler below turned "history: unknown key
    // in switchyard.yaml" into a bare 500 with the reason thrown away.
    if (error instanceof ConfigError) {
      request.log.warn({ issues: error.issues }, 'configuration rejected');
      reply.code(422);
      return reply.send({
        error: { code: 'invalid_config', message: error.message, details: { issues: error.issues } },
      });
    }
    request.log.error({ err: error, url: request.url }, 'unhandled error');
    reply.code(error.statusCode ?? 500);
    return reply.send({
      error: { code: 'internal_error', message: error.message ?? 'internal error' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404);
      return reply.send({ error: { code: 'not_found', message: `no such endpoint: ${request.url}` } });
    }
    // SPA fallback so deep links work when the built UI is served.
    const root = webRoot();
    if (root) return reply.sendFile('index.html');
    reply.code(404);
    return reply.send({
      error: {
        code: 'ui_not_built',
        message: 'frontend not built — run `npm run build`, or use `npm run dev` for the Vite dev server',
      },
    });
  });

  await registerApi(app, {
    manager: options.manager,
    bus: options.bus,
    version: options.version,
    configPathOverride: options.configPathOverride,
    startedAt: Date.now(),
  });

  const root = webRoot();
  if (root) {
    await app.register(fastifyStatic, { root, prefix: '/', index: ['index.html'] });
    logger.debug({ root }, 'serving built frontend');
  } else {
    logger.warn('frontend build not found — API only');
  }

  return app;
}
