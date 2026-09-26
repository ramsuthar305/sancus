import { NextFunction, Request, Response } from 'express';
import httpProxy from 'http-proxy';
import http from 'http';
import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import AuthServiceClient from '../clients/authClient';
import getLogger from '../configs/logger';
import { CacheConfig, HttpMethod } from '../types/api';
import ClientResponseStatus from '../types/requestStatus';
import ResponseEnum from '../types/responseEnums';
import { AuthResponse } from '../types/auth';
import RouteRegistry from '../services/routeRegistry';
import SancusResponse from '../utils/responseUtil';
import UrlUtils from '../utils/urlUtils';
import GeoUtils from '../utils/geoFenceUtil';
import CorsHandler from '../utils/corsUtil';
import FileUtil from '../utils/fileUtil';
import RateLimitService from '../services/rateLimit.service';
import RedisService from '../services/redis.service';
import CacheService from '../services/cache.service';
import DiscordService from '../utils/discordAlerts';

const geoUtils = GeoUtils.getInstance('./in.json');
geoUtils
  .loadGeoJsonData()
  .then(() => {
    console.log('GeoJSON data loaded successfully.');
  })
  .catch((err) => {
    console.error('Error loading GeoJSON data:', err);
    process.exit(1);
  });

const logger = getLogger();
const routeRegistry = RouteRegistry.getInstance();
const rateLimitService = RateLimitService.getInstance();
const cacheService = CacheService.getInstance();

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000,
});

// Redis-backed token verification cache (TTL 60s, shared across all pods)
const TOKEN_CACHE_TTL = 60; // seconds
const TOKEN_CACHE_PREFIX = 'sancus:token:';
// Header carrying the resolved user id to upstream services
const AUTH_FORWARD_HEADER = process.env.AUTH_FORWARD_HEADER || 'X-AUTHORIZED-FOR-ID';

function fastHash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

async function getCachedToken(token: string): Promise<AuthResponse | null> {
  const redis = RedisService.getInstance().getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(`${TOKEN_CACHE_PREFIX}${fastHash(token)}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    logger.error(`Token cache GET failed: ${(e as Error).message}`);
    return null;
  }
}

async function setCachedToken(token: string, data: AuthResponse): Promise<void> {
  const redis = RedisService.getInstance().getClient();
  if (!redis) return;
  try {
    await redis.set(`${TOKEN_CACHE_PREFIX}${fastHash(token)}`, JSON.stringify(data), 'EX', TOKEN_CACHE_TTL);
  } catch (e) {
    logger.error(`Token cache SET failed: ${(e as Error).message}`);
  }
}
const isProd = process.env.NODE_ENV === 'production';
const alertService = new DiscordService(
  process.env.DISCORD_WEBHOOK_URL || '',
  isProd
);

// Alert cooldown — max 1 alert per endpoint per 60s to prevent flooding
const ALERT_COOLDOWN_MS = 60_000;
const alertCooldown = new Map<string, number>();
function shouldAlert(key: string): boolean {
  const now = Date.now();
  const last = alertCooldown.get(key);
  if (last && now - last < ALERT_COOLDOWN_MS) return false;
  alertCooldown.set(key, now);
  return true;
}

// --- Shared proxy instance (reused across all requests) ---

interface SancusProxyContext {
  correlationalId: string;
  tokenDetails?: AuthResponse;
  uploadedFiles?: any[];
  shouldCacheResponse: boolean;
  cacheKey?: string;
  cacheConfig?: CacheConfig;
  swrStale: boolean;
  serviceName: string;
  method: string;
  basePath: string;
  destination: string;
}

const proxy = httpProxy.createProxyServer({ changeOrigin: true, xfwd: true });

proxy.on('proxyReq', (proxyReq, req, res) => {
  const ctx = (req as any).__sancusCtx as SancusProxyContext;
  if (!ctx) return;

  proxyReq.setHeader('Correlation-ID', ctx.correlationalId);
  if (ctx.tokenDetails) {
    proxyReq.setHeader(AUTH_FORWARD_HEADER, String(ctx.tokenDetails.id));
  }

  // Handle multipart/form-data requests with files
  const contentType = (req as any).headers?.['content-type'];
  if (contentType && contentType.includes('multipart/form-data')) {
    const uploadedFiles = ctx.uploadedFiles;

    if (uploadedFiles && uploadedFiles.length > 0) {
      // Validate files before forwarding
      const invalidFiles = uploadedFiles.filter((file: any) => {
        const validation = FileUtil.validateFile(file);
        if (!validation.isValid) {
          logger.error(`File validation failed for ${file.originalname}: ${validation.error}`);
        }
        return !validation.isValid;
      });

      if (invalidFiles.length > 0) {
        logger.error('Some files failed validation');
        FileUtil.cleanupFiles(uploadedFiles);
        (res as any).writeHead(400, { 'Content-Type': 'application/json' });
        (res as any).end(JSON.stringify({
          error: 'File validation failed',
          details: invalidFiles.map((file: any) => ({
            filename: file.originalname,
            error: FileUtil.validateFile(file).error
          }))
        }));
        proxyReq.destroy();
        return;
      }

      // Create multipart boundary
      const boundary = '----WebKitFormBoundary' + Math.random().toString(16).substr(2);
      proxyReq.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);

      // Build multipart body as buffer array to handle binary data properly
      const bodyParts: Buffer[] = [];

      // Add form fields
      const body = (req as any).body;
      if (body) {
        Object.keys(body).forEach(key => {
          bodyParts.push(Buffer.from(`--${boundary}\r\n`));
          bodyParts.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`));
          bodyParts.push(Buffer.from(`${body[key]}\r\n`));
        });
      }

      // Add files
      uploadedFiles.forEach((file: any) => {
        const fileContent = FileUtil.readFileAsBuffer(file.path);
        bodyParts.push(Buffer.from(`--${boundary}\r\n`));
        bodyParts.push(Buffer.from(`Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.originalname}"\r\n`));
        bodyParts.push(Buffer.from(`Content-Type: ${file.mimetype}\r\n\r\n`));
        bodyParts.push(fileContent);
        bodyParts.push(Buffer.from('\r\n'));
      });

      bodyParts.push(Buffer.from(`--${boundary}--\r\n`));

      // Combine all parts into single buffer
      const multipartBody = Buffer.concat(bodyParts);

      proxyReq.setHeader('Content-Length', multipartBody.length);
      proxyReq.write(multipartBody);

      // Clean up uploaded files after forwarding
      FileUtil.cleanupFiles(uploadedFiles);

      logger.info(`Successfully forwarded ${uploadedFiles.length} files to proxy`);
    }
  }
});

proxy.on('proxyRes', (proxyRes, req, res) => {
  const ctx = (req as any).__sancusCtx as SancusProxyContext;
  if (!ctx) return;

  // Force no Content-Length for chunked SSE
  if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
    delete proxyRes.headers['content-length'];
    (res as any).setHeader('Transfer-Encoding', 'chunked');
    (res as any).setHeader('Connection', 'keep-alive');
  }

  // Alert on backend 5xx responses
  if (proxyRes.statusCode && proxyRes.statusCode >= 500) {
    const alertKey = `5xx:${ctx.method}:${ctx.basePath}:${proxyRes.statusCode}`;
    if (shouldAlert(alertKey)) {
      alertService.sendAlert(
        `🚨 Backend ${proxyRes.statusCode} Error`,
        `**Service:** ${ctx.serviceName}\n**Request:** ${ctx.method} ${ctx.basePath}\n**Status:** ${proxyRes.statusCode} ${proxyRes.statusMessage}\n**Correlation ID:** \`${ctx.correlationalId}\`\n**Destination:** ${ctx.destination}\n**Time:** ${new Date().toISOString()}`
      );
    }
  }

  // Cache the response if caching is configured for this route
  if (ctx.shouldCacheResponse && ctx.cacheKey && ctx.cacheConfig && proxyRes.statusCode && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
    const chunks: Buffer[] = [];
    proxyRes.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const headersToCache: Record<string, string> = {};
      const headersToPersist = ['content-type', 'content-encoding'];
      for (const h of headersToPersist) {
        if (proxyRes.headers[h]) {
          headersToCache[h] = Array.isArray(proxyRes.headers[h])
            ? (proxyRes.headers[h] as string[])[0]
            : (proxyRes.headers[h] as string);
        }
      }
      cacheService.set(ctx.cacheKey!, proxyRes.statusCode!, headersToCache, body, ctx.cacheConfig!).catch((err) => {
        logger.error(`Failed to write cache: ${err.message}`);
      });

      // For SWR background revalidation, we consumed the body via selfHandleResponse
      // but already sent the stale response — just discard the proxy response
      if (ctx.swrStale) {
        logger.info(`SWR background revalidation complete (key=${ctx.cacheKey})`);
      }
    });

    // If not SWR stale, we still need to pipe the response through to the client
    if (!ctx.swrStale) {
      (res as any).setHeader('X-Sancus-Cache', 'MISS');
      const missHeaders = cacheService.buildResponseHeaders(ctx.cacheConfig);
      Object.entries(missHeaders).forEach(([k, v]) => (res as any).setHeader(k, v));
    }
  }
});

proxy.on('error', (err, req, res) => {
  const ctx = (req as any).__sancusCtx as SancusProxyContext | undefined;
  const correlationId = ctx?.correlationalId || 'unknown';
  const alertKey = `proxy-error:${(req as any).method}:${(req as any).url}`;
  if (shouldAlert(alertKey)) {
    alertService.sendAlert(
      '🚨 Proxy Error',
      `**Request:** ${(req as any).method} ${(req as any).url}\n**Error:** ${err.message}\n**Correlation ID:** \`${correlationId}\`\n**Time:** ${new Date().toISOString()}`
    );
  }
  logger.error(`Proxy error: ${err.message} (correlationId=${correlationId})`);
  if (res && !((res as any).headersSent)) {
    (res as any).writeHead(502, { 'Content-Type': 'text/plain' });
    (res as any).end('Bad Gateway');
  }
});

class CommonRequestController {
  constructor() {
    this.isAuthResponse = this.isAuthResponse.bind(this);
    this.validateToken = this.validateToken.bind(this);
    this.pipeline = this.pipeline.bind(this);
    this.validateGeofence = this.validateGeofence.bind(this);
  }

  private getHostUrl(serviceDetailsHostId: string): string {
    let hostUrl: string = process.env[serviceDetailsHostId] || '';
    if(!hostUrl) {
      throw new Error(`No host URL found for host ID: ${serviceDetailsHostId}`);
    }
    return hostUrl;
  }

  private isAuthResponse(
    response: AuthResponse | ClientResponseStatus
  ): response is AuthResponse {
    return response instanceof Object && 'id' in response;
  }

  private async validateToken(
    token: string
  ): Promise<AuthResponse | boolean> {
    try {
      const cached = await getCachedToken(token);
      if (cached) return cached;

      const authClient = AuthServiceClient.getInstance();
      const response = await authClient.verifyToken(token);

      if (this.isAuthResponse(response)) {
        await setCachedToken(token, response);
        return response;
      }

      if (response === ClientResponseStatus.UNAUTHORIZED) {
        return false;
      } else if (response === ClientResponseStatus.BAD_REQUEST) {
        logger.info('Auth service call failed');
        throw new Error('Auth service call failed');
      }
      throw new Error('Auth service call failed');
    } catch (error: any) {
      console.error('Error calling auth service:', error.message);
      throw error; // Rethrow the error to be handled by the caller
    }
  }

  private async validateGeofence(
    req: Request,
    res: Response
  ): Promise<boolean> {
    const coordinates = req.header('X-COORDINATES');
    if (!coordinates) {
      new SancusResponse(ResponseEnum.COORDINATES_MISSING, {}, res);
      return false;
    }

    const [lat, lon] = coordinates.split(',').map(Number);
    if (isNaN(lat) || isNaN(lon)) {
      logger.info(`Unauthorized request: Invalid coordinates.${lat},${lon}`);
      new SancusResponse(ResponseEnum.INVALID_COORDINATES, {}, res);
      return false;
    }

    try {
      const stateName = await geoUtils.findStateName(lat, lon);
      if (stateName) {
        logger.info(
          `Unauthorized request: Banned territory. state: ${stateName}`
        );
        new SancusResponse(ResponseEnum.BANNED_TERRITORY, {}, res);
        return false;
      }
    } catch (err) {
      console.error('Error finding state:', err);
      new SancusResponse(ResponseEnum.INTERNAL_SERVER_ERROR, {}, res);
      return false;
    }
    return true;
  }

  public async pipeline(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<Response | void> {
    try {
      const { originalUrl, method } = req;
      const token = req.headers.authorization;

      // Return 200 for OPTIONS requests
      if (method === 'OPTIONS') {
        CorsHandler.setHeaders(req, res);
        return res.status(200).send();
      }

      const serviceName = UrlUtils.extractServiceName(originalUrl);
      if (!serviceName) {
        new SancusResponse(ResponseEnum.INVALID_SERVICE_NAME, {}, res);
        return;
      }

      const serviceDetails = routeRegistry.getService(serviceName);
      if (!serviceDetails) {
        new SancusResponse(ResponseEnum.INVALID_SERVICE_NAME, {}, res);
        return;
      }
      const baseUrl = UrlUtils.extractPathWithQuery(originalUrl);
      const basePath = UrlUtils.extractPathWithoutQuery(originalUrl);
      if (!baseUrl || !basePath) {
        new SancusResponse(ResponseEnum.INVALID_SERVICE_NAME, {}, res);
        return;
      }

      const matchingRoute = routeRegistry.findRoute(serviceName, basePath, method as HttpMethod);
      if (!matchingRoute) {
        new SancusResponse(ResponseEnum.BAD_REQUEST, {}, res);
        return;
      }
      logger.info(
        `API structure validation successful for path '${baseUrl}' and method '${method}'`
      );

      // --- Early cache check for AUTH-bypassed routes (skip auth, geofence, rate limiting) ---
      if (matchingRoute.cache && method === 'GET' && matchingRoute.bypass?.includes('AUTH') && matchingRoute.cache.key !== 'PATH_QUERY_USER') {
        const queryString = originalUrl.includes('?') ? originalUrl.split('?')[1] : undefined;
        const earlyCacheKey = cacheService.buildKey(matchingRoute.cache, basePath, queryString, undefined);
        const cached = await cacheService.get(earlyCacheKey, matchingRoute.cache);

        if (cached && !cached.stale) {
          logger.info(`Cache EARLY-HIT (key=${earlyCacheKey})`);
          CorsHandler.setHeaders(req, res);
          res.setHeader('X-Sancus-Cache', 'HIT');
          Object.entries(cached.data.headers).forEach(([k, v]) => {
            if (k.toLowerCase() !== 'transfer-encoding') {
              res.setHeader(k, v);
            }
          });
          const browserHeaders = cacheService.buildResponseHeaders(matchingRoute.cache, cached.data.cachedAt);
          Object.entries(browserHeaders).forEach(([k, v]) => res.setHeader(k, v));
          return res.status(cached.data.statusCode).send(cached.data.body);
        }
        // SWR stale or MISS — fall through to full pipeline
      }

      // --- Phase 1: GeoFence + Auth in parallel ---
      const geoFenceRequired = !matchingRoute.bypass?.includes('GEO_FENCE') && method !== 'OPTIONS';
      const authRequired = !matchingRoute.bypass?.includes('AUTH') && method !== 'OPTIONS';

      const geoPromise: Promise<boolean> = geoFenceRequired
        ? this.validateGeofence(req, res)
        : Promise.resolve(true);

      const authPromise: Promise<{ unauthorized?: boolean; reason?: string; tokenDetails?: AuthResponse; error?: Error }> = (async () => {
        if (authRequired) {
          if (!token) return { unauthorized: true, reason: 'missing' };
          try {
            const result = await this.validateToken(token);
            if (!result) return { unauthorized: true, reason: 'invalid' };
            if (result !== true && this.isAuthResponse(result)) {
              return { tokenDetails: result };
            }
            return {};
          } catch (e) {
            return { error: e as Error };
          }
        }
        // AUTH bypassed — only resolve user if route explicitly requests it
        if (token && matchingRoute.resolveUser) {
          try {
            const result = await this.validateToken(token);
            if (result && result !== true && this.isAuthResponse(result)) {
              return { tokenDetails: result };
            }
          } catch (e) {
            logger.info(`Optional token validation failed: ${(e as Error).message}`);
          }
        }
        return {};
      })();

      const [geoResult, authResult] = await Promise.all([geoPromise, authPromise]);

      // Check geofence first (validateGeofence already sent error response on failure)
      if (!geoResult) {
        logger.info('Unauthorized request: GeoFence validation failed.');
        return;
      }
      if (geoFenceRequired) logger.info('GeoFence validation successful');

      // Check auth — rethrow auth errors only if geo passed (prevents double-response)
      if (authResult.error) {
        throw authResult.error;
      }
      if (authResult.unauthorized) {
        logger.info(`Unauthorized request: Token ${authResult.reason === 'missing' ? 'does not exist' : 'is invalid'}.`);
        CorsHandler.setHeaders(req, res);
        return res.status(401).send('Unauthorized');
      }

      let tokenDetails: AuthResponse | undefined = authResult.tokenDetails;
      if (tokenDetails) logger.info('Token validated successfully');

      const userIdentifier = tokenDetails ? tokenDetails.id.toString() : undefined;

      // --- Phase 2: Rate Limit + Cache check in parallel ---
      const apiKeyHeaderRaw = req.headers['x-api-key'];
      const apiKeyHeader = Array.isArray(apiKeyHeaderRaw) ? apiKeyHeaderRaw[0] : (apiKeyHeaderRaw as string | undefined);
      const cacheConfig = matchingRoute.cache;
      const queryString = originalUrl.includes('?') ? originalUrl.split('?')[1] : undefined;
      const cacheKey = (cacheConfig && method === 'GET')
        ? cacheService.buildKey(cacheConfig, basePath, queryString, userIdentifier)
        : undefined;

      const [rateLimitResult, cacheResult] = await Promise.all([
        rateLimitService.enforce({
          serviceName,
          route: matchingRoute,
          method: method as HttpMethod,
          req,
          userId: userIdentifier,
          apiKey: apiKeyHeader,
        }),
        cacheKey ? cacheService.get(cacheKey, cacheConfig!) : Promise.resolve(null),
      ]);

      // Evaluate rate limit
      Object.entries(rateLimitResult.headers).forEach(([header, value]) => {
        res.setHeader(header, value);
      });

      if (!rateLimitResult.allowed) {
        CorsHandler.setHeaders(req, res);
        return res.status(429).json({
          error: 'Too Many Requests',
          message: rateLimitResult.message,
          retryAfter: rateLimitResult.retryAfterSeconds,
        });
      }

      // Evaluate cache result
      let swrStale = false;

      if (cacheResult && cacheKey && cacheConfig) {
        if (!cacheResult.stale) {
          // Full cache hit — return immediately
          logger.info(`Cache HIT (key=${cacheKey})`);
          CorsHandler.setHeaders(req, res);
          res.setHeader('X-Sancus-Cache', 'HIT');
          Object.entries(cacheResult.data.headers).forEach(([k, v]) => {
            if (k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v);
          });
          const browserHeaders = cacheService.buildResponseHeaders(cacheConfig, cacheResult.data.cachedAt);
          Object.entries(browserHeaders).forEach(([k, v]) => res.setHeader(k, v));
          return res.status(cacheResult.data.statusCode).send(cacheResult.data.body);
        }
        // SWR stale — return stale data but proceed to revalidate in background
        logger.info(`Cache SWR-STALE (key=${cacheKey}), returning stale and revalidating`);
        swrStale = true;
        await cacheService.markRevalidating(cacheKey);

        CorsHandler.setHeaders(req, res);
        res.setHeader('X-Sancus-Cache', 'SWR-STALE');
        Object.entries(cacheResult.data.headers).forEach(([k, v]) => {
          if (k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v);
        });
        const browserHeaders = cacheService.buildResponseHeaders(cacheConfig, cacheResult.data.cachedAt);
        Object.entries(browserHeaders).forEach(([k, v]) => res.setHeader(k, v));
        res.status(cacheResult.data.statusCode).send(cacheResult.data.body);
        // Don't return — fall through to proxy for background revalidation
      }

      let hostUrl: string;
      try {
        hostUrl = this.getHostUrl(serviceDetails.host);
      } catch (error) {
        logger.error(error);
        if (!swrStale) {
          return res.status(500).send('Internal Server Error');
        }
        return; // SWR already sent response
      }

      const destination = `${hostUrl}${serviceDetails.port !== 80 ? `:${serviceDetails.port}` : ''}`;
      logger.info(`New destination :${destination}`);

      // Attach context for shared proxy event handlers
      (req as any).__sancusCtx = {
        correlationalId: uuidv4(),
        tokenDetails,
        uploadedFiles: (req as any).uploadedFiles,
        shouldCacheResponse: !!cacheKey && !!cacheConfig && method === 'GET',
        cacheKey,
        cacheConfig,
        swrStale,
        serviceName,
        method: method as string,
        basePath,
        destination,
      } as SancusProxyContext;

      // Rewrite URL to backend path (replaces pathRewrite option)
      req.url = baseUrl;

      // Proxy with per-request options
      proxy.web(req, res, {
        target: destination,
        agent: destination.startsWith('https') ? httpsAgent : httpAgent,
        selfHandleResponse: swrStale,
      });
    } catch (error: any) {
      const correlationId = (req as any)?.__sancusCtx?.correlationalId || (req as any).correlationalId || 'unknown';
      const alertKey = `error:${req.method}:${req.originalUrl}`;
      if (shouldAlert(alertKey)) {
        alertService.sendAlert(
          '🚨 Gateway Pipeline Error',
          `**Request:** ${req.method} ${req.originalUrl}\n**Error:** ${error.message}\n**Correlation ID:** \`${correlationId}\`\n**Time:** ${new Date().toISOString()}\n**Stack:** \`\`\`${(error.stack || '').slice(0, 400)}\`\`\``
        );
      }
      next(error);
    }
  }
}

export default CommonRequestController;
