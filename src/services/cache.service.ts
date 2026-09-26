import { createHash } from 'crypto';
import type { Request } from 'express';
import type { IncomingHttpHeaders } from 'http';
import getLogger from '../configs/logger';
import type { CacheConfig } from '../types/api';
import RedisService from './redis.service';

export type CacheStatus = 'HIT' | 'MISS' | 'STALE' | 'BYPASS';
export const CACHE_STATUS_HEADER = 'X-Cache-Status';
export const CACHE_KEY_HEADER = 'X-Cache-Key';

export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string; // base64 — bodies may be gzip or binary, never assume utf-8
  cachedAt: number;
  etag: string;
}

const logger = getLogger();
const DEFAULT_STATUS_CODES = [200, 301, 404];
const CACHEABLE_METHODS = new Set(['GET', 'HEAD']);

class CacheService {
  private static instance: CacheService;
  private readonly redisService = RedisService.getInstance();

  private static readonly KEY_PREFIX = 'sancus:cache';
  private static readonly LFU_ZSET_PREFIX = 'sancus:cache:lfu:freq';
  private static readonly LFU_MAX_ENTRIES = Number(process.env.CACHE_LFU_MAX_ENTRIES) || 1000;

  private constructor() {}

  public static getInstance(): CacheService {
    if (!CacheService.instance) CacheService.instance = new CacheService();
    return CacheService.instance;
  }

  /** Key = prefix:service:strategy:<path[?query][::user][|vary...]>. Service first so a purge can SCAN one prefix. */
  public buildKey(
    config: CacheConfig,
    service: string,
    path: string,
    query?: string,
    userId?: string,
    vary?: Record<string, string | undefined>,
    encoding?: string
  ): string {
    let raw = path;
    if (config.key === 'PATH_QUERY' || config.key === 'PATH_QUERY_USER') raw = query ? `${path}?${query}` : path;
    if (config.key === 'PATH_QUERY_USER' && userId) raw = `${raw}::${userId}`;
    if (vary) raw += '|' + Object.entries(vary).map(([k, v]) => `${k.toLowerCase()}=${v ?? ''}`).join('|');
    if (encoding) raw += `|enc=${encoding}`;
    return `${CacheService.KEY_PREFIX}:${service}:${config.strategy}:${raw}`;
  }

  /**
   * Which encoding this client can take, reduced to one of three buckets. It is part of the cache
   * key, so a client that cannot unzip is never sent a gzipped cached body.
   */
  public static encodingBucket(req: Request): 'br' | 'gzip' | 'identity' {
    const ae = String(req.headers['accept-encoding'] ?? '').toLowerCase();
    if (/(^|[\s,])br(?![\w-])(?!;q=0(\.0+)?(\s|,|$))/.test(ae)) return 'br';
    if (/(^|[\s,])(x-)?gzip(?![\w-])(?!;q=0(\.0+)?(\s|,|$))/.test(ae)) return 'gzip';
    return 'identity';
  }

  /** Short digest exposed as X-Cache-Key so operators can correlate without leaking the raw key. */
  public static shortKey(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  public isCacheableRequest(req: Request): boolean {
    if (!CACHEABLE_METHODS.has(req.method)) return false;
    const cc = String(req.headers['cache-control'] ?? '');
    if (/no-cache|no-store/i.test(cc)) return false;
    if (String(req.headers.pragma ?? '').includes('no-cache')) return false;
    return true;
  }

  /** Honour the upstream: only configured statuses, and never no-store / private / Set-Cookie responses. */
  public isCacheableResponse(statusCode: number, headers: IncomingHttpHeaders, config: CacheConfig): boolean {
    if (!(config.statusCodes ?? DEFAULT_STATUS_CODES).includes(statusCode)) return false;
    if (/no-store|private/i.test(String(headers['cache-control'] ?? ''))) return false;
    if (headers['set-cookie']) return false;
    return true;
  }

  /** Returns cached data, plus stale=true for SWR entries that need a background refresh. */
  public async get(cacheKey: string, config: CacheConfig): Promise<{ data: CachedResponse; stale: boolean } | null> {
    const redis = this.redisService.getClient();
    if (!redis) return null;

    try {
      const raw = await redis.get(cacheKey);
      if (!raw) {
        if (config.strategy === 'LFU') redis.zrem(CacheService.LFU_ZSET_PREFIX, cacheKey).catch(() => {});
        return null;
      }
      const cached: CachedResponse = JSON.parse(raw);

      if (config.strategy === 'LFU') redis.zincrby(CacheService.LFU_ZSET_PREFIX, 1, cacheKey).catch(() => {});

      if (config.strategy === 'SWR') {
        const ttlRemainingMs = await redis.pttl(cacheKey);
        const isStale = ttlRemainingMs > 0 && ttlRemainingMs < config.ttl * 1000 * 0.25;
        if (isStale && (await redis.get(`${cacheKey}:_revalidating`))) return { data: cached, stale: false };
        return { data: cached, stale: isStale };
      }
      return { data: cached, stale: false };
    } catch (error: any) {
      logger.error({ err: error.message, cacheKey }, 'cache GET failed');
      return null;
    }
  }

  public async set(cacheKey: string, statusCode: number, headers: Record<string, string>, body: Buffer, config: CacheConfig): Promise<void> {
    const redis = this.redisService.getClient();
    if (!redis) return;

    try {
      const entry: CachedResponse = {
        statusCode,
        headers,
        body: body.toString('base64'),
        cachedAt: Date.now(),
        etag: `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`,
      };
      await redis.set(cacheKey, JSON.stringify(entry), 'EX', config.ttl);

      if (config.strategy === 'LFU') {
        await redis.zadd(CacheService.LFU_ZSET_PREFIX, 1, cacheKey);
        const size = await redis.zcard(CacheService.LFU_ZSET_PREFIX);
        if (size > CacheService.LFU_MAX_ENTRIES) {
          const evict = await redis.zrange(CacheService.LFU_ZSET_PREFIX, 0, size - CacheService.LFU_MAX_ENTRIES - 1);
          if (evict.length) {
            await redis.del(...evict);
            await redis.zrem(CacheService.LFU_ZSET_PREFIX, ...evict);
          }
        }
      }
      if (config.strategy === 'SWR') await redis.del(`${cacheKey}:_revalidating`);
    } catch (error: any) {
      logger.error({ err: error.message, cacheKey }, 'cache SET failed');
    }
  }

  /** Headers for a response served from (or through) the cache. */
  public responseHeaders(config: CacheConfig, cacheKey: string, status: CacheStatus, entry?: CachedResponse): Record<string, string> {
    const headers: Record<string, string> = {
      [CACHE_STATUS_HEADER]: status,
      [CACHE_KEY_HEADER]: CacheService.shortKey(cacheKey),
    };
    if (entry) {
      headers.Age = String(Math.max(0, Math.floor((Date.now() - entry.cachedAt) / 1000)));
      headers.ETag = entry.etag;
    }
    if (config.browserTtl) {
      const scope = config.key === 'PATH_QUERY_USER' ? 'private' : 'public';
      headers['Cache-Control'] =
        config.strategy === 'SWR'
          ? `${scope}, max-age=${config.browserTtl}, stale-while-revalidate=${Math.floor(config.browserTtl * 0.25)}`
          : `${scope}, max-age=${config.browserTtl}`;
    }
    const vary = [...(config.key === 'PATH_QUERY_USER' ? ['Authorization'] : []), ...(config.varyHeaders ?? []), 'Accept-Encoding'];
    if (vary.length) headers.Vary = vary.join(', ');
    return headers;
  }

  /** Mark a SWR key as being revalidated (60s lock) so only one request refreshes it. */
  public async markRevalidating(cacheKey: string): Promise<void> {
    const redis = this.redisService.getClient();
    if (!redis) return;
    await redis.set(`${cacheKey}:_revalidating`, '1', 'EX', 60).catch(() => {});
  }

  /** DELETE /cache/:service — drop every cached response for one service. */
  public async purgeService(service: string): Promise<number> {
    const redis = this.redisService.getClient();
    if (!redis) throw new Error('Redis client unavailable');
    let cursor = '0';
    let purged = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${CacheService.KEY_PREFIX}:${service}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) {
        purged += await redis.del(...keys);
        await redis.zrem(CacheService.LFU_ZSET_PREFIX, ...keys).catch(() => {});
      }
    } while (cursor !== '0');
    return purged;
  }
}

export default CacheService;
