import type { Request, Response } from 'express';
import http from 'http';
import https from 'https';
import CircuitBreaker from 'opossum';
import getLogger from '../configs/logger';
import { cacheEvents, upstreamDuration, upstreamUp } from '../configs/metrics';
import type { APIRoute, CacheConfig, HeaderRules, Service } from '../types/api';
import type { AuthResponse } from '../types/auth';
import ResponseEnum from '../types/responseEnums';
import AlertService from '../utils/alerts';
import { AUTH_FORWARD_HEADER, GATEWAY_OWNED_HEADERS } from '../clients/authClient';
import FileUtil from '../utils/fileUtil';
import SancusResponse from '../utils/responseUtil';
import CacheService from './cache.service';

export interface ProxyContext {
  correlationalId: string;
  serviceName: string;
  service: Service;
  route: APIRoute;
  method: string;
  basePath: string;
  destination: string;
  tokenDetails?: AuthResponse;
  authUpstreamHeaders?: Record<string, string>;
  uploadedFiles?: any[];
  shouldCacheResponse: boolean;
  cacheKey?: string;
  cacheConfig?: CacheConfig;
  swrStale: boolean;
  attempt: number;
  startedAt: number;
}

interface Target {
  isHttps: boolean;
  host: string;
  port: number;
  hostHeader: string;
}

const logger = getLogger();
const alertService = AlertService.getInstance();
const cacheService = CacheService.getInstance();

const DEFAULT_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 60_000;
const UNHEALTHY_TTL_MS = Number(process.env.UPSTREAM_UNHEALTHY_TTL_MS) || 30_000;
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE']);
// Only connection-level failures mark a node unhealthy; a reset or timeout on one request is not the node's fault.
const NODE_DOWN = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
// RFC 9110 §7.6.1: never forwarded in either direction.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);

// One pool per gateway process. Free sockets are never capped below the busy limit: capping them
// (the old maxFreeSockets: 32) destroyed idle sockets under load and exhausted ephemeral ports.
const MAX_SOCKETS = Number(process.env.UPSTREAM_MAX_SOCKETS) || 256;
const agentOptions = { keepAlive: true, maxSockets: MAX_SOCKETS, maxFreeSockets: MAX_SOCKETS, scheduling: 'lifo' as const, timeout: 60_000 };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

/**
 * Direct Node http(s).request pipe to the upstream. Replaces http-proxy: ~40% less CPU per
 * request, and every header decision is explicit here rather than inside the library.
 */
class ProxyService {
  private static instance: ProxyService;
  private readonly roundRobin = new Map<string, number>();
  private readonly downUntil = new Map<string, number>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly rewrites = new Map<string, RegExp>();
  private readonly targets = new Map<string, Target>();

  private constructor() {}

  static getInstance(): ProxyService {
    if (!ProxyService.instance) ProxyService.instance = new ProxyService();
    return ProxyService.instance;
  }

  // --- upstream selection -------------------------------------------------------------------

  /** `nodes` as-is, else the legacy `host` env var + port. */
  resolveNodes(service: Service): string[] {
    if (service.nodes?.length) return service.nodes;
    const base = process.env[service.host || ''] || '';
    if (!base) throw new Error(`No host URL found for host ID: ${service.host}`);
    return [`${base}${service.port && service.port !== 80 ? `:${service.port}` : ''}`];
  }

  private target(node: string): Target {
    let t = this.targets.get(node);
    if (!t) {
      const u = new URL(node);
      const isHttps = u.protocol === 'https:';
      const port = Number(u.port) || (isHttps ? 443 : 80);
      t = { isHttps, host: u.hostname, port, hostHeader: u.port ? `${u.hostname}:${u.port}` : u.hostname };
      this.targets.set(node, t);
    }
    return t;
  }

  private pickNode(serviceName: string, nodes: string[]): string {
    if (nodes.length === 1) return nodes[0];
    const now = Date.now();
    const start = this.roundRobin.get(serviceName) ?? 0;
    for (let i = 0; i < nodes.length; i++) {
      const idx = (start + i) % nodes.length;
      if ((this.downUntil.get(nodes[idx]) ?? 0) <= now) {
        this.roundRobin.set(serviceName, idx + 1);
        return nodes[idx];
      }
    }
    return nodes[start % nodes.length]; // everything is down: try anyway
  }

  private markDown(serviceName: string, node: string): void {
    this.downUntil.set(node, Date.now() + UNHEALTHY_TTL_MS);
    upstreamUp.set({ service: serviceName, node }, 0);
    logger.warn({ service: serviceName, node }, `upstream node marked unhealthy for ${UNHEALTHY_TTL_MS}ms`);
  }

  /** Path after /api/<service>, with the service's optional regex rewrite applied. */
  rewritePath(service: Service, upstreamPath: string): string {
    if (!service.rewrite) return upstreamPath;
    const cacheKey = `${service.name}:${service.rewrite.from}`;
    let re = this.rewrites.get(cacheKey);
    if (!re) {
      re = new RegExp(service.rewrite.from);
      this.rewrites.set(cacheKey, re);
    }
    return upstreamPath.replace(re, service.rewrite.to);
  }

  // --- resilience ---------------------------------------------------------------------------

  private breakerFor(service: Service): CircuitBreaker | undefined {
    if (!service.circuitBreaker) return undefined;
    let breaker = this.breakers.get(service.name);
    if (!breaker) {
      breaker = new CircuitBreaker((req: Request, res: Response, ctx: ProxyContext) => this.attempt(req, res, ctx), {
        timeout: false,
        errorThresholdPercentage: service.circuitBreaker.errorThresholdPercentage ?? 50,
        volumeThreshold: service.circuitBreaker.volumeThreshold ?? 10,
        resetTimeout: service.circuitBreaker.resetTimeout ?? 30_000,
      });
      breaker.on('open', () => {
        logger.error({ service: service.name }, 'circuit breaker OPEN');
        alertService.alert(`breaker:${service.name}`, '🚨 Circuit breaker open', `**Service:** ${service.name}`);
      });
      breaker.on('close', () => logger.info({ service: service.name }, 'circuit breaker closed'));
      this.breakers.set(service.name, breaker);
    }
    return breaker;
  }

  /** Entry point. Errors are handled here; callers never await. */
  proxy(req: Request, res: Response, ctx: ProxyContext): void {
    const breaker = this.breakerFor(ctx.service);
    const run = breaker ? breaker.fire(req, res, ctx) : this.attempt(req, res, ctx);
    run.catch((err: NodeJS.ErrnoException) => this.fail(req, res, ctx, err));
  }

  // --- the pipe -------------------------------------------------------------------------------

  private applyHeaderRules(headers: http.OutgoingHttpHeaders, rules?: HeaderRules): void {
    if (!rules) return;
    rules.remove?.forEach((h) => delete headers[h.toLowerCase()]);
    Object.entries(rules.add ?? {}).forEach(([k, v]) => (headers[k.toLowerCase()] = v));
  }

  private upstreamHeaders(req: Request, ctx: ProxyContext, target: Target): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    // Gateway-owned identity headers are never copied from the client (also stripped on arrival).
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && !GATEWAY_OWNED_HEADERS.has(k) && v !== undefined) headers[k] = v;
    headers.host = target.hostHeader;

    const remote = req.socket?.remoteAddress ?? '';
    const xff = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = xff ? `${xff}, ${remote}` : remote;
    headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] as string) || ((req.socket as any)?.encrypted ? 'https' : 'http');
    headers['x-forwarded-host'] = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
    headers['x-request-id'] = ctx.correlationalId;
    headers['correlation-id'] = ctx.correlationalId; // legacy alias
    if (ctx.tokenDetails) headers[AUTH_FORWARD_HEADER] = String(ctx.tokenDetails.id);
    Object.entries(ctx.authUpstreamHeaders ?? {}).forEach(([k, v]) => (headers[k.toLowerCase()] = v));
    this.applyHeaderRules(headers, ctx.service.headers);
    this.applyHeaderRules(headers, ctx.route.headers);
    return headers;
  }

  /** multer parsed the upload to disk; rebuild the multipart body. Returns null (and answers 400) on invalid files. */
  private multipartBody(req: Request, res: Response, uploadedFiles: any[]): { body: Buffer; contentType: string } | null {
    const invalid = uploadedFiles.filter((f) => !FileUtil.validateFile(f).isValid);
    if (invalid.length) {
      FileUtil.cleanupFiles(uploadedFiles);
      res.status(400).json({ error: 'File validation failed', details: invalid.map((f) => ({ filename: f.originalname, error: FileUtil.validateFile(f).error })) });
      return null;
    }
    const boundary = '----SancusFormBoundary' + Math.random().toString(16).slice(2);
    const parts: Buffer[] = [];
    Object.entries((req.body ?? {}) as Record<string, unknown>).forEach(([key, value]) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    });
    uploadedFiles.forEach((file) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname}"; filename="${file.originalname}"\r\nContent-Type: ${file.mimetype}\r\n\r\n`));
      parts.push(FileUtil.readFileAsBuffer(file.path));
      parts.push(Buffer.from('\r\n'));
    });
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    FileUtil.cleanupFiles(uploadedFiles);
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  private attempt(req: Request, res: Response, ctx: ProxyContext): Promise<void> {
    return new Promise((resolve, reject) => {
      const nodes = this.resolveNodes(ctx.service);
      const node = this.pickNode(ctx.serviceName, nodes);
      const target = this.target(node);
      ctx.destination = node;
      ctx.startedAt = Date.now();

      const headers = this.upstreamHeaders(req, ctx, target);
      let body: Buffer | undefined;
      if (ctx.uploadedFiles?.length && String(req.headers['content-type'] ?? '').includes('multipart/form-data')) {
        const mp = this.multipartBody(req, res, ctx.uploadedFiles);
        if (!mp) return resolve(); // 400 already sent
        body = mp.body;
        headers['content-type'] = mp.contentType;
        headers['content-length'] = String(body.length);
      }

      const upReq = (target.isHttps ? https : http).request(
        { host: target.host, port: target.port, path: req.url, method: req.method, headers, agent: target.isHttps ? httpsAgent : httpAgent, timeout: ctx.service.timeout ?? DEFAULT_TIMEOUT_MS },
        (upRes) => {
          this.onUpstreamResponse(upRes, req, res, ctx);
          const status = upRes.statusCode ?? 0;
          if (status >= 500) reject(Object.assign(new Error(`upstream ${status}`), { code: 'UPSTREAM_5XX', status }));
          else resolve();
        }
      );

      upReq.on('timeout', () => upReq.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
      upReq.on('error', (err: NodeJS.ErrnoException) => {
        const retryable = RETRYABLE.has(err.code ?? '');
        if (NODE_DOWN.has(err.code ?? '')) this.markDown(ctx.serviceName, node);
        if (retryable && !res.headersSent && IDEMPOTENT.has(ctx.method) && ctx.attempt < (ctx.service.retries ?? 0)) {
          ctx.attempt += 1;
          logger.warn({ service: ctx.serviceName, node, attempt: ctx.attempt, err: err.code }, 'retrying upstream');
          this.attempt(req, res, ctx).then(resolve, reject);
          return;
        }
        reject(err);
      });
      // Client went away: stop the upstream request instead of finishing it for nobody.
      res.on('close', () => { if (!res.writableFinished) upReq.destroy(); });

      if (body) upReq.end(body);
      else req.pipe(upReq);
    });
  }

  private onUpstreamResponse(upRes: http.IncomingMessage, req: Request, res: Response, ctx: ProxyContext): void {
    const status = upRes.statusCode ?? 0;
    upstreamDuration.observe({ service: ctx.serviceName, route: ctx.route.path, method: ctx.method, code: String(status) }, (Date.now() - ctx.startedAt) / 1000);
    upstreamUp.set({ service: ctx.serviceName, node: ctx.destination }, 1);

    if (status >= 500) {
      alertService.alert(
        `5xx:${ctx.serviceName}:${ctx.method}:${ctx.route.path}:${status}`,
        `🚨 Backend ${status} Error`,
        `**Service:** ${ctx.serviceName}\n**Request:** ${ctx.method} ${ctx.basePath}\n**Status:** ${status} ${upRes.statusMessage}\n**Destination:** ${ctx.destination}\n**Request ID:** \`${ctx.correlationalId}\``
      );
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v;
    const isSse = String(headers['content-type'] ?? '').includes('text/event-stream');
    if (isSse) delete headers['content-length']; // chunked, never buffered

    // --- caching -------------------------------------------------------------------------------
    let capture: Buffer[] | undefined;
    if (ctx.shouldCacheResponse && ctx.cacheKey && ctx.cacheConfig) {
      const cacheable = cacheService.isCacheableResponse(status, upRes.headers, ctx.cacheConfig);
      cacheEvents.inc({ service: ctx.serviceName, status: cacheable ? 'MISS' : 'BYPASS' });
      if (!ctx.swrStale) Object.assign(headers, cacheService.responseHeaders(ctx.cacheConfig, ctx.cacheKey, cacheable ? 'MISS' : 'BYPASS'));
      if (cacheable) {
        capture = [];
        const { cacheKey, cacheConfig } = ctx;
        upRes.on('data', (chunk: Buffer) => capture!.push(chunk));
        upRes.on('end', () => {
          const headersToCache: Record<string, string> = {};
          for (const h of ['content-type', 'content-encoding', 'content-language']) {
            const v = upRes.headers[h];
            if (v) headersToCache[h] = Array.isArray(v) ? v[0] : v;
          }
          cacheService.set(cacheKey, status, headersToCache, Buffer.concat(capture!), cacheConfig).catch((err) => logger.error({ err: err.message, cacheKey }, 'failed to write cache'));
        });
      }
    }

    if (ctx.swrStale) {
      // Stale response already sent to the client; this round trip only refreshes the cache.
      upRes.resume();
      return;
    }
    if (res.headersSent) { upRes.resume(); return; } // e.g. multipart validation already answered

    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      upRes.resume();
      res.end();
      return;
    }
    if (isSse && typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();
    upRes.pipe(res);
  }

  private fail(req: Request, res: Response, ctx: ProxyContext, err: NodeJS.ErrnoException & { status?: number }): void {
    if (err.code === 'UPSTREAM_5XX') return; // response already streamed to the client; only the breaker cares
    const requestId = ctx.correlationalId;

    if (err.code === 'EOPENBREAKER') {
      if (!res.headersSent) {
        res.setHeader('Retry-After', String(Math.ceil((ctx.service.circuitBreaker?.resetTimeout ?? 30_000) / 1000)));
        new SancusResponse(ResponseEnum.SERVICE_UNAVAILABLE, {}, res);
      }
      return;
    }

    const status = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' ? 504 : 502;
    logger.error({ err: err.message, code: err.code, service: ctx.serviceName, destination: ctx.destination }, 'proxy error');
    alertService.alert(
      `proxy-error:${ctx.serviceName}:${err.code}`,
      '🚨 Proxy Error',
      `**Service:** ${ctx.serviceName}\n**Request:** ${ctx.method} ${ctx.basePath}\n**Destination:** ${ctx.destination}\n**Error:** ${err.code ?? ''} ${err.message}\n**Request ID:** \`${requestId}\``
    );
    if (!res.headersSent) {
      res.status(status).json({ message: status === 504 ? 'Upstream timed out' : 'Bad gateway', response_code: `SE0${status}` });
    } else {
      res.end();
    }
  }
}

export default ProxyService;
