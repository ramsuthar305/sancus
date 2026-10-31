import { createHash } from 'crypto';
import type { Request } from 'express';
import getLogger from '../configs/logger';
import { rateLimited } from '../configs/metrics';
import type { APIRoute, HttpMethod, RateLimitConfig } from '../types/api';
import AlertService from '../utils/alerts';
import { getClientIp } from '../utils/clientIp';
import { BlockCache } from '../utils/blockCache';
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

interface LocalBlock {
  until: number;    // epoch ms
  limit: number;    // for the rate-limit headers on a cached rejection
  windowS: number;
  message: string;
}

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
  private readonly blocks = new BlockCache<LocalBlock>();

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

  /** Forget every per-worker block (tests, and a config reload that relaxes limits). */
  public clearBlocks(): void {
    this.blocks.clear();
  }

  private rejected(rl: RateLimitConfig, block: LocalBlock, now: number): EnforceResult {
    const retryAfter = Math.max(1, Math.ceil((block.until - now) / 1000));
    return {
      allowed: false,
      headers: rl.hideHeaders ? {} : rateLimitHeaders(block.limit, 0, retryAfter, block.windowS),
      retryAfterSeconds: retryAfter,
      message: block.message,
    };
  }

  /**
   * Enforce the route's rateLimit block. Day window is checked before minute so a day
   * rejection never burns a minute token. Fails open (allows) when Redis is unreachable.
   *
   * A caller who was rejected is remembered in this worker until their Retry-After (or the
   * route's blockFor) runs out, and answered from memory without touching Redis. With
   * `blockFor`, the block is also written to Redis so every pod enforces it.
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
    const tightest = windows[windows.length - 1];

    const now = Date.now();
    const known = this.blocks.get(baseKey, now);
    if (known) {
      rateLimited.inc({ service: serviceName, route: route.path, scope: 'route' });
      return this.rejected(rl, known, now);
    }

    const blockKey = `${baseKey}:blocked`;
    const blockMs = (rl.blockFor ?? 0) * 1000;
    let best: { headers: Record<string, string>; remaining: number } | undefined;
    try {
      if (blockMs) {
        // Blocked by another pod? Only routes with blockFor pay for this extra round trip.
        const redis = this.redisService.getClient();
        if (!redis) throw new Error('Redis client unavailable');
        const pttl = await redis.pttl(blockKey);
        if (pttl > 0) {
          const block = { until: now + pttl, limit: tightest.limit, windowS: tightest.ms / 1000, message: 'Temporarily blocked for exceeding the rate limit' };
          this.blocks.set(baseKey, block);
          rateLimited.inc({ service: serviceName, route: route.path, scope: 'route' });
          return this.rejected(rl, block, now);
        }
      }

      for (const w of windows) {
        // `:sw` = sliding-window counter hash. New names on purpose: the sorted-set keys of the old
        // log would answer WRONGTYPE (and the limit fail open) until they expired, up to a day.
        const result = await this.consumeWindow(`${baseKey}:${w.name}:sw`, w.ms, w.limit);
        const headers = rl.hideHeaders ? {} : rateLimitHeaders(w.limit, result.remaining, result.reset, w.ms / 1000);
        if (!result.allowed) {
          rateLimited.inc({ service: serviceName, route: route.path, scope: 'route' });
          let until = now + result.retryAfter * 1000;
          if (blockMs) {
            // NX: retries during the block never extend it.
            await this.redisService.getClient()?.set(blockKey, '1', 'PX', blockMs, 'NX');
            until = Math.max(until, now + blockMs);
          }
          const message = w.name === 'd' ? 'Daily rate limit exceeded' : 'Per-minute rate limit exceeded';
          this.blocks.set(baseKey, { until, limit: w.limit, windowS: w.ms / 1000, message });
          const retryAfter = Math.ceil((until - now) / 1000);
          this.alertService.alert(
            `ratelimit:${identifier}`,
            '⚠️ Rate Limit Exceeded',
            `**Identifier:** ${identifier}\n**Endpoint:** ${method} ${route.path}\n**Service:** ${serviceName}\n**Window:** ${w.name === 'd' ? 'day' : 'minute'} (limit ${w.limit})\n**Retry After:** ${retryAfter}s${blockMs ? ` (blocked for ${rl.blockFor}s)` : ''}`
          );
          return {
            allowed: false,
            headers: rl.hideHeaders ? {} : rateLimitHeaders(w.limit, 0, retryAfter, w.ms / 1000),
            retryAfterSeconds: retryAfter,
            message,
          };
        }
        if (!best || result.remaining < best.remaining) best = { headers, remaining: result.remaining };
      }
    } catch (e) {
      // ponytail: fail open — a Redis outage must not take the API down with it
      logger.warn({ err: (e as Error).message, key: baseKey }, 'rate limit check failed, allowing request');
      return { allowed: true, headers: {} };
    }

    return { allowed: true, headers: best?.headers ?? {} };
  }
}

export type { EnforceResult };
export default RateLimitService;
