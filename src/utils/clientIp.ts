import type { Request } from 'express';

/**
 * Client IP as resolved by Express `trust proxy` (set from TRUST_PROXY in index.ts).
 * Never read X-Forwarded-For directly: with trust proxy unset, a client can forge it.
 */
export function getClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * TRUST_PROXY: Express keywords/CIDRs ("loopback, 10.0.0.0/8"), a hop count ("1"), "true", or "false".
 * Default trusts private address space, which is where a load balancer or ingress lives in a VPC or
 * cluster: X-Forwarded-For is honoured only when the direct peer is a private/loopback address, so a
 * public client cannot forge it. Proxies with public IPs (e.g. Cloudflare) must be listed explicitly.
 */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

export function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '') return DEFAULT_TRUST_PROXY;
  if (value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
