import { DEFAULT_TRUST_PROXY, getClientIp, parseTrustProxy } from '../utils/clientIp';

describe('trust proxy parsing', () => {
  it('defaults to private address space, never to "trust nobody"', () => {
    expect(parseTrustProxy(undefined)).toBe(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy('')).toBe(DEFAULT_TRUST_PROXY);
  });
  it('accepts false, true, hop counts and CIDR lists', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
  it('reads req.ip and falls back to the socket', () => {
    expect(getClientIp({ ip: '1.1.1.1' } as any)).toBe('1.1.1.1');
    expect(getClientIp({ socket: { remoteAddress: '2.2.2.2' } } as any)).toBe('2.2.2.2');
  });
});
