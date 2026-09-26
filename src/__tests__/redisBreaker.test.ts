jest.mock('../configs/logger', () => () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
const mockAlert = jest.fn();
jest.mock('../utils/alerts', () => ({ __esModule: true, default: { getInstance: () => ({ alert: mockAlert, enabled: true }) } }));

import RedisService from '../services/redis.service';

describe('Redis breaker for a Redis that stops answering', () => {
  afterEach(() => jest.useRealTimers());

  it('skips Redis after a command timeout, then tries again after the backoff', () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const svc = RedisService.getInstance() as any;
    svc.redis = { fake: true };
    expect(svc.getClient()).toEqual({ fake: true });

    svc.noteFailure(new Error('Command timed out'));
    expect(svc.getClient()).toBeUndefined();
    expect(svc.skipping).toBe(true);

    jest.setSystemTime(1_000_000 + 5001);
    expect(svc.getClient()).toEqual({ fake: true });
    svc.redis = undefined;
  });

  it('ignores errors that already fail fast, like a closed connection', () => {
    const svc = RedisService.getInstance() as any;
    svc.skipUntil = 0;
    svc.noteFailure(new Error('Connection is closed.'));
    expect(svc.skipping).toBe(false);
  });

  it('alerts on the 1st, 1001st and 2001st request without Redis, then once on recovery', () => {
    const svc = RedisService.getInstance() as any;
    mockAlert.mockClear(); svc.skipUntil = 0; svc.degraded = false; svc.failedRequests = 0;
    svc.redis = { status: 'reconnecting' };
    for (let i = 0; i < 2500; i++) svc.noteRequest();
    expect(mockAlert.mock.calls.map((c: any[]) => c[0].replace(/^redis-down:\d+:/, 'redis-down:'))).toEqual(['redis-down:1', 'redis-down:1001', 'redis-down:2001']);
    expect(mockAlert.mock.calls[1][2]).toMatch(/Request #1,001 served without Redis/);
    svc.redis = { status: 'ready' };
    svc.noteRequest(); svc.noteRequest();
    expect(mockAlert).toHaveBeenCalledTimes(4);
    expect(mockAlert.mock.calls[3][0]).toMatch(/^redis-up:/);
    expect(mockAlert.mock.calls[3][2]).toMatch(/2,500 requests were served without Redis/);
    svc.redis = undefined;
  });

  it('gives every outage its own alert, even back to back', () => {
    const svc = RedisService.getInstance() as any;
    mockAlert.mockClear(); svc.degraded = false; svc.failedRequests = 0; svc.skipUntil = 0;
    for (const status of ['reconnecting', 'ready', 'reconnecting', 'ready']) { svc.redis = { status }; svc.noteRequest(); }
    const keys = mockAlert.mock.calls.map((c: any[]) => c[0]);
    expect(keys.filter((k: string) => k.startsWith('redis-down:')).length).toBe(2);
    expect(new Set(keys).size).toBe(keys.length);
    svc.redis = undefined;
  });
});
