/**
 * Rate-limit headers, in the families most gateways emit:
 *   legacy  X-RateLimit-Limit / -Remaining / -Reset   (APISIX, Tyk, Envoy, Kong)
 *   draft   RateLimit-Limit / -Remaining / -Reset     (IETF draft; Kong, Envoy; "limit;w=window" policy form)
 * RATELIMIT_HEADERS = both (default) | legacy | draft. Each family is three headers on every
 * limited response, so picking the one your clients read saves bytes on every response.
 * Reset values are delta-seconds until the window resets.
 */
const family = (process.env.RATELIMIT_HEADERS || 'both').toLowerCase();
const LEGACY = family !== 'draft';
const DRAFT = family !== 'legacy';

export function rateLimitHeaders(
  limit: number,
  remaining: number,
  resetSeconds: number,
  windowSeconds: number
): Record<string, string> {
  const rem = String(Math.max(0, remaining));
  const reset = String(Math.max(0, Math.ceil(resetSeconds)));
  const headers: Record<string, string> = {};
  if (LEGACY) {
    headers['X-RateLimit-Limit'] = String(limit);
    headers['X-RateLimit-Remaining'] = rem;
    headers['X-RateLimit-Reset'] = reset;
  }
  if (DRAFT) {
    headers['RateLimit-Limit'] = `${limit}, ${limit};w=${windowSeconds}`;
    headers['RateLimit-Remaining'] = rem;
    headers['RateLimit-Reset'] = reset;
  }
  return headers;
}
