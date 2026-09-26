import axios, { AxiosInstance } from 'axios';
import type { Request } from 'express';
import http from 'http';
import https from 'https';
import getLogger from '../configs/logger';
import { AuthResponse } from '../types/auth';

/**
 * Pluggable token verification following the ForwardAuth contract shared by Traefik, APISIX,
 * Envoy and Higress. Every call carries X-Forwarded-Method/-Proto/-Host/-Uri/-For.
 *
 *   AUTH_URL              base URL of the auth service (VERITAS_URL still accepted)
 *   AUTH_VERIFY_PATH      path appended to AUTH_URL                    default /v1/verify/token
 *   AUTH_VERIFY_METHOD    HTTP method                                   default POST
 *   AUTH_TOKEN_IN         where the token goes: body | header           default body
 *   AUTH_TOKEN_FIELD      body field (body mode) or header (header mode) default token | authorization
 *   AUTH_USER_ID_FIELD    dot-path in the 2xx JSON identifying the user default id
 *   AUTH_REQUEST_HEADERS  client headers forwarded to the auth service   default authorization
 *   AUTH_UPSTREAM_HEADERS auth-response headers copied to the upstream  default (none)
 *   AUTH_CLIENT_HEADERS   auth-response headers returned to the client on rejection  default (none)
 *   AUTH_TIMEOUT_MS       default 5000
 *   AUTH_FAIL_OPEN        true = let the request through anonymously if the auth service is down
 *   AUTH_STATUS_ON_ERROR  status when the auth service is unreachable and not failing open  default 403
 *
 * 2xx containing AUTH_USER_ID_FIELD => valid. Any other status is returned to the client verbatim.
 */
export type VerifyResult =
  | { ok: true; identity?: AuthResponse; upstreamHeaders: Record<string, string> }
  | { ok: false; status: number; body?: unknown; headers: Record<string, string> };

const list = (v: string | undefined, fallback: string[] = []) =>
  (v === undefined ? fallback : v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const AUTH_URL = process.env.AUTH_URL || process.env.VERITAS_URL || '';
const VERIFY_PATH = process.env.AUTH_VERIFY_PATH || '/v1/verify/token';
const VERIFY_METHOD = (process.env.AUTH_VERIFY_METHOD || 'POST').toUpperCase();
const TOKEN_IN = process.env.AUTH_TOKEN_IN === 'header' ? 'header' : 'body';
const TOKEN_FIELD = process.env.AUTH_TOKEN_FIELD || (TOKEN_IN === 'header' ? 'authorization' : 'token');
const USER_ID_FIELD = process.env.AUTH_USER_ID_FIELD || 'id';
const REQUEST_HEADERS = list(process.env.AUTH_REQUEST_HEADERS, ['authorization']);
const UPSTREAM_HEADERS = list(process.env.AUTH_UPSTREAM_HEADERS);
const CLIENT_HEADERS = list(process.env.AUTH_CLIENT_HEADERS);
const TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS) || 5000;
const FAIL_OPEN = process.env.AUTH_FAIL_OPEN === 'true';
const STATUS_ON_ERROR = Number(process.env.AUTH_STATUS_ON_ERROR) || 403;

const logger = getLogger();
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function pluck(obj: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

function pick(headers: Record<string, unknown>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = headers[n];
    if (v !== undefined && v !== null) out[n] = String(v);
  }
  return out;
}

class AuthServiceClient {
  private static instance: AuthServiceClient;
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({ baseURL: AUTH_URL, httpAgent, httpsAgent, timeout: TIMEOUT_MS, validateStatus: () => true });
  }

  static getInstance(): AuthServiceClient {
    if (!AuthServiceClient.instance) AuthServiceClient.instance = new AuthServiceClient();
    return AuthServiceClient.instance;
  }

  async verify(token: string, req: Request): Promise<VerifyResult> {
    const headers: Record<string, string> = {
      'X-Forwarded-Method': req.method,
      'X-Forwarded-Proto': req.protocol ?? 'http',
      'X-Forwarded-Host': req.get?.('host') ?? '',
      'X-Forwarded-Uri': req.originalUrl ?? '',
      'X-Forwarded-For': req.ip ?? '',
    };
    for (const h of REQUEST_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    if (TOKEN_IN === 'header') headers[TOKEN_FIELD] = token;

    try {
      const response = await this.client.request({
        url: VERIFY_PATH,
        method: VERIFY_METHOD,
        headers,
        data: TOKEN_IN === 'body' ? { [TOKEN_FIELD]: token } : undefined,
      });
      const responseHeaders = (response.headers ?? {}) as Record<string, unknown>;

      if (response.status >= 200 && response.status < 300) {
        const id = pluck(response.data, USER_ID_FIELD);
        if (id === undefined || id === null) {
          throw new Error(`Auth response has no "${USER_ID_FIELD}" field; set AUTH_USER_ID_FIELD to match your auth service`);
        }
        const data = typeof response.data === 'object' && response.data ? response.data : {};
        return { ok: true, identity: { ...data, id: id as string | number }, upstreamHeaders: pick(responseHeaders, UPSTREAM_HEADERS) };
      }
      return { ok: false, status: response.status, body: response.data, headers: pick(responseHeaders, CLIENT_HEADERS) };
    } catch (error: any) {
      logger.error({ err: error.message }, 'auth service call failed');
      if (FAIL_OPEN) return { ok: true, upstreamHeaders: {} };
      return { ok: false, status: STATUS_ON_ERROR, body: { message: 'Authentication service unavailable', response_code: 'SE0403' }, headers: {} };
    }
  }
}

export default AuthServiceClient;
