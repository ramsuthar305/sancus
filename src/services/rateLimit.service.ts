import { createHash } from 'crypto';
import type { Request } from 'express';
import getLogger from '../configs/logger';
import { rateLimited } from '../configs/metrics';
import type { APIRoute, HttpMethod, RateLimitConfig } from '../types/api';
import AlertService from '../utils/alerts';
import { getClientIp } from '../utils/clientIp';
import { rateLimitHeaders } from '../utils/rateLimitHeaders';
import { defineScript, runScript } from '../utils/redisScript';
import RedisService from './redis.service';

interface EnforceParams {
  serviceName: string;
  route: APIRoute;
  method: HttpMethod;
  req: Request;
  userId?: string;
  apiKey?: string;
}

interface EnforceResult {
  allowed: boolean;
  headers: Record<string, string>;
  retryAfterSeconds?: number;
  message?: string;
}

interface WindowResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
  reset: number;
}

const logger = getLogger();

/**
 * Sliding-window counter (the Cloudflare / Redis-docs approximation of a sliding log). Counts are
 * kept for the current fixed window and the one before it; the estimate is
 *   previous * (share of the previous window still inside the sliding window) + current.
 * One hash of three fields per key, O(1) time and memory, however many requests a user makes
 * (the old sorted-set log stored one member per request: up to `perDay` members per user).
 * Rejected requests are not counted. Returns {allowed, remaining, retryAfter, reset} in seconds.
 */
const SLIDING_WINDOW = defineScript('sancusSlidingWindow', 1, `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])

  local start = now - (now % windowMs)
  local h = redis.call('HMGET', key, 'w', 'c', 'p')
  local w = tonumber(h[1])
  local cur = tonumber(h[2]) or 0
  local prev = tonumber(h[3]) or 0
  local rolled = w ~= start
  if rolled then
    if w == start - windowMs then prev = cur else prev = 0 end
    cur = 0
  end

  local elapsed = now - start
  local weight = (windowMs - elapsed) / windowMs
  local reset = math.max(1, math.ceil((windowMs - elapsed) / 1000))

  if prev * weight + cur + 1 <= limit then
    cur = cur + 1
    redis.call('HSET', key, 'w', start, 'c', cur, 'p', prev)
    redis.call('PEXPIRE', key, windowMs * 2)
    return {1, math.max(0, math.floor(limit - (prev * weight + cur))), 0, reset}
  end

  -- Rejected: wait until one more request fits under the estimate.
  local waitMs
  if cur + 1 <= limit and prev > 0 then
    waitMs = windowMs * (1 - (limit - cur - 1) / prev) - elapsed      -- later in this window
  else
    local t = 0                                                         -- in the next window, prev = cur
    if cur > limit - 1 then t = windowMs * (1 - (limit - 1) / cur) end
    waitMs = (windowMs - elapsed) + t
  end
  if rolled then
    redis.call('HSET', key, 'w', start, 'c', cur, 'p', prev)
    redis.call('PEXPIRE', key, windowMs * 2)
  end
  local retryAfter = math.max(1, math.ceil(waitMs / 1000))
  return {0, 0, retryAfter, retryAfter}
`);

class RateLimitService {
  private static instance: RateLimitService;
  private readonly redisService = RedisService.getInstance();
  private readonly alertService = AlertService.getInstance();
  private readonly trustedIpSet: Set<string>;

  private constructor() {
    this.trustedIpSet = new Set(
      (process.env.TRUSTED_IPS || '').split(',').map((ip) => ip.trim()).filter(Boolean)
    );
  }

  public static getInstance(): RateLimitService {
    if (!RateLimitService.instance) RateLimitService.instance = new RateLimitService();
    return RateLimitService.instance;
  }

  private resolveIdentifier(strategy: RateLimitConfig['key'], req: Request, userId?: string, apiKey?: string): string {
    const ip = `ip:${getClientIp(req)}`;
    switch (strategy) {
      // The key itself never lands in Redis or alerts: a short hash identifies it.
      case 'API_KEY': return apiKey ? `apikey:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}` : ip;
      case 'USER': return userId ? `user:${userId}` : ip;
      case 'USER_OR_IP': return userId ? `user:${userId}` : ip;
      case 'IP_USER': return userId ? `${ip}|user:${userId}` : ip;
      case 'IP':
      default: return ip;
    }
  }

  private async consumeWindow(key: string, windowMs: number, limit: number): Promise<WindowResult> {
    const redis = this.redisService.getClient();
    if (!redis) throw new Error('Redis client unavailable');
    const r = await runScript<number[]>(redis, SLIDING_WINDOW, key, Date.now(), windowMs, limit);
    return { allowed: r[0] === 1, remaining: r[1], retryAfter: r[2], reset: r[3] };
  }

  /**
   * Enforce the route's rateLimit block. Day window is checked before minute so a day
   * rejection never burns a minute token. Fails open (allows) when Redis is unreachable.
   */
  public async enforce({ serviceName, route, method, req, userId, apiKey }: EnforceParams): Promise<EnforceResult> {
    const rl = route.rateLimit;
    if (!rl || (!rl.perMinute && !rl.perDay)) return { allowed: true, headers: {} };
    if (this.trustedIpSet.has(getClientIp(req))) return { allowed: true, headers: {} };

    const identifier = this.resolveIdentifier(rl.key, req, userId, apiKey);
    const baseKey = rl.group
      ? `ratelimit:group:${rl.group}:${identifier}`
      : `ratelimit:${serviceName}:${method}:${route.path}:${identifier}`;

    const windows: Array<{ name: string; ms: number; limit: number }> = [];
    if (rl.perDay) windows.push({ name: 'd', ms: 86_400_000, limit: rl.perDay });
    if (rl.perMinute) windows.push({ name: 'm', ms: 60_000, limit: rl.perMinute });

    let tightest: { headers: Record<string, string>; remaining: number } | undefined;
    try {
      for (const w of windows) {
        // `:sw` = sliding-window counter hash. New names on purpose: the sorted-set keys of the old
        // log would answer WRONGTYPE (and the limit fail open) until they expired, up to a day.
        const result = await this.consumeWindow(`${baseKey}:${w.name}:sw`, w.ms, w.limit);
        const headers = rl.hideHeaders ? {} : rateLimitHeaders(w.limit, result.remaining, result.reset, w.ms / 1000);
        if (!result.allowed) {
          rateLimited.inc({ service: serviceName, route: route.path, scope: 'route' });
          this.alertService.alert(
            `ratelimit:${identifier}`,
            '⚠️ Rate Limit Exceeded',
            `**Identifier:** ${identifier}\n**Endpoint:** ${method} ${route.path}\n**Service:** ${serviceName}\n**Window:** ${w.name === 'd' ? 'day' : 'minute'} (limit ${w.limit})\n**Retry After:** ${result.retryAfter}s`
          );
          return {
            allowed: false,
            headers,
            retryAfterSeconds: result.retryAfter,
            message: w.name === 'd' ? 'Daily rate limit exceeded' : 'Per-minute rate limit exceeded',
          };
        }
        if (!tightest || result.remaining < tightest.remaining) tightest = { headers, remaining: result.remaining };
      }
    } catch (e) {
      // ponytail: fail open — a Redis outage must not take the API down with it
      logger.warn({ err: (e as Error).message, key: baseKey }, 'rate limit check failed, allowing request');
      return { allowed: true, headers: {} };
    }

    return { allowed: true, headers: tightest?.headers ?? {} };
  }
}

export type { EnforceResult };
export default RateLimitService;
