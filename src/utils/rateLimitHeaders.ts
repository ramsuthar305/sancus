/**
 * Both header families most gateways emit:
 *   legacy  X-RateLimit-Limit / -Remaining / -Reset   (APISIX, Tyk, Envoy, Kong)
 *   IETF    RateLimit-Limit / -Remaining / -Reset     (Kong, Envoy; "limit;w=window" policy form)
 * Reset values are delta-seconds until the window resets.
 */
export function rateLimitHeaders(
  limit: number,
  remaining: number,
  resetSeconds: number,
  windowSeconds: number
): Record<string, string> {
  const rem = String(Math.max(0, remaining));
  const reset = String(Math.max(0, Math.ceil(resetSeconds)));
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': rem,
    'X-RateLimit-Reset': reset,
    'RateLimit-Limit': `${limit}, ${limit};w=${windowSeconds}`,
    'RateLimit-Remaining': rem,
    'RateLimit-Reset': reset,
  };
}
