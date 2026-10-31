import { BlockCache } from '../utils/blockCache';

describe('BlockCache', () => {
  it('forgets an entry once its block has run out', () => {
    const c = new BlockCache<{ until: number }>();
    c.set('a', { until: 1_000 });
    expect(c.get('a', 999)).toEqual({ until: 1_000 });
    expect(c.get('a', 1_000)).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('drops the oldest entry when full, so an attack from many IPs cannot grow it without bound', () => {
    const c = new BlockCache<{ until: number }>(2);
    c.set('a', { until: 9e15 });
    c.set('b', { until: 9e15 });
    c.set('c', { until: 9e15 });
    expect(c.size).toBe(2);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('c')).toBeDefined();
  });
});
