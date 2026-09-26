jest.mock('../configs/logger', () => () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

import PolicyRegistry from '../services/policyRegistry';

function res() {
  const r: any = { headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn(function (this: any) { this.headersSent = true; return this; }) };
  return r;
}

describe('PolicyRegistry', () => {
  const registry = PolicyRegistry.getInstance();

  it('ships ip-restriction and rejects unknown policies at compile time', () => {
    expect(registry.names()).toContain('ip-restriction');
    expect(() => registry.compile({}, { nope: {} }, 'svc x')).toThrow(/unknown policy "nope"/);
  });

  it('validates policy config against its schema', () => {
    expect(() => registry.compile({}, { 'ip-restriction': { allow: 'not-a-list' } }, 'svc x')).toThrow(/invalid config/);
  });

  it('ip-restriction denies by CIDR and allow-list, and lets others through', async () => {
    const route = {};
    registry.compile(route, { 'ip-restriction': { allow: ['10.0.0.0/8'], deny: ['10.1.2.3'] } }, 'svc x');
    const handlers = registry.handlersFor(route);
    expect(handlers).toHaveLength(1);

    const denied = res();
    expect(await PolicyRegistry.run(handlers, { ip: '10.1.2.3' } as any, denied)).toBe(true);
    expect(denied.status).toHaveBeenCalledWith(403);

    const outside = res();
    expect(await PolicyRegistry.run(handlers, { ip: '192.168.1.1' } as any, outside)).toBe(true);

    const ok = res();
    expect(await PolicyRegistry.run(handlers, { ip: '::ffff:10.9.9.9' } as any, ok)).toBe(false);
    expect(ok.status).not.toHaveBeenCalled();
  });

  it('runs higher priority first and registers custom policies', async () => {
    const order: string[] = [];
    registry.register({ name: 'low', priority: 1, create: () => (_q, _s, next) => { order.push('low'); next(); } });
    registry.register({ name: 'high', priority: 100, create: () => (_q, _s, next) => { order.push('high'); next(); } });
    const owner = {};
    registry.compile(owner, { low: {}, high: {} }, 'svc x');
    await PolicyRegistry.run(registry.handlersFor(owner), {} as any, res());
    expect(order).toEqual(['high', 'low']);
  });
});
