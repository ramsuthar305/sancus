jest.mock('../configs/logger', () => () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

const mockGet = jest.fn();
const mockSet = jest.fn().mockResolvedValue('OK');
jest.mock('../services/redis.service', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getClient: () => ({ get: mockGet, set: mockSet }) }) },
}));
const mockVerify = jest.fn();
jest.mock('../clients/authClient', () => ({ __esModule: true, default: { getInstance: () => ({ verify: mockVerify }) } }));

const load = (env: Record<string, string>) => {
  jest.resetModules();
  Object.assign(process.env, env);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../services/auth.service').default.getInstance();
};
const req: any = {};
const ok = { ok: true, identity: { id: 7 }, upstreamHeaders: { 'x-user-role': 'admin' } };

describe('AuthService in-memory token cache', () => {
  beforeEach(() => { jest.clearAllMocks(); jest.useRealTimers(); });
  afterAll(() => { delete process.env.AUTH_LOCAL_CACHE_TTL_MS; delete process.env.AUTH_LOCAL_CACHE_MAX; });

  it('serves a verified token from memory without touching Redis', async () => {
    const svc = load({ AUTH_LOCAL_CACHE_TTL_MS: '5000' });
    mockGet.mockResolvedValueOnce(null);
    mockVerify.mockResolvedValueOnce(ok);
    expect(await svc.authenticate('Bearer a', req)).toMatchObject(ok);
    expect(await svc.authenticate('Bearer a', req)).toMatchObject(ok);
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  it('fills memory from a Redis hit, and expires after the TTL', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const svc = load({ AUTH_LOCAL_CACHE_TTL_MS: '5000' });
    mockGet.mockResolvedValue(JSON.stringify({ identity: { id: 9 }, upstreamHeaders: {} }));
    await svc.authenticate('Bearer b', req);
    await svc.authenticate('Bearer b', req);
    expect(mockGet).toHaveBeenCalledTimes(1);
    jest.setSystemTime(1_000_000 + 5001);
    await svc.authenticate('Bearer b', req);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('never caches a rejection', async () => {
    const svc = load({ AUTH_LOCAL_CACHE_TTL_MS: '5000' });
    mockGet.mockResolvedValue(null);
    mockVerify.mockResolvedValue({ ok: false, status: 401, headers: {} });
    await svc.authenticate('Bearer bad', req);
    await svc.authenticate('Bearer bad', req);
    expect(mockVerify).toHaveBeenCalledTimes(2);
  });

  it('drops the oldest entry past AUTH_LOCAL_CACHE_MAX', async () => {
    const svc = load({ AUTH_LOCAL_CACHE_TTL_MS: '5000', AUTH_LOCAL_CACHE_MAX: '2' });
    mockGet.mockResolvedValue(null);
    mockVerify.mockResolvedValue(ok);
    for (const t of ['t1', 't2', 't3']) await svc.authenticate(t, req);
    mockVerify.mockClear();
    await svc.authenticate('t3', req);
    await svc.authenticate('t2', req);
    expect(mockVerify).not.toHaveBeenCalled();
    await svc.authenticate('t1', req);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it('is off at AUTH_LOCAL_CACHE_TTL_MS=0', async () => {
    const svc = load({ AUTH_LOCAL_CACHE_TTL_MS: '0' });
    mockGet.mockResolvedValue(null);
    mockVerify.mockResolvedValue(ok);
    await svc.authenticate('Bearer c', req);
    await svc.authenticate('Bearer c', req);
    expect(mockVerify).toHaveBeenCalledTimes(2);
  });
});
