jest.mock('../configs/logger', () => () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
jest.mock('../services/redis.service', () => ({ __esModule: true, default: { getInstance: () => ({ getClient: () => null }) } }));

import { decideCompression, mergeVary } from '../utils/compression';

const req = (ae?: string, method = 'GET'): any => ({ method, headers: ae === undefined ? {} : { 'accept-encoding': ae } });
const json = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json; charset=utf-8', 'content-length': '5000', ...extra });

describe('decideCompression()', () => {
  it('prefers br, falls back to gzip, honours q=0 and no header', () => {
    expect(decideCompression(req('gzip, deflate, br'), 200, json())).toEqual({ encoding: 'br', vary: true });
    expect(decideCompression(req('gzip'), 200, json())).toEqual({ encoding: 'gzip', vary: true });
    expect(decideCompression(req('gzip;q=0'), 200, json())).toEqual({ encoding: undefined, vary: true });
    expect(decideCompression(req(), 200, json())).toEqual({ encoding: undefined, vary: true });
  });

  it('skips small, already-encoded, HEAD, 204 and 304 responses but still varies', () => {
    expect(decideCompression(req('gzip'), 200, json({ 'content-length': '100' }))).toEqual({ vary: true });
    expect(decideCompression(req('gzip'), 200, json({ 'content-encoding': 'gzip' }))).toEqual({ vary: true });
    expect(decideCompression(req('gzip', 'HEAD'), 200, json())).toEqual({ vary: true });
    expect(decideCompression(req('gzip'), 204, json())).toEqual({ vary: true });
    expect(decideCompression(req('gzip'), 304, json())).toEqual({ vary: true });
  });

  it('compresses bodies of unknown length (chunked), like the middleware it replaces', () => {
    const { 'content-length': _, ...chunked } = json();
    expect(decideCompression(req('gzip'), 200, chunked).encoding).toBe('gzip');
  });

  it('never touches SSE, binary types or no-transform responses', () => {
    expect(decideCompression(req('gzip'), 200, { 'content-type': 'text/event-stream' })).toEqual({ vary: false });
    expect(decideCompression(req('gzip'), 200, { 'content-type': 'image/png', 'content-length': '5000' })).toEqual({ vary: false });
    expect(decideCompression(req('gzip'), 200, json({ 'cache-control': 'public, no-transform' }))).toEqual({ vary: false });
    expect(decideCompression(req('gzip'), 200, {})).toEqual({ vary: false });
  });
});

describe('mergeVary()', () => {
  it('folds every case variant into one Vary without duplicates', () => {
    const h: any = { vary: 'Origin, accept-encoding', Vary: 'Authorization, Accept-Encoding' };
    mergeVary(h, 'Accept-Encoding');
    expect(h).toEqual({ Vary: 'Origin, Accept-Encoding, Authorization' });
  });

  it('adds the header when absent and leaves headers alone when there is nothing to say', () => {
    const a: any = {};
    mergeVary(a, 'Accept-Encoding');
    expect(a).toEqual({ Vary: 'Accept-Encoding' });
    const b: any = { 'content-type': 'x' };
    mergeVary(b);
    expect(b).toEqual({ 'content-type': 'x' });
  });
});
