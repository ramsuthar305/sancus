import { NextFunction, Request, Response, Router } from 'express';
import { lifecycle } from '../configs/lifecycle';
import { registry as metricsRegistry } from '../configs/metrics';
import CacheService from '../services/cache.service';
import PolicyRegistry from '../services/policyRegistry';
import RedisService from '../services/redis.service';
import RouteRegistry from '../services/routeRegistry';

/**
 * Operational endpoints. /health and /health/ready are always open (probes need them);
 * the rest require `Authorization: Bearer $ADMIN_TOKEN` when ADMIN_TOKEN is set.
 */
const router = Router();
const routeRegistry = RouteRegistry.getInstance();
const redisService = RedisService.getInstance();

router.get('/health', (_req, res) => {
  res.json({ status: 'UP' });
});

router.get('/health/ready', async (_req, res) => {
  // Ready = config loaded and not draining. Redis is reported, not required: every Redis-backed
  // feature fails open, so pulling pods out of service during a Redis blip would turn a degraded
  // gateway into an outage.
  const problems: string[] = [];
  if (lifecycle.shuttingDown) problems.push('shutting down');
  if (!routeRegistry.isLoaded) problems.push('config not loaded');
  if (problems.length) return res.status(503).json({ status: 'DOWN', problems });
  const redis = (await redisService.isAvailable()) ? 'up' : 'down';
  return res.json({ status: redis === 'up' ? 'UP' : 'DEGRADED', redis, configLoadedAt: routeRegistry.loadedAt });
});

const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ message: 'Unauthorized', response_code: 'SE0401' });
  }
  return next();
};

router.get('/metrics', adminAuth, async (_req, res) => {
  res.set('Content-Type', metricsRegistry.contentType);
  res.send(await metricsRegistry.metrics());
});

router.get('/routes', adminAuth, (_req, res) => {
  res.json({
    loadedAt: routeRegistry.loadedAt,
    policies: PolicyRegistry.getInstance().names(),
    services: routeRegistry.listServices().map(({ service, routes }) => ({
      name: service.name,
      upstream: service.nodes ?? `$${service.host}${service.port ? `:${service.port}` : ''}`,
      hosts: service.hosts,
      routes: routes.map((r) => ({
        path: r.path,
        methods: r.methods,
        bypass: r.bypass ?? [],
        rateLimit: r.rateLimit,
        cache: r.cache,
        policies: r.policies ? Object.keys(r.policies) : undefined,
      })),
    })),
  });
});

router.delete('/cache/:service', adminAuth, async (req, res) => {
  if (!routeRegistry.getService(req.params.service)) return res.status(404).json({ message: 'Unknown service', response_code: 'SE0404' });
  const purged = await CacheService.getInstance().purgeService(req.params.service);
  return res.json({ service: req.params.service, purged });
});

export default router;
