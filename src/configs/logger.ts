import { AsyncLocalStorage } from 'async_hooks';
import pino from 'pino';

// Request-scoped context. Anything logged inside `requestContext.run(...)` carries the request id.
export interface RequestContext {
  requestId: string;
}
export const requestContext = new AsyncLocalStorage<RequestContext>();

// LOG_LEVEL           pino level (default info)
// LOG_HEADERS_REDACT  comma-separated header names whose values are masked in logs
const redactHeaders = (process.env.LOG_HEADERS_REDACT ?? 'authorization,cookie,set-cookie,x-api-key,proxy-authorization')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'sancus' },
  redact: {
    paths: redactHeaders.flatMap((h) => [`req.headers["${h}"]`, `res.headers["${h}"]`]),
    censor: '[Redacted]',
  },
  mixin() {
    const ctx = requestContext.getStore();
    return ctx ? { requestId: ctx.requestId } : {};
  },
});

const getLogger = () => logger;
export default getLogger;
