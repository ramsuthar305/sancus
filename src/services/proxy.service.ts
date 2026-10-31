import type { Request, Response } from 'express';
import http, { IncomingHttpHeaders } from 'http';
import { EventEmitter } from 'events';
import CircuitBreaker from 'opossum';
import { Readable, pipeline } from 'stream';
import { Dispatcher, Pool } from 'undici';
import getLogger from '../configs/logger';
import { cacheEvents, upstreamDuration, upstreamUp } from '../configs/metrics';
import type { APIRoute, CacheConfig, HeaderRules, Service } from '../types/api';
import type { AuthResponse } from '../types/auth';
import ResponseEnum from '../types/responseEnums';
import AlertService from '../utils/alerts';
import { createCompressor, decideCompression, mergeVary } from '../utils/compression';
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

// Connections per upstream node per worker. By Little's law, in-flight requests = rate x latency,
// so this caps one worker at about MAX_SOCKETS / upstream-latency requests per second per node
// (256 / 0.2 s = 1,280 req/s for a 200 ms upstream); past that, requests queue here. The cap is
// also backpressure that keeps a spike from opening unlimited connections to the upstream.
const MAX_SOCKETS = Number(process.env.UPSTREAM_MAX_SOCKETS) || 256;

// undici reports its own codes; map them onto the ones the retry / node-down / 502-504 logic uses.
const UNDICI_CODES: Record<string, string> = {
  UND_ERR_HEADERS_TIMEOUT: 'ETIMEDOUT',
  UND_ERR_BODY_TIMEOUT: 'ETIMEDOUT',
  UND_ERR_CONNECT_TIMEOUT: 'ETIMEDOUT',
  UND_ERR_SOCKET: 'ECONNRESET', // "other side closed"
};
function normalizeCode(err: NodeJS.ErrnoException): string | undefined {
  const code = err.code ?? (err.cause as NodeJS.ErrnoException | undefined)?.code;
  return (code && UNDICI_CODES[code]) || code;
}
const hasBody = (req: Request) => req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');

/**
 * Proxies to the upstream through undici pools (one per node): a lighter client than
 * http.request, with every header decision explicit here rather than inside a proxy library.
 */
class ProxyService {
  private static instance: ProxyService;
  private readonly roundRobin = new Map<string, number>();
  private readonly downUntil = new Map<string, number>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly rewrites = new Map<string, RegExp>();
  private readonly targets = new Map<string, Target>();
  private readonly pools = new Map<string, Pool>();

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
    // Forwarded proto/host: taken from X-Forwarded-* only when the peer is a trusted proxy
    // (TRUST_PROXY); otherwise from the connection and Host header. A client cannot choose them.
    const trust = req.app?.get('trust proxy fn') as ((addr: string, i: number) => boolean) | undefined;
    const peerTrusted = !!trust && trust(remote, 0);
    const fwdHost = peerTrusted ? (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0].trim() : undefined;
    headers['x-forwarded-proto'] = req.protocol || ((req.socket as any)?.encrypted ? 'https' : 'http');
    headers['x-forwarded-host'] = fwdHost || req.headers.host || '';
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

  /** One keep-alive pool per upstream node (origin), shared by every request in this worker. */
  private pool(node: string): Pool {
    let p = this.pools.get(node);
    if (!p) {
      p = new Pool(new URL(node).origin, { connections: MAX_SOCKETS, pipelining: 1, keepAliveTimeout: 60_000 });
      this.pools.set(node, p);
    }
    return p;
  }

  private attempt(req: Request, res: Response, ctx: ProxyContext): Promise<void> {
    return new Promise((resolve, reject) => {
      const nodes = this.resolveNodes(ctx.service);
      const node = this.pickNode(ctx.serviceName, nodes);
      const target = this.target(node);
      ctx.destination = node;
      ctx.startedAt = Date.now();

      const headers = this.upstreamHeaders(req, ctx, target);
      delete headers.expect; // undici refuses Expect; a proxy answers 100-continue itself anyway
      let body: Buffer | Request | undefined;
      if (ctx.uploadedFiles?.length && String(req.headers['content-type'] ?? '').includes('multipart/form-data')) {
        const mp = this.multipartBody(req, res, ctx.uploadedFiles);
        if (!mp) return resolve(); // 400 already sent
        body = mp.body;
        headers['content-type'] = mp.contentType;
        headers['content-length'] = String(body.length);
      } else if (hasBody(req)) {
        body = req;
      }

      const timeout = ctx.service.timeout ?? DEFAULT_TIMEOUT_MS;
      // Client went away: stop the upstream request instead of finishing it for nobody. undici
      // accepts an EventEmitter as the signal; an AbortController would build a DOMException on
      // every request, so this one only costs anything when a client actually hangs up.
      const abort = new EventEmitter();
      res.on('close', () => { if (!res.writableFinished) abort.emit('abort'); });

      this.pool(node)
        .request({ path: req.url, method: req.method as Dispatcher.HttpMethod, headers: headers as Record<string, string | string[]>, body, signal: abort, headersTimeout: timeout, bodyTimeout: timeout })
        .then((up) => {
          this.onUpstreamResponse(up.statusCode, up.headers as IncomingHttpHeaders, up.body, req, res, ctx);
          if (up.statusCode >= 500) reject(Object.assign(new Error(`upstream ${up.statusCode}`), { code: 'UPSTREAM_5XX', status: up.statusCode }));
          else resolve();
        })
        .catch((raw: NodeJS.ErrnoException) => {
          // Never mutate undici's error: some (an AbortError when the client hangs up before the
          // upstream answers) have a read-only `code`, and a throw here would be an uncaught crash.
          const err: NodeJS.ErrnoException = Object.assign(new Error(raw.message), { code: normalizeCode(raw), cause: raw });
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
    });
  }

  private onUpstreamResponse(status: number, upHeaders: IncomingHttpHeaders, upBody: Readable, req: Request, res: Response, ctx: ProxyContext): void {
    upstreamDuration.observe({ service: ctx.serviceName, route: ctx.route.path, method: ctx.method, code: String(status) }, (Date.now() - ctx.startedAt) / 1000);
    upstreamUp.set({ service: ctx.serviceName, node: ctx.destination }, 1);

    if (status >= 500) {
      alertService.alert(
        `5xx:${ctx.serviceName}:${ctx.method}:${ctx.route.path}:${status}`,
        `🚨 Backend ${status} Error`,
        `**Service:** ${ctx.serviceName}\n**Request:** ${ctx.method} ${ctx.basePath}\n**Status:** ${status} ${http.STATUS_CODES[status] ?? ''}\n**Destination:** ${ctx.destination}\n**Request ID:** \`${ctx.correlationalId}\``
      );
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(upHeaders)) if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v;
    const isSse = String(headers['content-type'] ?? '').includes('text/event-stream');
    if (isSse) delete headers['content-length']; // chunked, never buffered

    // --- caching decision -------------------------------------------------------------------
    let cacheable = false;
    if (ctx.shouldCacheResponse && ctx.cacheKey && ctx.cacheConfig) {
      cacheable = cacheService.isCacheableResponse(status, upHeaders, ctx.cacheConfig);
      cacheEvents.inc({ service: ctx.serviceName, status: cacheable ? 'MISS' : 'BYPASS' });
      if (!ctx.swrStale) Object.assign(headers, cacheService.responseHeaders(ctx.cacheConfig, ctx.cacheKey, cacheable ? 'MISS' : 'BYPASS'));
    }
    if (res.headersSent && !ctx.swrStale) { upBody.resume(); return; } // e.g. multipart validation already answered
    if (ctx.swrStale && !cacheable) { upBody.resume(); return; } // stale copy already sent, nothing to refresh

    // --- compression (native zlib, only when it pays) ------------------------------------------
    const comp = decideCompression(req, status, upHeaders);
    if (comp.vary) mergeVary(headers, 'Accept-Encoding');
    else mergeVary(headers); // fold upstream `vary` and the cache's `Vary` into one header
    const compressor = comp.encoding ? createCompressor(comp.encoding) : undefined;
    if (compressor) {
      headers['content-encoding'] = comp.encoding;
      delete headers['content-length'];
    }
    const body: Readable = compressor ?? upBody;

    // --- cache write: the bytes exactly as sent (compressed ones for a br/gzip cache key) ------
    if (cacheable && ctx.cacheKey && ctx.cacheConfig) {
      const capture: Buffer[] = [];
      const { cacheKey, cacheConfig } = ctx;
      body.on('data', (chunk: Buffer) => capture.push(chunk));
      body.on('end', () => {
        const headersToCache: Record<string, string> = {};
        for (const h of ['content-type', 'content-encoding', 'content-language']) {
          const v = headers[h];
          if (v) headersToCache[h] = Array.isArray(v) ? v[0] : String(v);
        }
        cacheService.set(cacheKey, status, headersToCache, Buffer.concat(capture), cacheConfig).catch((err) => logger.error({ err: err.message, cacheKey }, 'failed to write cache'));
      });
    }

    if (ctx.swrStale) {
      // Stale response already sent to the client; this round trip only refreshes the cache.
      if (compressor) pipeline(upBody, compressor, (err) => err && logger.warn({ err: err.message }, 'SWR refresh stream failed'));
      else upBody.resume();
      return;
    }

    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      upBody.resume();
      res.end();
      return;
    }
    if (isSse && typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();
    // Neither side may be left hanging: an upstream failing mid-body closes the client response,
    // and a client going away destroys the upstream body (which aborts the request). Uncompressed
    // bodies use pipe() with that wiring by hand: stream.pipeline() builds an AbortController and a
    // DOMException on every call, ~4% of CPU on this path.
    if (compressor) {
      pipeline(upBody, compressor, res, (err) => err && logger.debug({ err: err.message }, 'compressed response stream ended early'));
    } else {
      upBody.on('error', (err) => { logger.debug({ err: err.message }, 'upstream body failed mid-stream'); res.destroy(); });
      res.on('close', () => { if (!upBody.readableEnded) upBody.destroy(); });
      upBody.pipe(res);
    }
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
