import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import http from 'http';
import https from 'https';
import ClientResponseStatus from '../types/requestStatus';
import { AuthResponse } from '../types/auth';
import getLogger from '../configs/logger';

const logger = getLogger();

// Auth wiring is fully env-driven so any token-verification service can be plugged in:
//   AUTH_URL             base URL of the auth service (VERITAS_URL still accepted as a fallback)
//   AUTH_VERIFY_PATH     path appended to AUTH_URL                   default: /v1/verify/token
//   AUTH_VERIFY_METHOD   HTTP method                                  default: POST
//   AUTH_TOKEN_IN        where the token is sent: body | header       default: body
//   AUTH_TOKEN_FIELD     body field (body mode) or header name (header mode)
//                                                                     default: token | authorization
//   AUTH_USER_ID_FIELD   dot-path in the JSON response identifying the user  default: id
//   AUTH_TIMEOUT_MS      request timeout                              default: 5000
// A 2xx response containing AUTH_USER_ID_FIELD is a valid token; 401 is invalid; anything else is an error.
const AUTH_URL = process.env.AUTH_URL || process.env.VERITAS_URL || '';
const VERIFY_PATH = process.env.AUTH_VERIFY_PATH || '/v1/verify/token';
const VERIFY_METHOD = (process.env.AUTH_VERIFY_METHOD || 'POST').toUpperCase();
const TOKEN_IN = process.env.AUTH_TOKEN_IN === 'header' ? 'header' : 'body';
const TOKEN_FIELD = process.env.AUTH_TOKEN_FIELD || (TOKEN_IN === 'header' ? 'authorization' : 'token');
const USER_ID_FIELD = process.env.AUTH_USER_ID_FIELD || 'id';
const TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS) || 5000;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function pluck(obj: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

class AuthServiceClient {
  private static instance: AuthServiceClient;
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({ baseURL: AUTH_URL, httpAgent, httpsAgent, timeout: TIMEOUT_MS });
  }

  static getInstance(): AuthServiceClient {
    if (!AuthServiceClient.instance) {
      AuthServiceClient.instance = new AuthServiceClient();
    }
    return AuthServiceClient.instance;
  }

  async verifyToken(token: string): Promise<AuthResponse | ClientResponseStatus> {
    try {
      const response: AxiosResponse = await this.client.request({
        url: VERIFY_PATH,
        method: VERIFY_METHOD,
        ...(TOKEN_IN === 'header'
          ? { headers: { [TOKEN_FIELD]: token } }
          : { data: { [TOKEN_FIELD]: token } }),
      });

      const id = pluck(response.data, USER_ID_FIELD);
      if (id === undefined || id === null) {
        throw new Error(`Auth response has no "${USER_ID_FIELD}" field; set AUTH_USER_ID_FIELD to match your auth service`);
      }
      return { ...response.data, id: id as string | number };
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError: AxiosError = error;
        if (axiosError.response?.status === 401) {
          return ClientResponseStatus.UNAUTHORIZED;
        } else if (axiosError.response?.status === 400) {
          return ClientResponseStatus.BAD_REQUEST;
        }
        logger.error({ status: axiosError.response?.status }, 'Auth request failed');
        throw new Error('Auth request failed');
      }
      logger.error({ err: error.message }, 'Auth request error');
      throw error;
    }
  }
}

export default AuthServiceClient;
