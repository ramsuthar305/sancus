import crypto, { createHash } from 'crypto';
import type { Request } from 'express';
import AuthServiceClient, { VerifyResult } from '../clients/authClient';
import getLogger from '../configs/logger';
import RedisService from './redis.service';

const logger = getLogger();
const TOKEN_CACHE_TTL = Number(process.env.AUTH_CACHE_TTL) || 60; // seconds, shared across pods
const TOKEN_CACHE_PREFIX = 'sancus:token:';

// Native sha256; the one-shot API (Node >= 21.7) is ~2x faster than createHash. Measured 2026-09:
// djb2-in-JS 943ns, createHash 933ns, crypto.hash 436ns for an 821-byte token. Redis GET is ~500µs.
const hashToken: (t: string) => string =
  typeof (crypto as any).hash === 'function'
    ? (t) => (crypto as any).hash('sha256', t, 'base64url')
    : (t) => createHash('sha256').update(t).digest('base64url');

class AuthService {
  private static instance: AuthService;
  private readonly redisService = RedisService.getInstance();
  private readonly client = AuthServiceClient.getInstance();

  static getInstance(): AuthService {
    if (!AuthService.instance) AuthService.instance = new AuthService();
    return AuthService.instance;
  }

  /** Verify a bearer token, caching positive results in Redis for AUTH_CACHE_TTL seconds. */
  async authenticate(token: string, req: Request): Promise<VerifyResult> {
    const redis = this.redisService.getClient();
    const key = `${TOKEN_CACHE_PREFIX}${hashToken(token)}`;

    if (redis) {
      try {
        const raw = await redis.get(key);
        if (raw) return { ok: true, ...JSON.parse(raw) };
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'token cache GET failed');
      }
    }

    const result = await this.client.verify(token, req);
    if (redis && result.ok && result.identity) {
      redis
        .set(key, JSON.stringify({ identity: result.identity, upstreamHeaders: result.upstreamHeaders }), 'EX', TOKEN_CACHE_TTL)
        .catch((e) => logger.warn({ err: (e as Error).message }, 'token cache SET failed'));
    }
    return result;
  }
}

export default AuthService;
