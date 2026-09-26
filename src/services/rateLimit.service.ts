import type { Request } from 'express';
import getLogger from '../configs/logger';
import type { APIRoute, HttpMethod } from '../types/api';
import DiscordService from '../utils/discordAlerts';
import RedisService from './redis.service';

type RateLimitIdentifierStrategy = 'API_KEY' | 'USER' | 'IP' | 'USER_OR_IP';

interface SlidingWindowLimit {
  perMinute?: number;
  perDay?: number;
  key?: RateLimitIdentifierStrategy;
}

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

const logger = getLogger();

class RateLimitService {
  private static instance: RateLimitService;

  private redisService: RedisService;

  private enabled: boolean;

  private discordService?: DiscordService;

  private trustedIpSet: Set<string>;

  private alertCooldown: Map<string, number> = new Map(); // identifier -> last alert timestamp
  private alertCooldownMs: number = 60000; // 1 minute cooldown between alerts for same identifier

  private slidingWindowScript = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local windowMs = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    local expireSeconds = tonumber(ARGV[4])

    redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
    local current = redis.call('ZCARD', key)

    if current < limit then
      redis.call('ZADD', key, now, now .. '-' .. math.random())
      redis.call('EXPIRE', key, expireSeconds)
      return {1, limit - current - 1}
    else
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      local retryAfter = 1
      if oldest and oldest[2] then
        retryAfter = math.max(1, math.ceil((oldest[2] + windowMs - now) / 1000))
      end
      return {0, 0, retryAfter}
    end
  `;

  private constructor() {
    // Initialize Redis service (singleton - shared across project)
    this.redisService = RedisService.getInstance();

    // Initialize trusted IPs from environment variable
    const trustedIpEnv = process.env.TRUSTED_IPS || '';
    const trustedIps = trustedIpEnv
      .split(',')
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0);
    this.trustedIpSet = new Set(trustedIps);

    // Initialize Discord service if webhook URL is provided
    const webhookUrl =
    process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      this.discordService = new DiscordService(webhookUrl, true);
    }
    
    this.enabled = true;
  }

  public static getInstance(): RateLimitService {
    if (!RateLimitService.instance) {
      RateLimitService.instance = new RateLimitService();
    }
    return RateLimitService.instance;
  }

  public async close(): Promise<void> {
    // Note: Redis connection is managed by RedisService singleton
    // Don't close it here as it may be used by other services
    // The connection will be closed when the application shuts down
  }

  private resolveIdentifier(
    strategy: RateLimitIdentifierStrategy | undefined,
    req: Request,
    userId?: string,
    apiKey?: string
  ): string {
    if (strategy === 'API_KEY' && apiKey) return `apikey:${apiKey}`;
    if (strategy === 'USER' && userId) return `user:${userId}`;
    if (strategy === 'USER_OR_IP') {
      if (userId) return `user:${userId}`;
      return `ip:${this.getClientIp(req)}`;
    }
    if (strategy === 'IP' || !strategy) {
      return `ip:${this.getClientIp(req)}`;
    }
    if (apiKey) return `apikey:${apiKey}`;
    if (userId) return `user:${userId}`;
    return `ip:${this.getClientIp(req)}`;
  }

  private getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded && typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0];
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  private shouldSendAlert(identifier: string): boolean {
    const now = Date.now();
    const lastAlertTime = this.alertCooldown.get(identifier);
    
    if (!lastAlertTime || now - lastAlertTime >= this.alertCooldownMs) {
      this.alertCooldown.set(identifier, now);
      return true;
    }
    return false;
  }

  private async consumeWindow(
    baseKey: string,
    windowMs: number,
    limit: number
  ): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
    if (!this.enabled) {
      return { allowed: true, remaining: limit };
    }
    const redis = this.redisService.getClient();
    if (!redis) {
      throw new Error('Redis client unavailable — cannot enforce rate limit');
    }

    const expireSeconds = Math.ceil(windowMs / 1000);
    const result = (await redis.eval(
      this.slidingWindowScript,
      1,
      baseKey,
      Date.now(),
      windowMs,
      limit,
      expireSeconds
    )) as [number, number, number?];

    return {
      allowed: result[0] === 1,
      remaining: result[1],
      retryAfter: result[2]
    };
  }

  public async enforce({
    serviceName,
    route,
    method,
    req,
    userId,
    apiKey
  }: EnforceParams): Promise<EnforceResult> {
    const rateLimit = route.rateLimit as SlidingWindowLimit | undefined;
    if (!rateLimit || (!rateLimit.perMinute && !rateLimit.perDay)) {
      return { allowed: true, headers: {} };
    }

    // Check if IP is trusted - skip rate limiting for trusted IPs
    const clientIp = this.getClientIp(req);
    if (this.trustedIpSet.has(clientIp)) {
      return { allowed: true, headers: {} };
    }

    const identifier = this.resolveIdentifier(rateLimit.key, req, userId, apiKey);
    const baseKey = `ratelimit:${serviceName}:${method}:${route.path}:${identifier}`;
    const headers: Record<string, string> = {};

    if (!this.enabled) {
      return { allowed: true, headers };
    }

    if (rateLimit.perMinute) {
      const result = await this.consumeWindow(
        `${baseKey}:m`,
        60 * 1000,
        rateLimit.perMinute
      );
      headers['X-RateLimit-Limit-Minute'] = rateLimit.perMinute.toString();
      headers['X-RateLimit-Remaining-Minute'] = Math.max(result.remaining, 0).toString();

      if (!result.allowed) {
        // Send Discord alert only if cooldown has passed (throttle alerts)
        if (this.discordService && this.shouldSendAlert(identifier)) {
          const ip = this.getClientIp(req);
          const userDetails = [
            `**IP Address:** ${ip}`,
            userId && `**User ID:** ${userId}`,
            apiKey && `**API Key:** ${apiKey.substring(0, 10)}...`,
            `**Identifier:** ${identifier}`
          ].filter(Boolean).join('\n');

          const message = `${userDetails}\n**Endpoint:** ${method} ${route.path}\n**Service:** ${serviceName}\n**Limit Type:** Per Minute\n**Limit:** ${rateLimit.perMinute}${result.retryAfter ? `\n**Retry After:** ${result.retryAfter} seconds` : ''}\n**Time:** ${new Date().toISOString()}`;

          this.discordService.sendAlert('⚠️ Rate Limit Exceeded', message).catch((error) => {
            logger.error('Failed to send rate limit alert to Discord:', error);
          });
        }
  
        return {
          allowed: false,
          headers,
          retryAfterSeconds: result.retryAfter ?? 60,
          message: 'Per-minute rate limit exceeded'
        };
      }
    }

    if (rateLimit.perDay) {
      const result = await this.consumeWindow(
        `${baseKey}:d`,
        24 * 60 * 60 * 1000,
        rateLimit.perDay
      );
      headers['X-RateLimit-Limit-Day'] = rateLimit.perDay.toString();
      headers['X-RateLimit-Remaining-Day'] = Math.max(result.remaining, 0).toString();

      if (!result.allowed) {
        // Send Discord alert only if cooldown has passed (throttle alerts)
        if (this.discordService && this.shouldSendAlert(identifier)) {
          const ip = this.getClientIp(req);
          const userDetails = [
            `**IP Address:** ${ip}`,
            userId && `**User ID:** ${userId}`,
            apiKey && `**API Key:** ${apiKey.substring(0, 10)}...`,
            `**Identifier:** ${identifier}`
          ].filter(Boolean).join('\n');

          const message = `${userDetails}\n**Endpoint:** ${method} ${route.path}\n**Service:** ${serviceName}\n**Limit Type:** Per Day\n**Limit:** ${rateLimit.perDay}${result.retryAfter ? `\n**Retry After:** ${result.retryAfter} seconds` : ''}\n**Time:** ${new Date().toISOString()}`;

          this.discordService.sendAlert('⚠️ Rate Limit Exceeded', message).catch((error) => {
            logger.error('Failed to send rate limit alert to Discord:', error);
          });
        }
        
        return {
          allowed: false,
          headers,
          retryAfterSeconds: result.retryAfter ?? 60 * 60,
          message: 'Daily rate limit exceeded'
        };
      }
    }

    return { allowed: true, headers };
  }
}

export type { RateLimitIdentifierStrategy, SlidingWindowLimit, EnforceResult };
export default RateLimitService;

