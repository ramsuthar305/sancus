jest.mock('../configs/logger', () => () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

import yaml from 'js-yaml';
import { cacheWarnings } from '../utils/configValidator';
import type { APIConfig } from '../types/api';

const svc = (route: string) => yaml.load(`service: { name: s, nodes: [http://x] }\napis: [{ name: a, routes: [${route}] }]\n`) as APIConfig;

describe('cache key warnings for routes that know the user (security 1)', () => {
  it('warns on a shared key when the route needs a login', () => {
    const w = cacheWarnings(svc('{ path: /me, methods: [GET], cache: { strategy: LRU, ttl: 60, key: PATH } }'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/PATH_QUERY_USER/);
  });
  it('warns on a shared key on a resolveUser route', () => {
    expect(cacheWarnings(svc('{ path: /feed, methods: [GET], bypass: [AUTH], resolveUser: true, cache: { strategy: LRU, ttl: 60, key: PATH_QUERY } }'))).toHaveLength(1);
  });
  it('stays quiet for per-user keys and for anonymous routes', () => {
    expect(cacheWarnings(svc('{ path: /me, methods: [GET], cache: { strategy: LRU, ttl: 60, key: PATH_QUERY_USER } }'))).toHaveLength(0);
    expect(cacheWarnings(svc('{ path: /public, methods: [GET], bypass: [AUTH], cache: { strategy: LRU, ttl: 60, key: PATH } }'))).toHaveLength(0);
  });
});
