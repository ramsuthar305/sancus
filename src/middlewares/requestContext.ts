import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import pinoHttp from 'pino-http';
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

export const accessLogger = pinoHttp({
  logger: getLogger(),
  genReqId: (req) => (req as any).id,
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req(req) {
      const headers: Record<string, unknown> = { ...req.headers };
      dropHeaders.forEach((h) => delete headers[h]);
      return { id: req.id, method: req.method, url: req.url, remoteAddress: req.remoteAddress, headers };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});
