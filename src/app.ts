import { Hono } from 'hono';
import { compress } from 'hono-compress';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { env } from './config/env';
import { performanceMiddleware } from './middleware/performance';
import { requestIdMiddleware } from './middleware/request-id';
import { timeoutMiddleware } from './middleware/timeout';
import { logger } from './observability/logger';
import { adminRoutes } from './routes/admin.routes';
import { chatRoutes } from './routes/chat.routes';
import { healthRoutes } from './routes/health.routes';
import { messagesRoutes } from './routes/messages.routes';
import { modelsRoutes } from './routes/models.routes';
import { quotaRoutes } from './routes/quota.routes';
import { responsesRoutes } from './routes/responses.routes';
import { shutdownMiddleware } from './services/shutdown.service';
import { errorForProtocol } from './utils/errors';

function getAllowedCorsOrigins(): string[] {
  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS must be configured in production');
  }

  return allowedOrigins;
}

function applyGlobalMiddleware(app: Hono): void {
  const allowedOrigins = getAllowedCorsOrigins();

  app.use('*', compress());
  app.use(
    '*',
    secureHeaders({
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: 'cross-origin',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
      xFrameOptions: 'DENY',
      xContentTypeOptions: 'nosniff',
      referrerPolicy: 'no-referrer',
    })
  );
  app.use(
    '*',
    cors({
      origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposeHeaders: [
        'X-Request-Id',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
      ],
      maxAge: 86400,
    })
  );
  app.use('*', requestIdMiddleware);
  app.use('*', shutdownMiddleware);
  app.use('*', timeoutMiddleware);
  app.use('*', performanceMiddleware);
}

function applyErrorHandler(app: Hono): void {
  app.onError((err, c) => {
    const requestId = c.get('requestId') || 'unknown';
    logger.error({ err, requestId }, 'Unhandled error');

    const error = errorForProtocol(c.req.path, 500, 'internal_error', 'Internal server error');
    return c.json(error, 500);
  });
}

function applyRoutes(app: Hono): void {
  app.route('/v1/chat/completions', chatRoutes);
  app.route('/v1/messages', messagesRoutes);
  app.route('/v1/responses', responsesRoutes);
  app.route('/v1/models', modelsRoutes);
  app.route('/', healthRoutes);
  app.route('/quota', quotaRoutes);
  app.route('/admin', adminRoutes);
}

export function createApp(): Hono {
  const app = new Hono();

  applyGlobalMiddleware(app);
  applyErrorHandler(app);
  applyRoutes(app);

  return app;
}
