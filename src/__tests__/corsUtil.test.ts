describe('CORS origin matching', () => {
  const load = (origins: string) => {
    jest.resetModules();
    process.env.ALLOWED_ORIGINS = origins;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../utils/corsUtil').default;
  };
  const allowed = (Cors: any, origin: string) => {
    const headers: Record<string, string> = {};
    Cors.setHeaders({ get: () => origin } as any, { setHeader: (k: string, v: string) => (headers[k] = v) } as any);
    return headers['Access-Control-Allow-Origin'] === origin;
  };
  afterAll(() => { delete process.env.ALLOWED_ORIGINS; });

  it('matches plain origins exactly', () => {
    const Cors = load('https://app.example.com');
    expect(allowed(Cors, 'https://app.example.com')).toBe(true);
    expect(allowed(Cors, 'https://app.example.com.evil.io')).toBe(false);
  });
  it('anchors regex entries to the whole origin (security 14)', () => {
    const Cors = load('/https:\\/\\/([a-z0-9-]+\\.)?example\\.com/');
    expect(allowed(Cors, 'https://example.com')).toBe(true);
    expect(allowed(Cors, 'https://app.example.com')).toBe(true);
    expect(allowed(Cors, 'https://evil-example.com')).toBe(false);
    expect(allowed(Cors, 'https://example.com.evil.io')).toBe(false);
  });
});
