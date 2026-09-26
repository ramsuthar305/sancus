import type { Request } from 'express';
import getLogger from '../configs/logger';
import { rateLimited } from '../configs/metrics';
import type { APIRoute, HttpMethod, RateLimitConfig } from '../types/api';
import AlertService from '../utils/alerts';
import { getClientIp } from '../utils/clientIp';
import { rateLimitHeaders } from '../utils/rateLimitHeaders';
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

// Sliding-window log in a sorted set. Returns {allowed, remaining, retryAfter, reset} in seconds.
const SLIDING_WINDOW_SCRIPT = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])

  redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
  local current = redis.call('ZCARD', key)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset = math.ceil(windowMs / 1000)
  if oldest and oldest[2] then
    reset = math.max(1, math.ceil((tonumber(oldest[2]) + windowMs - now) / 1000))
  end

  if current < limit then
    redis.call('ZADD', key, now, now .. '-' .. math.random())
    redis.call('PEXPIRE', key, windowMs)
    return {1, limit - current - 1, 0, reset}
  end
  return {0, 0, reset, reset}
`;

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
      case 'API_KEY': return apiKey ? `apikey:${apiKey}` : ip;
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
    const r = (await redis.eval(SLIDING_WINDOW_SCRIPT, 1, key, Date.now(), windowMs, limit)) as number[];
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
        const result = await this.consumeWindow(`${baseKey}:${w.name}`, w.ms, w.limit);
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
