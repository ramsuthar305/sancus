type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'CONNECT' | 'TRACE';

interface APIAuthorization {
  methods: HttpMethod[];
}

interface RateLimitConfig {
  perMinute?: number;
  perDay?: number;
  key?: 'API_KEY' | 'USER' | 'IP' | 'USER_OR_IP' | 'IP_USER';
  group?: string;        // share one quota across every route using the same group name
  hideHeaders?: boolean; // do not emit X-RateLimit-* / RateLimit-* to clients
}

interface CacheConfig {
  strategy: 'LRU' | 'LFU' | 'SWR';
  ttl: number;
  key?: 'PATH' | 'PATH_QUERY' | 'PATH_QUERY_USER';
  browserTtl?: number;     // seconds — if set, emits Cache-Control to the client
  varyHeaders?: string[];  // request headers folded into the cache key
  statusCodes?: number[];  // cacheable upstream statuses (default 200, 301, 404)
  shared?: boolean;        // required to share one cached answer between users on a route that knows the user
}

interface HeaderRules {
  add?: Record<string, string>;
  remove?: string[];
}

interface CircuitBreakerConfig {
  errorThresholdPercentage?: number; // default 50
  volumeThreshold?: number;          // min requests in window before it can open (default 10)
  resetTimeout?: number;             // ms open before half-open probe (default 30000)
}

// { policyName: policyConfig } — resolved against the policy registry at load time
type PolicyMap = Record<string, unknown>;

interface APIRoute {
  path: string;
  methods: HttpMethod[];
  bypass?: string[];
  resolveUser?: boolean;  // When AUTH is bypassed, still resolve user identity if token present
  authorization?: APIAuthorization[];
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;
  headers?: HeaderRules;  // request headers added/removed before proxying
  policies?: PolicyMap;
}

interface API {
  name: string;
  description: string;
  routes: APIRoute[];
}

interface Service {
  name: string;
  host?: string;     // env var holding the upstream base URL (legacy single-node form)
  port?: number;
  nodes?: string[];  // upstream base URLs, round-robin with passive health
  hosts?: string[];  // if set, only requests whose Host header matches are routed here
  rewrite?: { from: string; to: string }; // regex applied to the upstream path
  timeout?: number;  // ms, upstream response timeout (default 60000)
  retries?: number;  // idempotent methods only, on connection errors (default 0)
  circuitBreaker?: CircuitBreakerConfig;
  headers?: HeaderRules;
  policies?: PolicyMap;
}

interface APIConfig {
  service: Service;
  apis: API[];
}

export type {
  APIConfig, APIRoute, APIAuthorization, API, HttpMethod, Service,
  RateLimitConfig, CacheConfig, HeaderRules, CircuitBreakerConfig, PolicyMap,
};
