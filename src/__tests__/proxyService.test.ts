jest.mock('../configs/logger', () => () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/alerts', () => ({ __esModule: true, default: { getInstance: () => ({ alert: jest.fn(), enabled: false }) } }));
jest.mock('../services/redis.service', () => ({ __esModule: true, default: { getInstance: () => ({ getClient: () => null }) } }));

import ProxyService from '../services/proxy.service';

const svc = ProxyService.getInstance();

describe('ProxyService helpers', () => {
  it('resolves nodes from the list or from the legacy host env var + port', () => {
    expect(svc.resolveNodes({ name: 'a', nodes: ['http://x', 'http://y'] })).toEqual(['http://x', 'http://y']);
    process.env.A_URL = 'http://legacy';
    expect(svc.resolveNodes({ name: 'a', host: 'A_URL', port: 80 })).toEqual(['http://legacy']);
    expect(svc.resolveNodes({ name: 'a', host: 'A_URL', port: 8080 })).toEqual(['http://legacy:8080']);
    delete process.env.A_URL;
    expect(() => svc.resolveNodes({ name: 'a', host: 'A_URL' })).toThrow(/No host URL/);
  });

  it('round-robins across nodes and skips ones marked down', () => {
    const nodes = ['http://n1', 'http://n2', 'http://n3'];
    const pick = () => (svc as any).pickNode('rr', nodes);
    expect([pick(), pick(), pick(), pick()]).toEqual(['http://n1', 'http://n2', 'http://n3', 'http://n1']);
    (svc as any).markDown('rr', 'http://n2');
    expect([pick(), pick(), pick()]).toEqual(['http://n3', 'http://n1', 'http://n3']);
  });

  it('applies the service rewrite regex to the upstream path', () => {
    const service = { name: 'r', nodes: ['http://x'], rewrite: { from: '^/v1/(.*)', to: '/internal/$1' } };
    expect(svc.rewritePath(service, '/v1/users?x=1')).toBe('/internal/users?x=1');
    expect(svc.rewritePath({ name: 'r', nodes: ['http://x'] }, '/v1/users')).toBe('/v1/users');
  });
});
