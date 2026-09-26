type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'CONNECT' | 'TRACE';

interface APIAuthorization {
  methods: HttpMethod[];
}

interface RateLimitConfig {
  perMinute?: number;
  perDay?: number;
  key?: 'API_KEY' | 'USER' | 'IP' | 'USER_OR_IP';
}

interface CacheConfig {
  strategy: 'LRU' | 'LFU' | 'SWR';
  ttl: number;
  key?: 'PATH' | 'PATH_QUERY' | 'PATH_QUERY_USER';
  browserTtl?: number;  // seconds — if set, emits Cache-Control/Age/ETag headers
}

interface APIRoute {
  path: string;
  methods: HttpMethod[];
  bypass?: string[];
  resolveUser?: boolean;  // When AUTH is bypassed, still resolve user identity if token present
  authorization?: APIAuthorization[];
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;
}

interface API{
    name: string;
    description: string;
    routes: APIRoute[];
}

interface Service{
    name: string;
    host: string;
    port: number;
}

interface APIConfig {
  service: Service;
  apis: API[];
}

export type { APIConfig, APIRoute, APIAuthorization, API, HttpMethod, Service, RateLimitConfig, CacheConfig };