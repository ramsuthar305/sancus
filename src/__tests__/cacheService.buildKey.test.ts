import CacheService from '../services/cache.service';
import type { CacheConfig } from '../types/api';

// Mock logger
jest.mock('../configs/logger', () => () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock RedisService to avoid real connections
jest.mock('../services/redis.service', () => {
  return {
    __esModule: true,
    default: {
      getInstance: () => ({
        getClient: () => null,
      }),
    },
  };
});

describe('CacheService.buildKey()', () => {
  let cacheService: CacheService;

  beforeAll(() => {
    cacheService = CacheService.getInstance();
  });

  it('should use raw path as key for PATH strategy', () => {
    const config: CacheConfig = { strategy: 'LRU', ttl: 3600, key: 'PATH' };
    const key = cacheService.buildKey(config, '/api/users/');
    expect(key).toBe('sancus:cache:LRU:/api/users/');
  });

  it('should use raw path+query as key for PATH_QUERY strategy', () => {
    const config: CacheConfig = { strategy: 'LFU', ttl: 3600, key: 'PATH_QUERY' };
    const key = cacheService.buildKey(config, '/api/search/', 'q=hello&page=1');
    expect(key).toBe('sancus:cache:LFU:/api/search/?q=hello&page=1');
  });

  it('should use path only when no query for PATH_QUERY strategy', () => {
    const config: CacheConfig = { strategy: 'LFU', ttl: 3600, key: 'PATH_QUERY' };
    const key = cacheService.buildKey(config, '/api/search/');
    expect(key).toBe('sancus:cache:LFU:/api/search/');
  });

  it('should include userId for PATH_QUERY_USER strategy', () => {
    const config: CacheConfig = { strategy: 'SWR', ttl: 3600, key: 'PATH_QUERY_USER' };
    const key = cacheService.buildKey(config, '/api/data/', 'q=test', 'user123');
    expect(key).toBe('sancus:cache:SWR:/api/data/?q=test::user123');
  });

  it('should omit userId when not provided for PATH_QUERY_USER strategy', () => {
    const config: CacheConfig = { strategy: 'SWR', ttl: 3600, key: 'PATH_QUERY_USER' };
    const key = cacheService.buildKey(config, '/api/data/', 'q=test');
    expect(key).toBe('sancus:cache:SWR:/api/data/?q=test');
  });

  it('should default to PATH strategy when key is not specified', () => {
    const config: CacheConfig = { strategy: 'LRU', ttl: 3600 };
    const key = cacheService.buildKey(config, '/api/default/');
    expect(key).toBe('sancus:cache:LRU:/api/default/');
  });

  it('should NOT contain hex hash characters (no SHA-256)', () => {
    const config: CacheConfig = { strategy: 'LRU', ttl: 3600, key: 'PATH' };
    const key = cacheService.buildKey(config, '/api/users/');
    // Old format was sancus:cache:LRU:<16-char-hex-hash>
    // New format includes the readable path
    expect(key).toContain('/api/users/');
    // Should not be a short hex hash
    expect(key).not.toMatch(/^sancus:cache:LRU:[0-9a-f]{16}$/);
  });

  it('should produce different keys for different paths', () => {
    const config: CacheConfig = { strategy: 'LRU', ttl: 3600, key: 'PATH' };
    const key1 = cacheService.buildKey(config, '/api/users/');
    const key2 = cacheService.buildKey(config, '/api/trips/');
    expect(key1).not.toBe(key2);
  });

  it('should produce different keys for different query strings', () => {
    const config: CacheConfig = { strategy: 'LFU', ttl: 3600, key: 'PATH_QUERY' };
    const key1 = cacheService.buildKey(config, '/api/search/', 'q=hello');
    const key2 = cacheService.buildKey(config, '/api/search/', 'q=world');
    expect(key1).not.toBe(key2);
  });

  it('should produce different keys for different users', () => {
    const config: CacheConfig = { strategy: 'SWR', ttl: 3600, key: 'PATH_QUERY_USER' };
    const key1 = cacheService.buildKey(config, '/api/data/', undefined, 'user1');
    const key2 = cacheService.buildKey(config, '/api/data/', undefined, 'user2');
    expect(key1).not.toBe(key2);
  });
});
