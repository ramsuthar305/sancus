import compressible from 'compressible';
import type { Request } from 'express';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'http';
import zlib from 'zlib';
import CacheService from '../services/cache.service';

/**
 * Response compression for proxied responses, decided once per response from the upstream's
 * headers. It replaces the global `compression` middleware on the proxy path: that middleware
 * wrapped res.write/end/writeHead on every response, which cost ~12% of throughput even when
 * nothing was compressed. Here a response that is not compressed is piped untouched, and one that
 * is goes through Node's native zlib / brotli.
 *
 *   COMPRESSION=false        turn it off (e.g. the load balancer or the upstream compresses)
 *   COMPRESSION_THRESHOLD    bytes; bodies with a smaller Content-Length pass through (default 1024)
 *
 * Same rules as the middleware it replaces: br preferred over gzip, brotli quality 4, gzip level 6,
 * never for HEAD, 204/304, SSE, already-encoded bodies or `Cache-Control: no-transform`.
 */
export const COMPRESSION_ENABLED = process.env.COMPRESSION !== 'false';
export const COMPRESSION_THRESHOLD = Number(process.env.COMPRESSION_THRESHOLD ?? 1024);
const NO_TRANSFORM = /(?:^|,)\s*?no-transform\s*?(?:,|$)/i;

export type Encoding = 'br' | 'gzip';

export interface CompressionDecision {
  /** Encoding to apply, or undefined to pass the body through as is. */
  encoding?: Encoding;
  /** The representation depends on Accept-Encoding, so caches downstream must Vary on it. */
  vary: boolean;
}

export function decideCompression(req: Request, status: number, upstream: IncomingHttpHeaders): CompressionDecision {
  if (!COMPRESSION_ENABLED) return { vary: false };
  const type = String(upstream['content-type'] ?? '');
  if (!type || type.includes('text/event-stream') || !compressible(type)) return { vary: false };
  if (NO_TRANSFORM.test(String(upstream['cache-control'] ?? ''))) return { vary: false };

  const already = upstream['content-encoding'];
  if (already && already !== 'identity') return { vary: true };
  if (req.method === 'HEAD' || status < 200 || status === 204 || status === 304) return { vary: true };
  const length = upstream['content-length'];
  if (length !== undefined && Number(length) < COMPRESSION_THRESHOLD) return { vary: true };

  const bucket = CacheService.encodingBucket(req);
  return { encoding: bucket === 'identity' ? undefined : bucket, vary: true };
}

export function createCompressor(encoding: Encoding): zlib.Gzip | zlib.BrotliCompress {
  return encoding === 'br'
    ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
    : zlib.createGzip();
}

/** Add tokens to the Vary header, merging every case variant of the key into one `Vary`. */
export function mergeVary(headers: OutgoingHttpHeaders, ...tokens: string[]): void {
  const seen = new Map<string, string>();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== 'vary') continue;
    const value = headers[key];
    for (const t of String(Array.isArray(value) ? value.join(',') : value ?? '').split(',')) {
      const v = t.trim();
      if (v) seen.set(v.toLowerCase(), v);
    }
    delete headers[key];
  }
  for (const t of tokens) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  if (seen.size) headers.Vary = [...seen.values()].join(', ');
}
