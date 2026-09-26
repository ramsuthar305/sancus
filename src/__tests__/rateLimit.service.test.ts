jest.mock('../configs/logger', () => () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/alerts', () => ({ __esModule: true, default: { getInstance: () => ({ alert: jest.fn(), enabled: false }) } }));

const mockEval = jest.fn();
jest.mock('../services/redis.service', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getClient: () => ({ eval: mockEval }) }) },
}));

import RateLimitService from '../services/rateLimit.service';

const req: any = { ip: '1.2.3.4', socket: {} };
const base = { serviceName: 'svc', method: 'GET' as const, req };

describe('RateLimitService.enforce()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits both header families on allow, from the tightest window', async () => {
    mockEval
      .mockResolvedValueOnce([1, 900, 0, 80000]) // day
      .mockResolvedValueOnce([1, 3, 0, 42]);     // minute (tighter)
    const r = await RateLimitService.getInstance().enforce({ ...base, route: { path: '/p', methods: ['GET'], rateLimit: { perMinute: 10, perDay: 1000 } } });
    expect(r.allowed).toBe(true);
    expect(r.headers['X-RateLimit-Limit']).toBe('10');
    expect(r.headers['X-RateLimit-Remaining']).toBe('3');
    expect(r.headers['RateLimit-Limit']).toBe('10, 10;w=60');
    expect(r.headers['RateLimit-Reset']).toBe('42');
    // day window checked first so a day rejection never burns a minute token
    expect(mockEval.mock.calls[0][2]).toMatch(/:d$/);
  });

  it('rejects with retryAfter when a window is exhausted', async () => {
    mockEval.mockResolvedValueOnce([0, 0, 17, 17]);
    const r = await RateLimitService.getInstance().enforce({ ...base, route: { path: '/p', methods: ['GET'], rateLimit: { perMinute: 10 } } });
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(17);
    expect(r.headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('fails open when Redis errors', async () => {
    mockEval.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await RateLimitService.getInstance().enforce({ ...base, route: { path: '/p', methods: ['GET'], rateLimit: { perMinute: 10 } } });
    expect(r.allowed).toBe(true);
  });

  it('uses the group key and hides headers when configured', async () => {
    mockEval.mockResolvedValueOnce([1, 5, 0, 30]);
    const r = await RateLimitService.getInstance().enforce({ ...base, route: { path: '/p', methods: ['GET'], rateLimit: { perMinute: 10, group: 'search', hideHeaders: true } } });
    expect(mockEval.mock.calls[0][2]).toBe('ratelimit:group:search:ip:1.2.3.4:m');
    expect(r.headers).toEqual({});
  });

  it('never puts a raw API key in the Redis key (security 8)', async () => {
    mockEval.mockResolvedValueOnce([1, 5, 0, 30]);
    await RateLimitService.getInstance().enforce({ ...base, apiKey: 'sk_live_supersecret', route: { path: '/p', methods: ['GET'], rateLimit: { perMinute: 10, key: 'API_KEY' } } });
    expect(mockEval.mock.calls[0][2]).not.toContain('supersecret');
    expect(mockEval.mock.calls[0][2]).toMatch(/apikey:[0-9a-f]{16}:m$/);
  });
});
