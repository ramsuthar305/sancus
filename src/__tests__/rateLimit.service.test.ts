jest.mock('../configs/logger', () => () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/alerts', () => ({ __esModule: true, default: { getInstance: () => ({ alert: jest.fn(), enabled: false }) } }));

const mockEval = jest.fn();
const mockPttl = jest.fn();
const mockSet = jest.fn();
jest.mock('../services/redis.service', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getClient: () => ({ sancusSlidingWindow: mockEval, pttl: mockPttl, set: mockSet }) }) },
}));

import RateLimitService from '../services/rateLimit.service';

const req: any = { ip: '1.2.3.4', socket: {} };
const base = { serviceName: 'svc', method: 'GET' as const, req };

describe('RateLimitService.enforce()', () => {
  beforeEach(() => { jest.clearAllMocks(); RateLimitService.getInstance().clearBlocks(); });

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
    expect(mockEval.mock.calls[0][0]).toMatch(/:d:sw$/);
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
    expect(mockEval.mock.calls[0][0]).toBe('ratelimit:group:search:ip:1.2.3.4:m:sw');
    expect(r.headers).toEqual({});
  });

  it('never puts a raw API key in the Redis key (security 8)', async () => {
    mockEval.mockResolvedValueOnce([1, 5, 0, 30]);
    await RateLimitService.getInstance().enforce({ ...base, apiKey: 'sk_live_supersecret', route: { path: '/p', methods: ['GET'], rateLimit: { perMinute: 10, key: 'API_KEY' } } });
    expect(mockEval.mock.calls[0][0]).not.toContain('supersecret');
    expect(mockEval.mock.calls[0][0]).toMatch(/apikey:[0-9a-f]{16}:m:sw$/);
  });

  it('answers a caller it already rejected from memory, without Redis', async () => {
    mockEval.mockResolvedValueOnce([0, 0, 17, 17]);
    const route = { path: '/login', methods: ['GET'] as any, rateLimit: { perMinute: 5 } };
    const first = await RateLimitService.getInstance().enforce({ ...base, route });
    const again = await RateLimitService.getInstance().enforce({ ...base, route });
    expect(first.allowed).toBe(false);
    expect(again.allowed).toBe(false);
    expect(again.retryAfterSeconds).toBeGreaterThanOrEqual(16);
    expect(again.headers['X-RateLimit-Remaining']).toBe('0');
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it('blockFor: writes a shared block with NX and holds the caller for blockFor seconds', async () => {
    mockPttl.mockResolvedValueOnce(-2);
    mockEval.mockResolvedValueOnce([0, 0, 12, 12]);
    const r = await RateLimitService.getInstance().enforce({ ...base, route: { path: '/otp', methods: ['GET'], rateLimit: { perMinute: 5, blockFor: 900 } } });
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(900);
    expect(mockSet).toHaveBeenCalledWith('ratelimit:svc:GET:/otp:ip:1.2.3.4:blocked', '1', 'PX', 900000, 'NX');
  });

  it('blockFor: a block set by another pod rejects without consuming a window', async () => {
    mockPttl.mockResolvedValueOnce(300_000);
    const r = await RateLimitService.getInstance().enforce({ ...base, route: { path: '/otp2', methods: ['GET'], rateLimit: { perMinute: 5, blockFor: 900 } } });
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(300);
    expect(mockEval).not.toHaveBeenCalled();
  });

  it('routes without blockFor never pay for the block lookup', async () => {
    mockEval.mockResolvedValueOnce([1, 4, 0, 60]);
    await RateLimitService.getInstance().enforce({ ...base, route: { path: '/plain', methods: ['GET'], rateLimit: { perMinute: 5 } } });
    expect(mockPttl).not.toHaveBeenCalled();
  });
});
