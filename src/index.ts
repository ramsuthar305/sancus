// import 'newrelic';
import bodyParser from 'body-parser';
import express, { Express, Request, Response } from 'express';
import path from 'path';
import getLogger from './configs/logger';
import { accessLogger, requestIdMiddleware } from './middlewares/requestContext';
import handleMultipart from './middlewares/multipartHandler';
import APIConfigValidator from './utils/configValidator';
import RouteRegistry from './services/routeRegistry';
import CommonRequestRoute from './routes/commonRequest.route';
import GeoFenceRoute from './routes/geoFenceRequest.route';
import CorsHandler from './utils/corsUtil';
import compression from 'compression';
import IPRateLimiter from './middlewares/ipRateLimiter';
import RateLimitService from './services/rateLimit.service';
import RedisService from './services/redis.service';


const apiConfigValidator = new APIConfigValidator(
  path.join(__dirname, '..', 'api_configs')
);
apiConfigValidator.validateAllFiles();

// Load all YAML configs and pre-compile route regexes once at startup
const routeRegistry = RouteRegistry.getInstance();
routeRegistry.initialize(path.join(__dirname, '..', 'api_configs'));

const app: Express = express();
const port = 3000;
const ipRateLimiter = new IPRateLimiter();
const rateLimitService = RateLimitService.getInstance();
const redisService = RedisService.getInstance();

app.use(requestIdMiddleware);
app.use(accessLogger);
app.use(ipRateLimiter.middleware());
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    // Never compress SSE — browsers buffer the entire compressed response
    // before decompressing, which defeats real-time streaming.
    if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) {
      return false;
    }
    return compression.filter(req, res);
  },
}));

app.use(handleMultipart);


app.use((req: Request, res: Response, next: Function) => {
  CorsHandler.setHeaders(req, res);
  next();
});

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'UP' });
});
app.use('/api/geo', GeoFenceRoute);
app.use('/api/*', CommonRequestRoute);

// Initialize Redis connection pool before starting server
async function startServer() {
  const logger = getLogger();

  try {
    // Initialize Redis connection pool
    logger.info('Initializing Redis connection pool...');
    await redisService.initializeAndWait();
    logger.info('✅ Redis connection pool ready');
  } catch (error) {
    logger.error(`⚠️  Failed to connect to Redis: ${error}`);
    logger.warn('Server will start but Redis-dependent features may not work');
  }

  // Start the server
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => {
    logger.info(`⚡️[server]: Server is running on port ${port}`);
  });

  // Keep-alive must exceed the idle timeout of any load balancer in front of the gateway
  // (e.g. AWS ALB defaults to 60s) so the LB never reuses a connection Node already closed.
  const keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 125000;
  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout = keepAliveTimeout + 1000; // must be > keepAliveTimeout
}

// Start server
startServer().catch((error) => {
  const logger = getLogger();
  logger.error(`Failed to start server: ${error}`);
  process.exit(1);
});

let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  const logger = getLogger();
  logger.info('Shutting down Sancus gateway...');
  ipRateLimiter.destroy();
  await rateLimitService.close();
  await redisService.close(); // Close Redis connection
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
