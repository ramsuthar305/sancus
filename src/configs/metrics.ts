import client from 'prom-client';

// One registry, exposed at GET /metrics. Names follow the Kong/Traefik convention:
// <gateway>_http_requests_total, <gateway>_*_duration_seconds, <gateway>_config_reloads_total.
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const httpRequestsTotal = new client.Counter({
  name: 'sancus_http_requests_total',
  help: 'Requests handled by the gateway',
  labelNames: ['service', 'route', 'method', 'code'] as const,
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: 'sancus_http_request_duration_seconds',
  help: 'Total time from request received to response finished',
  labelNames: ['service', 'route', 'method', 'code'] as const,
  buckets: durationBuckets,
  registers: [registry],
});

export const upstreamDuration = new client.Histogram({
  name: 'sancus_upstream_duration_seconds',
  help: 'Time waiting for the upstream response headers',
  labelNames: ['service', 'route', 'method', 'code'] as const,
  buckets: durationBuckets,
  registers: [registry],
});

export const upstreamUp = new client.Gauge({
  name: 'sancus_upstream_up',
  help: '1 when the upstream node is considered healthy',
  labelNames: ['service', 'node'] as const,
  registers: [registry],
});

export const configReloads = new client.Counter({
  name: 'sancus_config_reloads_total',
  help: 'api_configs reloads',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const cacheEvents = new client.Counter({
  name: 'sancus_cache_events_total',
  help: 'Response cache outcomes',
  labelNames: ['service', 'status'] as const,
  registers: [registry],
});

export const rateLimited = new client.Counter({
  name: 'sancus_rate_limited_total',
  help: 'Requests rejected with 429',
  labelNames: ['service', 'route', 'scope'] as const,
  registers: [registry],
});
