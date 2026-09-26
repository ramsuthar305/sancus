/**
 * Redis Singleton Service
 * 
 * Provides a shared Redis connection with connection pooling for use across the project.
 * Uses singleton pattern to ensure only one connection pool is created.
 * 
 * Usage:
 *   const redis = RedisService.getInstance();
 *   await redis.set('key', 'value');
 *   const value = await redis.get('key');
 */

import Redis from 'ioredis';
import getLogger from '../configs/logger';

const logger = getLogger();

class RedisService {
  private static instance: RedisService;
  private redis?: Redis;
  private isConnecting: boolean = false;

  private constructor() {
    // Private constructor to enforce singleton
  }

  /**
   * Get the singleton instance of RedisService
   */
  public static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  /**
   * Get the Redis client instance
   * Creates connection if not already connected
   */
  public getClient(): Redis | undefined {
    if (!this.redis && !this.isConnecting) {
      this.initialize();
    }
    return this.redis;
  }

  /**
   * Initialize Redis connection and wait for it to be ready
   * Call this at server startup to ensure connection pool is ready
   */
  public async initializeAndWait(): Promise<void> {
    if (this.redis) {
      // Already initialized, check if connected
      try {
        await this.redis.ping();
        return;
      } catch (error) {
        // Connection exists but not ready, wait for it
      }
    }

    if (!this.redis && !this.isConnecting) {
      this.initialize();
    }

    // Wait for connection to be ready (with timeout)
    return new Promise((resolve, reject) => {
      if (!this.redis) {
        reject(new Error('Redis client not initialized'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Redis connection timeout'));
      }, 10000); // 10 second timeout

      const onReady = () => {
        clearTimeout(timeout);
        this.redis?.removeListener('error', onError);
        resolve();
      };

      const onError = (err: Error) => {
        clearTimeout(timeout);
        this.redis?.removeListener('ready', onReady);
        reject(err);
      };

      if (this.redis.status === 'ready') {
        clearTimeout(timeout);
        resolve();
      } else {
        this.redis.once('ready', onReady);
        this.redis.once('error', onError);
      }
    });
  }

  /**
   * Initialize Redis connection with connection pooling
   */
  private initialize(): void {
    if (this.redis || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

    if (!process.env.REDIS_URL) {
      logger.info(`REDIS_URL not set. Falling back to default ${redisUrl}`);
    }

    // Create Redis connection with connection pooling
    // ioredis automatically handles connection pooling
    this.redis = new Redis(redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
      retryStrategy: (attempt) => (attempt > 3 ? null : attempt * 50),
      lazyConnect: true,
      // Connection pool settings
      keepAlive: 30000, // Keep connections alive
      connectTimeout: 10000, // Connection timeout
      // Enable connection pooling (default behavior in ioredis)
    });

    this.redis.on('error', (err) => {
      logger.error(`Redis client error: ${err.message}`);
    });

    this.redis.on('connect', () => {
      logger.info('Redis client connected');
      this.isConnecting = false;
    });

    this.redis.on('ready', () => {
      logger.info('Redis client ready');
      this.isConnecting = false;
    });

    this.redis.on('close', () => {
      logger.warn('Redis client connection closed');
      this.isConnecting = false;
    });

    // Attempt to connect
    this.redis.connect().catch((err) => {
      logger.error(`Failed to connect to Redis: ${err.message}`);
      this.isConnecting = false;
    });
  }

  /**
   * Check if Redis is available
   */
  public async isAvailable(): Promise<boolean> {
    if (!this.redis) {
      return false;
    }

    try {
      await this.redis.ping();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Close Redis connection
   */
  public async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = undefined;
      this.isConnecting = false;
      logger.info('Redis connection closed');
    }
  }

  /**
   * Get Redis client directly (for advanced usage)
   * Use getClient() for most cases
   */
  public getRedisClient(): Redis | undefined {
    return this.getClient();
  }
}

export default RedisService;

