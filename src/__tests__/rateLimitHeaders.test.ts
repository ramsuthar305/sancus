describe('rateLimitHeaders families (RATELIMIT_HEADERS)', () => {
  const load = (family?: string) => {
    jest.resetModules();
    if (family === undefined) delete process.env.RATELIMIT_HEADERS;
    else process.env.RATELIMIT_HEADERS = family;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../utils/rateLimitHeaders').rateLimitHeaders(10, 3, 41.2, 60);
  };
  afterAll(() => { delete process.env.RATELIMIT_HEADERS; });

  it('emits both families by default', () => {
    expect(load()).toEqual({
      'X-RateLimit-Limit': '10', 'X-RateLimit-Remaining': '3', 'X-RateLimit-Reset': '42',
      'RateLimit-Limit': '10, 10;w=60', 'RateLimit-Remaining': '3', 'RateLimit-Reset': '42',
    });
  });
  it('legacy only', () => expect(Object.keys(load('legacy'))).toEqual(['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']));
  it('draft only', () => expect(Object.keys(load('draft'))).toEqual(['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset']));
});
