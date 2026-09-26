import { NextFunction, Request, Response } from 'express';
import { httpRequestDuration, httpRequestsTotal } from '../configs/metrics';

/** Counts and times every request; labels come from the pipeline context once a route matched. */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ctx = (req as any).__sancusCtx;
    const labels = {
      service: ctx?.serviceName ?? '-',
      route: ctx?.route?.path ?? '-',
      method: req.method,
      code: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
  });
  next();
}
