import type { CacheConfig } from '../types/api';
import getLogger from '../configs/logger';
import RedisService from './redis.service';

const logger = getLogger();

interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  cachedAt: number;
}

class CacheService {
  private static instance: CacheService;
  private redisService: RedisService;

  private static readonly KEY_PREFIX = 'sancus:cache';
  private static readonly LFU_ZSET_PREFIX = 'sancus:cache:lfu:freq';
  private static readonly LFU_MAX_ENTRIES = 1000;

  private constructor() {
    this.redisService = RedisService.getInstance();
  }

  public static getInstance(): CacheService {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
    }
    return CacheService.instance;
  }

  /**
   * Build a Redis cache key based on the cache config's key strategy.
   */
  public buildKey(
    config: CacheConfig,
    path: string,
    query?: string,
    userId?: string
  ): string {
    const keyStrategy = config.key || 'PATH';
    let raw: string;

    switch (keyStrategy) {
      case 'PATH_QUERY':
        raw = query ? `${path}?${query}` : path;
        break;
      case 'PATH_QUERY_USER':
        raw = query ? `${path}?${query}` : path;
        raw = userId ? `${raw}::${userId}` : raw;
        break;
      case 'PATH':
      default:
        raw = path;
        break;
    }

    return `${CacheService.KEY_PREFIX}:${config.strategy}:${raw}`;
  }

  /**
   * Retrieve a cached response.
   * Returns the cached data or null on miss.
   * For SWR: returns { data, stale } where stale=true means background revalidation is needed.
   */
  public async get(
    cacheKey: string,
    config: CacheConfig
  ): Promise<{ data: CachedResponse; stale: boolean } | null> {
    const redis = this.redisService.getClient();
    if (!redis) {
      logger.error('Redis client unavailable — cache GET falling through to backend');
      return null;
    }

    try {
      const raw = await redis.get(cacheKey);
      if (!raw) {
        // Clean up stale ZSET entry if the cache key expired
        if (config.strategy === 'LFU') {
          redis.zrem(CacheService.LFU_ZSET_PREFIX, cacheKey).catch((e) => {
            logger.error(`LFU ZSET cleanup failed (key=${cacheKey}): ${(e as Error).message}`);
          });
        }
        return null;
      }

      const cached: CachedResponse = JSON.parse(raw);

      if (config.strategy === 'LFU') {
        // Increment access frequency
        redis.zincrby(CacheService.LFU_ZSET_PREFIX, 1, cacheKey).catch((e) => {
          logger.error(`LFU frequency increment failed (key=${cacheKey}): ${(e as Error).message}`);
        });
      }

      if (config.strategy === 'SWR') {
        const ttlRemaining = await redis.ttl(cacheKey);
        const isStale = ttlRemaining > 0 && ttlRemaining < config.ttl * 0.25;
        // Check if already revalidating
        if (isStale) {
          const revalidatingKey = `${cacheKey}:_revalidating`;
          const alreadyRevalidating = await redis.get(revalidatingKey);
          if (alreadyRevalidating) {
            return { data: cached, stale: false }; // Someone else is revalidating
          }
        }
        return { data: cached, stale: isStale };
      }

      return { data: cached, stale: false };
    } catch (error: any) {
      logger.error(`Cache GET failed (key=${cacheKey}): ${error.message}`);
      return null;
    }
  }

  /**
   * Store a response in the cache.
   */
  public async set(
    cacheKey: string,
    statusCode: number,
    headers: Record<string, string>,
    body: string,
    config: CacheConfig
  ): Promise<void> {
    const redis = this.redisService.getClient();
    if (!redis) {
      logger.error('Redis client unavailable — cache SET skipped');
      return;
    }

    try {
      const entry: CachedResponse = {
        statusCode,
        headers,
        body,
        cachedAt: Date.now(),
      };

      await redis.set(cacheKey, JSON.stringify(entry), 'EX', config.ttl);

      if (config.strategy === 'LFU') {
        // Initialize frequency score
        await redis.zadd(CacheService.LFU_ZSET_PREFIX, 1, cacheKey);

        // Evict lowest-frequency entries beyond max size
        const zsetSize = await redis.zcard(CacheService.LFU_ZSET_PREFIX);
        if (zsetSize > CacheService.LFU_MAX_ENTRIES) {
          const excess = zsetSize - CacheService.LFU_MAX_ENTRIES;
          // Get the lowest-frequency keys to evict
          const evictKeys = await redis.zrange(CacheService.LFU_ZSET_PREFIX, 0, excess - 1);
          if (evictKeys.length > 0) {
            // Delete cached responses and remove from ZSET
            await redis.del(...evictKeys);
            await redis.zrem(CacheService.LFU_ZSET_PREFIX, ...evictKeys);
            logger.info(`LFU eviction: removed ${evictKeys.length} low-frequency entries`);
          }
        }
      }

      // Clear revalidating flag for SWR
      if (config.strategy === 'SWR') {
        const revalidatingKey = `${cacheKey}:_revalidating`;
        await redis.del(revalidatingKey);
      }

      logger.info(`Cache SET (key=${cacheKey}, ttl=${config.ttl}s, strategy=${config.strategy})`);
    } catch (error: any) {
      logger.error(`Cache SET failed (key=${cacheKey}): ${error.message}`);
    }
  }

  /**
   * Build browser cache headers. Only emits headers if browserTtl is configured.
   * Returns empty object when browserTtl is not set (no browser caching).
   */
  public buildResponseHeaders(
    config: CacheConfig,
    cachedAt?: number
  ): Record<string, string> {
    if (!config.browserTtl) return {};

    const headers: Record<string, string> = {};
    const isPrivate = config.key === 'PATH_QUERY_USER';
    const scope = isPrivate ? 'private' : 'public';

    if (config.strategy === 'SWR') {
      const swr = Math.floor(config.browserTtl * 0.25);
      headers['Cache-Control'] = `${scope}, max-age=${config.browserTtl}, stale-while-revalidate=${swr}`;
    } else {
      headers['Cache-Control'] = `${scope}, max-age=${config.browserTtl}`;
    }

    if (cachedAt) {
      const ageSeconds = Math.floor((Date.now() - cachedAt) / 1000);
      headers['Age'] = Math.max(0, ageSeconds).toString();
      headers['ETag'] = `W/"${cachedAt.toString(36)}"`;
    }

    if (isPrivate) {
      headers['Vary'] = 'Authorization';
    }

    return headers;
  }

  /**
   * Mark a SWR cache key as currently revalidating (60s lock).
   */
  public async markRevalidating(cacheKey: string): Promise<void> {
    const redis = this.redisService.getClient();
    if (!redis) {
      logger.error('Redis client unavailable — markRevalidating skipped');
      return;
    }

    try {
      const revalidatingKey = `${cacheKey}:_revalidating`;
      await redis.set(revalidatingKey, '1', 'EX', 60);
    } catch (error: any) {
      logger.error(`Cache markRevalidating failed (key=${cacheKey}): ${error.message}`);
    }
  }
}

export type { CachedResponse };
export default CacheService;
