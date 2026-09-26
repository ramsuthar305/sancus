import compression from 'compression';
import express, { Express, NextFunction, Request, Response } from 'express';
import path from 'path';
import { lifecycle } from './configs/lifecycle';
import getLogger from './configs/logger';
import IPRateLimiter from './middlewares/ipRateLimiter';
import { metricsMiddleware } from './middlewares/metrics';
import handleMultipart from './middlewares/multipartHandler';
import { accessLogger, requestIdMiddleware } from './middlewares/requestContext';
import AdminRoute from './routes/admin.route';
import CommonRequestRoute from './routes/commonRequest.route';
import GeoFenceRoute from './routes/geoFenceRequest.route';
import PolicyRegistry from './services/policyRegistry';
import RedisService from './services/redis.service';
import RouteRegistry from './services/routeRegistry';
import ResponseEnum from './types/responseEnums';
import { parseTrustProxy } from './utils/clientIp';
import CorsHandler from './utils/corsUtil';
import SancusResponse from './utils/responseUtil';

const logger = getLogger();

// Custom policies, then validate + compile every YAML config (throws on invalid config),
// then hot-reload on changes unless CONFIG_WATCH=false.
const configDir = process.env.CONFIG_DIR || path.join(__dirname, '..', 'api_configs');
PolicyRegistry.getInstance().loadDir(process.env.POLICIES_DIR || path.join(__dirname, '..', 'policies'));
const routeRegistry = RouteRegistry.getInstance();
routeRegistry.initialize(configDir);
if (process.env.CONFIG_WATCH !== 'false') routeRegistry.watch(configDir);

const app: Express = express();
const port = Number(process.env.PORT) || 3000;
const redisService = RedisService.getInstance();

app.disable('x-powered-by');
app.set('etag', false); // proxied responses keep the upstream ETag; gateway-generated bodies get none
// Which proxies to trust for X-Forwarded-For; req.ip is derived from this.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', trustProxy);
const ipLimiterEnabled = process.env.IP_RATE_LIMIT_ENABLED !== 'false';
if (ipLimiterEnabled && trustProxy === false) {
  // Behind any load balancer every request would share the balancer's IP and one bucket: a site-wide 429.
  logger.fatal('IP rate limiter is enabled but TRUST_PROXY=false. Set TRUST_PROXY to your proxy (e.g. 1, or a CIDR list) or set IP_RATE_LIMIT_ENABLED=false.');
  process.exit(1);
}

app.use(requestIdMiddleware);
// While draining, ask keep-alive clients to reconnect, so they move to a pod that is staying.
app.use((_req: Request, res: Response, next: NextFunction) => {
  if (lifecycle.shuttingDown) res.setHeader('Connection', 'close');
  next();
});
app.use(accessLogger);
app.use(metricsMiddleware);
if (ipLimiterEnabled) app.use(new IPRateLimiter().middleware());
app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      // Never compress SSE — browsers buffer the whole compressed response, killing streaming
      if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  })
);
app.use(handleMultipart);
app.use((req: Request, res: Response, next: NextFunction) => {
  CorsHandler.setHeaders(req, res);
  next();
});

app.use(AdminRoute);
app.use('/api/geo', GeoFenceRoute);
app.use('/api/*', CommonRequestRoute);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: err.message, stack: err.stack, url: req.originalUrl }, 'unhandled pipeline error');
  if (!res.headersSent) new SancusResponse(ResponseEnum.INTERNAL_SERVER_ERROR, {}, res);
  else res.end();
});

async function startServer() {
  try {
    await redisService.initializeAndWait();
    logger.info('Redis connection ready');
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'Redis unavailable at startup; limits and cache fail open until it returns');
  }

  const server = app.listen(port, process.env.HOST || '0.0.0.0', () => {
    logger.info({ port }, 'Sancus gateway listening');
  });

  // Keep-alive must exceed the idle timeout of any load balancer in front of the gateway
  // (e.g. AWS ALB defaults to 60s) so the LB never reuses a connection Node already closed.
  const keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 125_000;
  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout = keepAliveTimeout + 1000;

  // Graceful shutdown in two phases:
  //  1. readiness turns 503 and responses carry `Connection: close`, but the server keeps
  //     serving for SHUTDOWN_DELAY_MS so load balancers and Kubernetes endpoints stop routing here;
  //  2. stop accepting, drain in-flight requests (up to SHUTDOWN_TIMEOUT_MS), exit.
  const delayMs = Number(process.env.SHUTDOWN_DELAY_MS ?? 5000);
  const shutdown = (signal: string) => {
    if (lifecycle.shuttingDown) return;
    lifecycle.shuttingDown = true;
    logger.info({ signal, delayMs }, 'shutting down: draining traffic');
    routeRegistry.close();
    setTimeout(() => {
      const force = setTimeout(() => {
        logger.warn('shutdown timeout reached, exiting with open connections');
        process.exit(1);
      }, Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000).unref();
      server.close(async () => {
        clearTimeout(force);
        await redisService.close();
        process.exit(0);
      });
      server.closeIdleConnections?.();
    }, delayMs);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((error) => {
  logger.error({ err: (error as Error).message }, 'failed to start');
  process.exit(1);
});
