import { NextFunction, Request, Response } from 'express';
import AlertService from '../utils/alerts';
import getLogger from '../configs/logger';
import RedisService from '../services/redis.service';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface BurstTracker {
  violations: number[];
  lastAlertTime: number;
}

interface IPRateLimiterOptions {
  capacity?: number;
  refillRatePerSecond?: number;
  cleanupIntervalMs?: number;
  trustedIps?: string[];
  burstAlertThreshold?: number; // Number of violations in burst window
  burstWindowMs?: number; // Time window for burst detection
  alertCooldownMs?: number; // Cooldown between alerts for same IP
  blockDurationMs?: number; // Duration to block IP when DDoS detected (default: 1 hour)
}

const logger = getLogger();

class IPRateLimiter {
  private redisService: RedisService;

  // Lua script for atomic token bucket operations
  private tokenBucketScript = `
    local bucketKey = KEYS[1]
    local now = tonumber(ARGV[1])
    local capacity = tonumber(ARGV[2])
    local refillRate = tonumber(ARGV[3])
    local consumeTokens = tonumber(ARGV[4])
    local ttl = tonumber(ARGV[5])
    
    local bucket = redis.call('HMGET', bucketKey, 'tokens', 'lastRefill')
    local tokens = tonumber(bucket[1]) or capacity
    local lastRefill = tonumber(bucket[2]) or now
    
    -- Refill tokens based on time elapsed
    local secondsSinceLastRefill = (now - lastRefill) / 1000
    local tokensToAdd = secondsSinceLastRefill * refillRate
    tokens = math.min(capacity, tokens + tokensToAdd)
    
    -- Consume tokens if requested
    if consumeTokens > 0 then
      tokens = tokens - consumeTokens
    end
    
    -- Update bucket
    redis.call('HMSET', bucketKey, 'tokens', tokens, 'lastRefill', now)
    redis.call('EXPIRE', bucketKey, ttl)
    
    return {tokens, now}
  `;

  // Lua script for atomic alert cooldown check and update
  // Returns 1 if alert should be sent, 0 if cooldown is active
  private alertCooldownScript = `
    local metaKey = KEYS[1]
    local now = tonumber(ARGV[1])
    local cooldownMs = tonumber(ARGV[2])
    local ttl = tonumber(ARGV[3])
    
    local lastAlertTimeStr = redis.call('HGET', metaKey, 'lastAlertTime')
    local lastAlertTime = lastAlertTimeStr and tonumber(lastAlertTimeStr) or 0
    local timeSinceLastAlert = now - lastAlertTime
    
    -- Check if cooldown has passed
    if timeSinceLastAlert >= cooldownMs then
      -- Atomically update lastAlertTime
      redis.call('HSET', metaKey, 'lastAlertTime', now)
      redis.call('EXPIRE', metaKey, ttl)
      return 1
    else
      return 0
    end
  `;

  private capacity: number;

  private refillRatePerSecond: number;

  private cleanupIntervalMs: number;

  private cleanupTimer: NodeJS.Timeout;

  private trustedIpSet: Set<string>;

  private alertService = AlertService.getInstance();

  private burstAlertThreshold: number;

  private burstWindowMs: number;

  private alertCooldownMs: number;

  private blockDurationMs: number;

  constructor(options: IPRateLimiterOptions = {}) {
    this.capacity = options.capacity ?? Number(process.env.IP_RATE_LIMIT_CAPACITY ?? 200);
    this.refillRatePerSecond =
      options.refillRatePerSecond ?? Number(process.env.IP_RATE_LIMIT_REFILL_RATE ?? 5);
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 5 * 60 * 1000;
    this.burstAlertThreshold = options.burstAlertThreshold ?? 1;
    this.burstWindowMs = options.burstWindowMs ?? 60000; // 1 minute
    this.alertCooldownMs = options.alertCooldownMs ?? 60000; // 5 minutes
    this.blockDurationMs = options.blockDurationMs ?? 60 * 60 * 1000; // 1 hour

    const trustedIpEnv = process.env.TRUSTED_IPS || '';
    const trustedIpsFromEnv = trustedIpEnv
      .split(',')
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0);
    const mergedTrustedIps = options.trustedIps
      ? [...options.trustedIps, ...trustedIpsFromEnv]
      : trustedIpsFromEnv;
    this.trustedIpSet = new Set(mergedTrustedIps);

    // Initialize Redis service (singleton)
    this.redisService = RedisService.getInstance();

    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
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

  private async getOrCreateBucket(ip: string): Promise<{ tokens: number; lastRefill: number }> {
    const redis = this.redisService.getClient();
    if (!redis) {
      // Fallback to in-memory if Redis unavailable
      return { tokens: this.capacity, lastRefill: Date.now() };
    }

    try {
      const bucketKey = `ipratelimit:bucket:${ip}`;
      const bucket = await redis.hmget(bucketKey, 'tokens', 'lastRefill');
      
      if (bucket[0] && bucket[1]) {
        // Bucket exists
        return {
          tokens: parseFloat(bucket[0]),
          lastRefill: parseFloat(bucket[1])
        };
      } else {
        // Create new bucket
        const now = Date.now();
        await redis.hmset(bucketKey, 'tokens', this.capacity, 'lastRefill', now);
        await redis.expire(bucketKey, 600); // 10 minutes TTL
        return { tokens: this.capacity, lastRefill: now };
      }
    } catch (error) {
      logger.error(`Failed to get/create bucket in Redis: ${error}`);
      return { tokens: this.capacity, lastRefill: Date.now() };
    }
  }

  private async refillAndConsumeBucket(ip: string, consume: boolean = false): Promise<{ tokens: number; lastRefill: number }> {
    const redis = this.redisService.getClient();
    if (!redis) {
      // Fallback if Redis unavailable
      return { tokens: this.capacity, lastRefill: Date.now() };
    }

    try {
      const bucketKey = `ipratelimit:bucket:${ip}`;
      const now = Date.now();
      const ttl = 600; // 10 minutes

      const result = (await redis.eval(
        this.tokenBucketScript,
        1,
        bucketKey,
        now,
        this.capacity,
        this.refillRatePerSecond,
        consume ? 1 : 0,
        ttl
      )) as [number, number];

      return {
        tokens: result[0],
        lastRefill: result[1]
      };
    } catch (error) {
      logger.error(`Failed to refill/consume bucket in Redis: ${error}`);
      return { tokens: this.capacity, lastRefill: Date.now() };
    }
  }

  private cleanup(): void {
    // Note: Redis handles expiration automatically via TTL, no manual cleanup needed
    // Buckets and burst trackers have TTL set, so they auto-expire
  }

  private async isBlocked(ip: string): Promise<boolean> {
    const redis = this.redisService.getClient();
    if (!redis) {
      // If Redis is unavailable, fail open (don't block)
      return false;
    }

    try {
      const key = `blocked:ip:${ip}`;
      const exists = await redis.exists(key);
      return exists === 1;
    } catch (error) {
      logger.error(`Failed to check blocked IP in Redis: ${error}`);
      // Fail open - don't block if Redis check fails
      return false;
    }
  }

  private async blockIp(ip: string): Promise<void> {
    const redis = this.redisService.getClient();
    if (!redis) {
      logger.warn('Redis unavailable, cannot block IP');
      return;
    }

    try {
      const key = `blocked:ip:${ip}`;
      const ttlSeconds = Math.ceil(this.blockDurationMs / 1000);
      
      // Store blocked IP with TTL (Redis will auto-expire)
      await redis.setex(key, ttlSeconds, Date.now().toString());
      
      // Also clear their bucket and burst tracker since they're blocked
      const bucketKey = `ipratelimit:bucket:${ip}`;
      const violationsKey = `ipratelimit:burst:${ip}:violations`;
      const metaKey = `ipratelimit:burst:${ip}:meta`;
      await Promise.all([
        redis.del(bucketKey).catch(() => {}),
        redis.del(violationsKey).catch(() => {}),
        redis.del(metaKey).catch(() => {})
      ]);
    } catch (error) {
      logger.error(`Failed to block IP in Redis: ${error}`);
    }
  }

  private async trackBurst(ip: string): Promise<void> {
    const redis = this.redisService.getClient();
    if (!redis) {
      // If Redis unavailable, skip burst tracking
      return;
    }

    try {
      const now = Date.now();
      const violationsKey = `ipratelimit:burst:${ip}:violations`;
      const metaKey = `ipratelimit:burst:${ip}:meta`;

      // Add current violation timestamp to sorted set
      await redis.zadd(violationsKey, now, `${now}-${Math.random()}`);
      
      // Remove violations outside the burst window
      const windowStart = now - this.burstWindowMs;
      await redis.zremrangebyscore(violationsKey, 0, windowStart);

      // Get violation count
      const violationCount = await redis.zcard(violationsKey);

      // Send alert on first violation (even if threshold not met yet)
      // Use atomic Lua script to ensure only one alert is sent even if 500 violations occur simultaneously
      if (violationCount >= 1) {
        // Atomically check cooldown and update lastAlertTime
        // This prevents race conditions when multiple violations occur at the same time
        const shouldSendAlert = (await redis.eval(
          this.alertCooldownScript,
          1,
          metaKey,
          now,
          this.alertCooldownMs,
          600 // 10 minutes TTL
        )) as number;

        if (shouldSendAlert === 1) {
          await redis.expire(violationsKey, 600); // 10 minutes TTL

          // Check if threshold is exceeded for blocking
          const shouldBlock = violationCount >= this.burstAlertThreshold;
          
          if (shouldBlock) {
            // Block the IP for DDoS protection
            this.blockIp(ip).catch((err) => {
              logger.error(`Failed to block IP ${ip}: ${err}`);
            });
          }

          // Send alert (blocked or not) - only one alert will be sent even for 500 requests
          this.sendBurstAlert(ip, violationCount, shouldBlock);
        }
      }
    } catch (error) {
      logger.error(`Failed to track burst in Redis: ${error}`);
    }
  }

  private async sendBurstAlert(
    ip: string,
    violationCount: number,
    isBlocked: boolean = false
  ): Promise<void> {
    const heading = isBlocked
      ? '🚨 DDoS Detected - IP Blocked'
      : '🚨 Rate Limit Burst Detected';
    const blockDurationMinutes = Math.round(this.blockDurationMs / 60000);
    const message = `**IP Address:** ${ip}\n**Violations:** ${violationCount} in the last ${Math.round(this.burstWindowMs / 1000)} seconds\n**Rate Limit:** ${this.capacity} requests, ${this.refillRatePerSecond} tokens/sec\n${isBlocked ? `**Action:** IP blocked for ${blockDurationMinutes} minutes\n` : ''}**Time:** ${new Date().toISOString()}`;

    this.alertService.alert(`ip-burst:`, heading, message);
    
  }

  public middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const clientIp = this.getClientIp(req);
      
      // Check if IP is trusted
      if (this.trustedIpSet.has(clientIp)) {
        return next();
      }
      
      // Check if IP is blocked (async Redis check)
      const isBlocked = await this.isBlocked(clientIp);
      if (isBlocked) {
        const redis = this.redisService.getClient();
        let blockedUntil: string | undefined;
        
        // Try to get expiration time from Redis
        if (redis) {
          try {
            const key = `blocked:ip:${clientIp}`;
            const ttl = await redis.ttl(key);
            if (ttl > 0) {
              blockedUntil = new Date(Date.now() + ttl * 1000).toISOString();
            }
          } catch (error) {
            // Ignore error, just don't include blockedUntil
          }
        }
        
        res.status(403).json({
          error: 'Forbidden',
          message: 'Your IP address has been temporarily blocked due to suspicious activity. Please try again later.',
          ...(blockedUntil && { blockedUntil })
        });
        return;
      }
      
      // Get or create bucket and refill tokens
      const bucket = await this.refillAndConsumeBucket(clientIp, false);

      if (bucket.tokens >= 1) {
        // Consume one token
        const updatedBucket = await this.refillAndConsumeBucket(clientIp, true);
        res.setHeader('X-IPRateLimit-Limit', this.capacity.toString());
        res.setHeader('X-IPRateLimit-Remaining', Math.floor(updatedBucket.tokens).toString());
        next();
        return;
      }

      // Track burst violation
      await this.trackBurst(clientIp);

      const secondsUntilToken = Math.ceil((1 - bucket.tokens) / this.refillRatePerSecond);
      res.setHeader('X-IPRateLimit-Limit', this.capacity.toString());
      res.setHeader('X-IPRateLimit-Remaining', '0');
      res.setHeader('Retry-After', secondsUntilToken.toString());
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'IP rate limit exceeded. Please try again later.',
        retryAfter: secondsUntilToken
      });
    };
  }

  public destroy(): void {
    clearInterval(this.cleanupTimer);
    // Note: Redis handles cleanup automatically via TTL, no need to clear manually
  }
}

export default IPRateLimiter;

