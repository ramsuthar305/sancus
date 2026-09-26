import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfigFile } from '../utils/configValidator';

const write = (yml: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 's.yml');
  fs.writeFileSync(f, yml);
  return f;
};
const svc = (route: string) => `service: { name: s, nodes: [http://x] }\napis: [{ name: a, routes: [${route}] }]\n`;

describe('cache rules for routes that see a user (security 1)', () => {
  it('refuses a shared cache key on an auth-required route', () => {
    expect(() => loadConfigFile(write(svc('{ path: /me, methods: [GET], cache: { strategy: LRU, ttl: 60, key: PATH } }')))).toThrow(/PATH_QUERY_USER/);
  });
  it('refuses a shared cache key on a resolveUser route', () => {
    expect(() => loadConfigFile(write(svc('{ path: /feed, methods: [GET], bypass: [AUTH], resolveUser: true, cache: { strategy: LRU, ttl: 60, key: PATH_QUERY } }')))).toThrow(/shared: true/);
  });
  it('allows a per-user key, or a shared key when marked shared: true', () => {
    expect(() => loadConfigFile(write(svc('{ path: /me, methods: [GET], cache: { strategy: LRU, ttl: 60, key: PATH_QUERY_USER } }')))).not.toThrow();
    expect(() => loadConfigFile(write(svc('{ path: /countries, methods: [GET], cache: { strategy: LRU, ttl: 60, key: PATH, shared: true } }')))).not.toThrow();
    expect(() => loadConfigFile(write(svc('{ path: /public, methods: [GET], bypass: [AUTH], cache: { strategy: LRU, ttl: 60, key: PATH } }')))).not.toThrow();
  });
});
