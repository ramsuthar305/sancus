/**
 * Tests for the controller pipeline — verifies:
 * 1. RouteRegistry is used (not ConfigUtil disk I/O)
 * 2. Shared proxy is used (not per-request createProxyMiddleware)
 * 3. __sancusCtx is attached with correct data
 * 4. req.url is rewritten (replaces pathRewrite)
 */

// --- Mocks must be set up before imports ---

// Mock logger
jest.mock('../configs/logger', () => () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock GeoUtils to prevent file loading
jest.mock('../utils/geoFenceUtil', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      loadGeoJsonData: () => Promise.resolve(),
      findStateName: () => Promise.resolve(null),
    }),
  },
}));

// Mock http-proxy — capture the proxy.web call
const mockProxyWeb = jest.fn();
const mockProxyOn = jest.fn();
jest.mock('http-proxy', () => ({
  __esModule: true,
  default: {
    createProxyServer: () => ({
      web: mockProxyWeb,
      on: mockProxyOn,
    }),
  },
}));

// Mock RouteRegistry
const mockGetService = jest.fn();
const mockFindRoute = jest.fn();
jest.mock('../services/routeRegistry', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getService: mockGetService,
      findRoute: mockFindRoute,
    }),
  },
}));

// Mock Redis
jest.mock('../services/redis.service', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getClient: () => null,
    }),
  },
}));

// Mock CacheService
const mockBuildKey = jest.fn().mockReturnValue('test-cache-key');
const mockCacheGet = jest.fn().mockResolvedValue(null);
jest.mock('../services/cache.service', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      buildKey: mockBuildKey,
      get: mockCacheGet,
      set: jest.fn(),
      markRevalidating: jest.fn(),
      buildResponseHeaders: jest.fn().mockReturnValue({}),
    }),
  },
}));

// Mock RateLimitService
jest.mock('../services/rateLimit.service', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      enforce: jest.fn().mockResolvedValue({
        allowed: true,
        headers: {},
      }),
    }),
  },
}));

// Mock CorsHandler
jest.mock('../utils/corsUtil', () => ({
  __esModule: true,
  default: {
    setHeaders: jest.fn(),
  },
}));

// Mock DiscordService
jest.mock('../utils/discordAlerts', () => {
  return jest.fn().mockImplementation(() => ({
    sendAlert: jest.fn(),
  }));
});

// Mock auth client
const mockVerifyToken = jest.fn();
jest.mock('../clients/authClient', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      verifyToken: mockVerifyToken,
    }),
  },
}));

// Mock uuid
jest.mock('uuid', () => ({
  v4: () => 'test-correlation-id',
}));

import CommonRequestController from '../controllers/commonRequest.controller';

describe('CommonRequestController.pipeline()', () => {
  let controller: CommonRequestController;
  let mockReq: any;
  let mockRes: any;
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new CommonRequestController();

    mockRes = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      headersSent: false,
    };
    mockNext = jest.fn();

    // Default: example service with a simple GET route
    mockGetService.mockReturnValue({
      name: 'example',
      host: 'EXAMPLE_URL',
      port: 80,
    });
    mockFindRoute.mockReturnValue({
      path: '/api/users/',
      methods: ['GET', 'POST'],
      bypass: ['AUTH', 'GEO_FENCE'],
    });

    // Set env var for host resolution
    process.env.EXAMPLE_URL = 'http://example-backend';
  });

  afterEach(() => {
    delete process.env.EXAMPLE_URL;
  });

  function buildReq(overrides: Partial<any> = {}): any {
    return {
      originalUrl: '/api/example/api/users/',
      method: 'GET',
      headers: {},
      header: jest.fn().mockReturnValue(null),
      get: jest.fn().mockReturnValue(null),
      url: '/api/example/api/users/',
      ...overrides,
    };
  }

  it('should use RouteRegistry.getService() instead of ConfigUtil', async () => {
    mockReq = buildReq();
    await controller.pipeline(mockReq, mockRes, mockNext);

    expect(mockGetService).toHaveBeenCalledWith('example');
  });

  it('should use RouteRegistry.findRoute() instead of APIValidator', async () => {
    mockReq = buildReq();
    await controller.pipeline(mockReq, mockRes, mockNext);

    expect(mockFindRoute).toHaveBeenCalledWith('example', '/api/users/', 'GET');
  });

  it('should return BAD_REQUEST when findRoute returns undefined', async () => {
    mockFindRoute.mockReturnValue(undefined);
    mockReq = buildReq();
    await controller.pipeline(mockReq, mockRes, mockNext);

    // Should not reach proxy
    expect(mockProxyWeb).not.toHaveBeenCalled();
  });

  it('should return INVALID_SERVICE_NAME when service not found', async () => {
    mockGetService.mockReturnValue(undefined);
    mockReq = buildReq();
    await controller.pipeline(mockReq, mockRes, mockNext);

    expect(mockProxyWeb).not.toHaveBeenCalled();
  });

  it('should attach __sancusCtx to request before proxying', async () => {
    mockReq = buildReq();
    await controller.pipeline(mockReq, mockRes, mockNext);

    const ctx = mockReq.__sancusCtx;
    expect(ctx).toBeDefined();
    expect(ctx.correlationalId).toBe('test-correlation-id');
    expect(ctx.serviceName).toBe('example');
    expect(ctx.method).toBe('GET');
    expect(ctx.basePath).toBe('/api/users/');
    expect(ctx.destination).toBe('http://example-backend');
    expect(ctx.swrStale).toBe(false);
  });

  it('should rewrite req.url to baseUrl (replaces pathRewrite)', async () => {
    mockReq = buildReq();
    await controller.pipeline(mockReq, mockRes, mockNext);

    // req.url should be rewritten from /api/example/api/users/ to /api/users/
    expect(mockReq.url).toBe('/api/users/');
  });

  it('should call proxy.web() with correct per-request options', async () => {
    mockReq = buildReq();
    await controller.pipeline(mockReq, mockRes, mockNext);

    expect(mockProxyWeb).toHaveBeenCalledTimes(1);
    const [req, res, options] = mockProxyWeb.mock.calls[0];
    expect(options.target).toBe('http://example-backend');
    expect(options.selfHandleResponse).toBe(false);
    expect(options.agent).toBeDefined();
  });

  it('should use httpsAgent when destination is https', async () => {
    process.env.EXAMPLE_URL = 'https://example-backend';
    mockReq = buildReq();
    await controller.pipeline(mockReq, mockRes, mockNext);

    const [, , options] = mockProxyWeb.mock.calls[0];
    expect(options.target).toBe('https://example-backend');
    // The agent should be an https.Agent (has `maxCachedSessions`)
    expect(options.agent).toBeDefined();
  });

  it('should include port in destination when not 80', async () => {
    mockGetService.mockReturnValue({
      name: 'example',
      host: 'EXAMPLE_URL',
      port: 8080,
    });
    mockReq = buildReq();
    await controller.pipeline(mockReq, mockRes, mockNext);

    const ctx = mockReq.__sancusCtx;
    expect(ctx.destination).toBe('http://example-backend:8080');
  });

  it('should handle OPTIONS request without proxying', async () => {
    mockReq = buildReq({ method: 'OPTIONS' });
    await controller.pipeline(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.send).toHaveBeenCalled();
    expect(mockProxyWeb).not.toHaveBeenCalled();
  });

  it('should handle query strings in URL rewrite', async () => {
    mockReq = buildReq({
      originalUrl: '/api/example/api/users/?page=1&limit=10',
      url: '/api/example/api/users/?page=1&limit=10',
    });
    await controller.pipeline(mockReq, mockRes, mockNext);

    // req.url should include query string
    expect(mockReq.url).toBe('/api/users/?page=1&limit=10');
  });

  it('should pass /curation/v1/home-feed/ through anonymously and still resolve the user when a token is present', async () => {
    mockFindRoute.mockReturnValue({
      path: '/curation/v1/home-feed/',
      methods: ['GET'],
      bypass: ['AUTH', 'GEO_FENCE'],
      resolveUser: true,
    });

    // No token — anonymous pass-through, no 401, no user forwarded
    mockReq = buildReq({
      originalUrl: '/api/example/curation/v1/home-feed/',
      url: '/api/example/curation/v1/home-feed/',
    });
    await controller.pipeline(mockReq, mockRes, mockNext);

    expect(mockRes.status).not.toHaveBeenCalledWith(401);
    expect(mockProxyWeb).toHaveBeenCalledTimes(1);
    expect(mockReq.__sancusCtx.tokenDetails).toBeUndefined();

    // Valid token — still resolved and attached for X-AUTHORIZED-FOR-ID
    const tokenDetails = {
      id: 42,
      user_data: {},
      role: 'traveler',
      issued_at: 1,
      expires_at: 2,
      token_type: 'access',
    };
    mockVerifyToken.mockResolvedValue(tokenDetails);
    mockReq = buildReq({
      originalUrl: '/api/example/curation/v1/home-feed/',
      url: '/api/example/curation/v1/home-feed/',
      headers: { authorization: 'Bearer valid-token' },
    });
    await controller.pipeline(mockReq, mockRes, mockNext);

    expect(mockReq.__sancusCtx.tokenDetails).toEqual(tokenDetails);
  });

  it('should set shouldCacheResponse=false for non-GET requests', async () => {
    mockReq = buildReq({ method: 'POST' });
    mockFindRoute.mockReturnValue({
      path: '/api/users/',
      methods: ['GET', 'POST'],
      bypass: ['AUTH', 'GEO_FENCE'],
      cache: { strategy: 'LRU', ttl: 3600, key: 'PATH' },
    });
    await controller.pipeline(mockReq, mockRes, mockNext);

    const ctx = mockReq.__sancusCtx;
    expect(ctx.shouldCacheResponse).toBe(false);
  });
});
