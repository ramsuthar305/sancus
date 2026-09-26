import { NextFunction, Request, Response } from 'express';
import getLogger from '../configs/logger';
import { cacheEvents } from '../configs/metrics';
import AuthService from '../services/auth.service';
import CacheService, { CachedResponse, CacheStatus } from '../services/cache.service';
import PolicyRegistry from '../services/policyRegistry';
import ProxyService, { ProxyContext } from '../services/proxy.service';
import RateLimitService from '../services/rateLimit.service';
import RouteRegistry from '../services/routeRegistry';
import { APIRoute, CacheConfig, HttpMethod } from '../types/api';
import { AuthResponse } from '../types/auth';
import ResponseEnum from '../types/responseEnums';
import AlertService from '../utils/alerts';
import CorsHandler from '../utils/corsUtil';
import GeoUtils from '../utils/geoFenceUtil';
import SancusResponse from '../utils/responseUtil';
import UrlUtils from '../utils/urlUtils';

const logger = getLogger();
const geoUtils = GeoUtils.getInstance(process.env.GEOFENCE_FILE || './in.json');
geoUtils
  .loadGeoJsonData()
  .then(() => logger.info(geoUtils.enabled ? 'geo-fence enabled' : 'geo-fence disabled (no polygons in GEOFENCE_FILE)'))
  .catch((err) => {
    logger.error({ err }, 'Error loading GeoJSON data');
    process.exit(1);
  });

const routeRegistry = RouteRegistry.getInstance();
const rateLimitService = RateLimitService.getInstance();
const cacheService = CacheService.getInstance();
const authService = AuthService.getInstance();
const proxyService = ProxyService.getInstance();
const policyRegistry = PolicyRegistry.getInstance();
const alertService = AlertService.getInstance();

interface AuthOutcome {
  identity?: AuthResponse;
  upstreamHeaders?: Record<string, string>;
  reject?: { status: number; body?: unknown; headers?: Record<string, string> };
}

/**
 * Pipeline: match → policies → (early cache) → geo-fence ∥ auth → rate-limit ∥ cache → proxy.
 */
class CommonRequestController {
  constructor() {
    this.pipeline = this.pipeline.bind(this);
  }

  private async validateGeofence(req: Request, res: Response): Promise<boolean> {
    const coordinates = req.header('X-COORDINATES');
    if (!coordinates) {
      new SancusResponse(ResponseEnum.COORDINATES_MISSING, {}, res);
      return false;
    }
    const [lat, lon] = coordinates.split(',').map(Number);
    if (isNaN(lat) || isNaN(lon)) {
      new SancusResponse(ResponseEnum.INVALID_COORDINATES, {}, res);
      return false;
    }
    try {
      const stateName = await geoUtils.findStateName(lat, lon);
      if (stateName) {
        logger.info({ state: stateName }, 'request from banned territory');
        new SancusResponse(ResponseEnum.BANNED_TERRITORY, {}, res);
        return false;
      }
    } catch (err) {
      logger.error({ err }, 'geo-fence lookup failed');
      new SancusResponse(ResponseEnum.INTERNAL_SERVER_ERROR, {}, res);
      return false;
    }
    return true;
  }

  private async authenticate(req: Request, route: APIRoute, required: boolean): Promise<AuthOutcome> {
    const token = req.headers.authorization;
    if (required) {
      if (!token) return { reject: { status: 401, body: { message: 'Unauthorized', response_code: 'SE0401' } } };
      const result = await authService.authenticate(token, req);
      if (!result.ok) return { reject: { status: result.status, body: result.body, headers: result.headers } };
      return { identity: result.identity, upstreamHeaders: result.upstreamHeaders };
    }
    // AUTH bypassed: resolve the user only when the route asks for it and a token is present
    if (token && route.resolveUser) {
      try {
        const result = await authService.authenticate(token, req);
        if (result.ok) return { identity: result.identity, upstreamHeaders: result.upstreamHeaders };
      } catch (e) {
        logger.info({ err: (e as Error).message }, 'optional token resolution failed');
      }
    }
    return {};
  }

  private sendCached(req: Request, res: Response, serviceName: string, cacheKey: string, entry: CachedResponse, config: CacheConfig, status: CacheStatus): void {
    cacheEvents.inc({ service: serviceName, status });
    CorsHandler.setHeaders(req, res);
    Object.entries(entry.headers).forEach(([k, v]) => {
      if (k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v);
    });
    Object.entries(cacheService.responseHeaders(config, cacheKey, status, entry)).forEach(([k, v]) => res.setHeader(k, v));
    if (req.headers['if-none-match'] === entry.etag) {
      res.status(304).end();
      return;
    }
    res.status(entry.statusCode);
    if (req.method === 'HEAD') res.end();
    else res.end(Buffer.from(entry.body, 'base64'));
  }

  public async pipeline(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { originalUrl, method } = req;

      if (method === 'OPTIONS') {
        CorsHandler.setHeaders(req, res);
        return res.status(200).send();
      }

      // --- match ---
      const serviceName = UrlUtils.extractServiceName(originalUrl);
      const service = serviceName ? routeRegistry.getService(serviceName) : undefined;
      if (!serviceName || !service || (service.hosts?.length && !service.hosts.includes(req.hostname))) {
        new SancusResponse(ResponseEnum.NOT_FOUND, {}, res);
        return;
      }
      const baseUrl = UrlUtils.extractPathWithQuery(originalUrl);
      const basePath = UrlUtils.extractPathWithoutQuery(originalUrl);
      if (!baseUrl || !basePath) {
        new SancusResponse(ResponseEnum.NOT_FOUND, {}, res);
        return;
      }
      const route = routeRegistry.findRoute(serviceName, basePath, method as HttpMethod);
      if (!route) {
        const allowed = routeRegistry.allowedMethods(serviceName, basePath);
        if (allowed.length) {
          res.setHeader('Allow', allowed.join(', '));
          new SancusResponse(ResponseEnum.METHOD_NOT_ALLOWED, {}, res);
        } else {
          new SancusResponse(ResponseEnum.NOT_FOUND, {}, res);
        }
        return;
      }
      (req as any).__sancusCtx = { serviceName, route }; // metrics labels for early exits

      // --- custom policies (service, then route) ---
      const handlers = [...policyRegistry.handlersFor(service), ...policyRegistry.handlersFor(route)];
      if (handlers.length && (await PolicyRegistry.run(handlers, req, res))) return;

      // --- cache setup ---
      const cacheConfig = route.cache;
      const cacheable = !!cacheConfig && cacheService.isCacheableRequest(req);
      const queryString = originalUrl.includes('?') ? originalUrl.split('?')[1] : undefined;
      const vary = cacheConfig?.varyHeaders?.length
        ? Object.fromEntries(cacheConfig.varyHeaders.map((h) => [h, req.headers[h.toLowerCase()] as string | undefined]))
        : undefined;

      // Anonymous routes: answer from cache before auth/geo/rate-limit work
      if (cacheable && cacheConfig && route.bypass?.includes('AUTH') && cacheConfig.key !== 'PATH_QUERY_USER') {
        const earlyKey = cacheService.buildKey(cacheConfig, serviceName, basePath, queryString, undefined, vary);
        const cached = await cacheService.get(earlyKey, cacheConfig);
        if (cached && !cached.stale) return this.sendCached(req, res, serviceName, earlyKey, cached.data, cacheConfig, 'HIT');
      }

      // --- geo-fence ∥ auth ---
      const geoRequired = geoUtils.enabled && !route.bypass?.includes('GEO_FENCE');
      const authRequired = !route.bypass?.includes('AUTH');
      const [geoOk, auth] = await Promise.all([
        geoRequired ? this.validateGeofence(req, res) : Promise.resolve(true),
        this.authenticate(req, route, authRequired),
      ]);
      if (!geoOk) return; // response already sent
      if (auth.reject) {
        CorsHandler.setHeaders(req, res);
        Object.entries(auth.reject.headers ?? {}).forEach(([k, v]) => res.setHeader(k, v));
        res.status(auth.reject.status);
        return auth.reject.body === undefined ? res.end() : res.send(auth.reject.body);
      }
      const identity = auth.identity;
      const userId = identity ? String(identity.id) : undefined;

      // --- rate-limit ∥ cache lookup ---
      const apiKeyRaw = req.headers['x-api-key'];
      const apiKey = Array.isArray(apiKeyRaw) ? apiKeyRaw[0] : apiKeyRaw;
      const cacheKey = cacheable && cacheConfig ? cacheService.buildKey(cacheConfig, serviceName, basePath, queryString, userId, vary) : undefined;

      const [rateLimit, cached] = await Promise.all([
        rateLimitService.enforce({ serviceName, route, method: method as HttpMethod, req, userId, apiKey }),
        cacheKey && cacheConfig ? cacheService.get(cacheKey, cacheConfig) : Promise.resolve(null),
      ]);

      Object.entries(rateLimit.headers).forEach(([k, v]) => res.setHeader(k, v));
      if (!rateLimit.allowed) {
        CorsHandler.setHeaders(req, res);
        res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds ?? 60));
        return res.status(429).json({ error: 'Too Many Requests', message: rateLimit.message, retryAfter: rateLimit.retryAfterSeconds });
      }

      let swrStale = false;
      if (cached && cacheKey && cacheConfig) {
        if (!cached.stale) return this.sendCached(req, res, serviceName, cacheKey, cached.data, cacheConfig, 'HIT');
        // SWR: serve stale now, revalidate through the proxy below
        swrStale = true;
        await cacheService.markRevalidating(cacheKey);
        this.sendCached(req, res, serviceName, cacheKey, cached.data, cacheConfig, 'STALE');
      }

      // --- proxy ---
      const ctx: ProxyContext = {
        correlationalId: (req as any).id as string,
        serviceName,
        service,
        route,
        method,
        basePath,
        destination: '',
        tokenDetails: identity,
        authUpstreamHeaders: auth.upstreamHeaders,
        uploadedFiles: (req as any).uploadedFiles,
        shouldCacheResponse: !!cacheKey && !!cacheConfig && method === 'GET',
        cacheKey,
        cacheConfig,
        swrStale,
        attempt: 0,
        startedAt: Date.now(),
      };
      (req as any).__sancusCtx = ctx;
      req.url = proxyService.rewritePath(service, baseUrl);
      proxyService.proxy(req, res, ctx);
    } catch (error: any) {
      alertService.alert(
        `pipeline-error:${req.method}:${req.originalUrl}`,
        '🚨 Gateway Pipeline Error',
        `**Request:** ${req.method} ${req.originalUrl}\n**Error:** ${error.message}\n**Request ID:** \`${(req as any).id || 'unknown'}\``
      );
      next(error);
    }
  }
}

export default CommonRequestController;
