import crypto, { createHash } from 'crypto';
import type { Request } from 'express';
import AuthServiceClient, { VerifyResult } from '../clients/authClient';
import getLogger from '../configs/logger';
import type { AuthResponse } from '../types/auth';
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

// In-process L1 in front of the Redis token cache: a hot token skips its Redis GET.
//   AUTH_LOCAL_CACHE_TTL_MS  how long a verified token is trusted from memory (default 5000; 0 = off)
//   AUTH_LOCAL_CACHE_MAX     entries kept per worker, oldest dropped first (default 10000)
// Revocation already lags up to AUTH_CACHE_TTL through Redis; the L1 adds at most its own TTL.
const LOCAL_TTL_MS = Number(process.env.AUTH_LOCAL_CACHE_TTL_MS ?? 5000);
const LOCAL_MAX = Number(process.env.AUTH_LOCAL_CACHE_MAX) || 10_000;

interface CachedIdentity {
  identity?: AuthResponse;
  upstreamHeaders: Record<string, string>;
}

class AuthService {
  private static instance: AuthService;
  private readonly redisService = RedisService.getInstance();
  private readonly client = AuthServiceClient.getInstance();
  private readonly local = new Map<string, { value: CachedIdentity; expiresAt: number }>();

  static getInstance(): AuthService {
    if (!AuthService.instance) AuthService.instance = new AuthService();
    return AuthService.instance;
  }

  private remember(key: string, value: CachedIdentity): void {
    if (LOCAL_TTL_MS <= 0) return;
    this.local.delete(key);
    this.local.set(key, { value, expiresAt: Date.now() + LOCAL_TTL_MS });
    if (this.local.size > LOCAL_MAX) this.local.delete(this.local.keys().next().value as string);
  }

  /** Verify a bearer token: memory (AUTH_LOCAL_CACHE_TTL_MS), then Redis (AUTH_CACHE_TTL s), then the auth service. */
  async authenticate(token: string, req: Request): Promise<VerifyResult> {
    const key = `${TOKEN_CACHE_PREFIX}${hashToken(token)}`;

    const hit = this.local.get(key);
    if (hit) {
      if (hit.expiresAt > Date.now()) return { ok: true, ...hit.value };
      this.local.delete(key);
    }

    const redis = this.redisService.getClient();
    if (redis) {
      try {
        const raw = await redis.get(key);
        if (raw) {
          const value: CachedIdentity = JSON.parse(raw);
          this.remember(key, value);
          return { ok: true, ...value };
        }
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'token cache GET failed');
      }
    }

    const result = await this.client.verify(token, req);
    if (result.ok && result.identity) {
      const value: CachedIdentity = { identity: result.identity, upstreamHeaders: result.upstreamHeaders };
      this.remember(key, value);
      redis?.set(key, JSON.stringify(value), 'EX', TOKEN_CACHE_TTL).catch((e) => logger.warn({ err: (e as Error).message }, 'token cache SET failed'));
    }
    return result;
  }
}

export default AuthService;
