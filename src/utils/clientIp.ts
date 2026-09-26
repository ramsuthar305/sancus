import type { Request } from 'express';

/**
 * Client IP as resolved by Express `trust proxy` (set from TRUST_PROXY in index.ts).
 * Never read X-Forwarded-For directly: with trust proxy unset, a client can forge it.
 */
export function getClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** TRUST_PROXY: "false" (default), "true", a hop count ("1"), or Express keywords/CIDRs ("loopback, 10.0.0.0/8"). */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
