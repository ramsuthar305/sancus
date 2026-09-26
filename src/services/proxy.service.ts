import type { Request, Response } from 'express';
import http from 'http';
import httpProxy from 'http-proxy';
import https from 'https';
import CircuitBreaker from 'opossum';
import getLogger from '../configs/logger';
import { cacheEvents, upstreamDuration, upstreamUp } from '../configs/metrics';
import type { APIRoute, CacheConfig, HeaderRules, Service } from '../types/api';
import type { AuthResponse } from '../types/auth';
import ResponseEnum from '../types/responseEnums';
import AlertService from '../utils/alerts';
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
  onHeaders?: (status: number) => void;
}

const logger = getLogger();
const alertService = AlertService.getInstance();
const cacheService = CacheService.getInstance();

const AUTH_FORWARD_HEADER = process.env.AUTH_FORWARD_HEADER || 'X-AUTHORIZED-FOR-ID';
const DEFAULT_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 60_000;
const UNHEALTHY_TTL_MS = Number(process.env.UPSTREAM_UNHEALTHY_TTL_MS) || 30_000;
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE']);

const agentOptions = { keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: 60_000 };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

class ProxyService {
  private static instance: ProxyService;
  private readonly server = httpProxy.createProxyServer({ changeOrigin: true, xfwd: true });
  private readonly roundRobin = new Map<string, number>();
  private readonly downUntil = new Map<string, number>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly rewrites = new Map<string, RegExp>();

  private constructor() {
    this.server.on('proxyReq', (proxyReq, req, res) => this.onProxyReq(proxyReq, req as Request, res as Response));
    this.server.on('proxyRes', (proxyRes, req, res) => this.onProxyRes(proxyRes, req as Request, res as Response));
  }

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

  private attempt(req: Request, res: Response, ctx: ProxyContext): Promise<void> {
    return new Promise((resolve, reject) => {
      const nodes = this.resolveNodes(ctx.service);
      const node = this.pickNode(ctx.serviceName, nodes);
      ctx.destination = node;
      ctx.startedAt = Date.now();
      ctx.onHeaders = (status) => {
        if (status >= 500) reject(Object.assign(new Error(`upstream ${status}`), { code: 'UPSTREAM_5XX', status }));
        else resolve();
      };

      this.server.web(
        req,
        res,
        {
          target: node,
          agent: node.startsWith('https') ? httpsAgent : httpAgent,
          selfHandleResponse: ctx.swrStale,
          proxyTimeout: ctx.service.timeout ?? DEFAULT_TIMEOUT_MS,
        },
        (err: NodeJS.ErrnoException) => {
          const retryable = RETRYABLE.has(err.code ?? '');
          if (retryable) this.markDown(ctx.serviceName, node);
          if (retryable && !res.headersSent && IDEMPOTENT.has(ctx.method) && ctx.attempt < (ctx.service.retries ?? 0)) {
            ctx.attempt += 1;
            logger.warn({ service: ctx.serviceName, node, attempt: ctx.attempt, err: err.code }, 'retrying upstream');
            this.attempt(req, res, ctx).then(resolve, reject);
            return;
          }
          reject(err);
        }
      );
    });
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

  // --- request / response hooks --------------------------------------------------------------

  private applyHeaderRules(proxyReq: http.ClientRequest, rules?: HeaderRules): void {
    if (!rules) return;
    rules.remove?.forEach((h) => proxyReq.removeHeader(h));
    Object.entries(rules.add ?? {}).forEach(([k, v]) => proxyReq.setHeader(k, v));
  }

  private onProxyReq(proxyReq: http.ClientRequest, req: Request, res: Response): void {
    const ctx = (req as any).__sancusCtx as ProxyContext | undefined;
    if (!ctx) return;

    proxyReq.setHeader('X-Request-Id', ctx.correlationalId);
    proxyReq.setHeader('Correlation-ID', ctx.correlationalId); // legacy alias
    if (ctx.tokenDetails) proxyReq.setHeader(AUTH_FORWARD_HEADER, String(ctx.tokenDetails.id));
    Object.entries(ctx.authUpstreamHeaders ?? {}).forEach(([k, v]) => proxyReq.setHeader(k, v));
    this.applyHeaderRules(proxyReq, ctx.service.headers);
    this.applyHeaderRules(proxyReq, ctx.route.headers);

    const uploadedFiles = ctx.uploadedFiles;
    if (uploadedFiles?.length && String(req.headers['content-type'] ?? '').includes('multipart/form-data')) {
      this.forwardMultipart(proxyReq, req, res, uploadedFiles);
    }
  }

  /** multer parsed the upload to disk; rebuild the multipart body for the upstream. */
  private forwardMultipart(proxyReq: http.ClientRequest, req: Request, res: Response, uploadedFiles: any[]): void {
    const invalid = uploadedFiles.filter((f) => !FileUtil.validateFile(f).isValid);
    if (invalid.length) {
      FileUtil.cleanupFiles(uploadedFiles);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File validation failed', details: invalid.map((f) => ({ filename: f.originalname, error: FileUtil.validateFile(f).error })) }));
      proxyReq.destroy();
      return;
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
    const body = Buffer.concat(parts);

    proxyReq.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
    proxyReq.setHeader('Content-Length', body.length);
    proxyReq.write(body);
    FileUtil.cleanupFiles(uploadedFiles);
  }

  private onProxyRes(proxyRes: http.IncomingMessage, req: Request, res: Response): void {
    const ctx = (req as any).__sancusCtx as ProxyContext | undefined;
    if (!ctx) return;
    const status = proxyRes.statusCode ?? 0;
    ctx.onHeaders?.(status);

    upstreamDuration.observe(
      { service: ctx.serviceName, route: ctx.route.path, method: ctx.method, code: String(status) },
      (Date.now() - ctx.startedAt) / 1000
    );
    upstreamUp.set({ service: ctx.serviceName, node: ctx.destination }, 1);

    // SSE: never buffer, never advertise a length
    if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
      delete proxyRes.headers['content-length'];
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Connection', 'keep-alive');
    }

    if (status >= 500) {
      alertService.alert(
        `5xx:${ctx.serviceName}:${ctx.method}:${ctx.route.path}:${status}`,
        `🚨 Backend ${status} Error`,
        `**Service:** ${ctx.serviceName}\n**Request:** ${ctx.method} ${ctx.basePath}\n**Status:** ${status} ${proxyRes.statusMessage}\n**Destination:** ${ctx.destination}\n**Request ID:** \`${ctx.correlationalId}\``
      );
    }

    if (!ctx.shouldCacheResponse || !ctx.cacheKey || !ctx.cacheConfig) return;
    const { cacheKey, cacheConfig } = ctx;

    if (!cacheService.isCacheableResponse(status, proxyRes.headers, cacheConfig)) {
      cacheEvents.inc({ service: ctx.serviceName, status: 'BYPASS' });
      if (!ctx.swrStale) Object.entries(cacheService.responseHeaders(cacheConfig, cacheKey, 'BYPASS')).forEach(([k, v]) => res.setHeader(k, v));
      return;
    }

    cacheEvents.inc({ service: ctx.serviceName, status: 'MISS' });
    if (!ctx.swrStale) Object.entries(cacheService.responseHeaders(cacheConfig, cacheKey, 'MISS')).forEach(([k, v]) => res.setHeader(k, v));

    const chunks: Buffer[] = [];
    proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const headersToCache: Record<string, string> = {};
      for (const h of ['content-type', 'content-encoding', 'content-language']) {
        const v = proxyRes.headers[h];
        if (v) headersToCache[h] = Array.isArray(v) ? v[0] : v;
      }
      cacheService.set(cacheKey, status, headersToCache, Buffer.concat(chunks), cacheConfig).catch((err) => {
        logger.error({ err: err.message, cacheKey }, 'failed to write cache');
      });
    });
  }
}

export default ProxyService;
