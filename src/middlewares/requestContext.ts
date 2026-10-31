import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import getLogger, { requestContext } from '../configs/logger';
import { GATEWAY_OWNED_HEADERS } from '../clients/authClient';

export const REQUEST_ID_HEADER = 'X-Request-Id';

// LOG_HEADERS_DROP  comma-separated header names removed from access logs entirely
const dropHeaders = (process.env.LOG_HEADERS_DROP ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

/**
 * Honour an incoming X-Request-Id, otherwise mint one. The id is echoed to the client,
 * forwarded upstream by the proxy, and attached to every log line via AsyncLocalStorage.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id =
    (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128 ? incoming : undefined) ||
    randomUUID();
  (req as any).id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  requestContext.run({ requestId: id }, next);
}

/**
 * Remove gateway-owned identity headers from the incoming request before anything reads it,
 * so policies, logs and the proxy only ever see values the gateway set itself.
 */
export function stripOwnedHeaders(req: Request, _res: Response, next: NextFunction): void {
  for (const h of GATEWAY_OWNED_HEADERS) delete req.headers[h];
  next();
}

// LOG_SAMPLE_RATE  share of fast 1xx-3xx requests that get an access log line, 0..1 (default 1 = all)
// LOG_SLOW_MS      requests slower than this are always logged (default 1000)
// 4xx, 5xx and aborted requests are always logged.
const sampleRate = Math.min(1, Math.max(0, Number(process.env.LOG_SAMPLE_RATE ?? 1)));
const slowMs = Number(process.env.LOG_SLOW_MS ?? 1000);
const logger = getLogger();

function serializeReq(req: Request) {
  const headers: Record<string, unknown> = { ...req.headers };
  dropHeaders.forEach((h) => delete headers[h]);
  return { id: (req as any).id, method: req.method, url: req.originalUrl, remoteAddress: req.socket?.remoteAddress, headers };
}

/**
 * One access log line per request, in the shape pino-http wrote ({ req, res, responseTime }).
 * Unlike pino-http it builds no per-request child logger: nothing is serialized or redacted
 * until a line is actually written, so sampled-out requests cost a timestamp and two listeners.
 */
export function accessLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const done = () => {
    res.removeListener('finish', done);
    res.removeListener('close', done);
    const responseTime = Date.now() - start;
    const status = res.statusCode;
    const aborted = !res.writableFinished;
    if (!aborted && status < 400 && responseTime < slowMs && (sampleRate === 0 || (sampleRate < 1 && Math.random() >= sampleRate))) return;
    const line = { req: serializeReq(req), res: { statusCode: status }, responseTime };
    if (aborted) logger.warn(line, 'request aborted');
    else if (status >= 500) logger.error({ ...line, err: { message: `failed with status code ${status}` } }, 'request errored');
    else if (status >= 400) logger.warn(line, 'request completed');
    else logger.info(line, 'request completed');
  };
  res.on('finish', done);
  res.on('close', done);
  next();
}
