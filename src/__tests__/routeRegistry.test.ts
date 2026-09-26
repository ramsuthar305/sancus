import fs from 'fs';
import path from 'path';
import os from 'os';
import RouteRegistry from '../services/routeRegistry';

// Suppress logger output during tests
jest.mock('../configs/logger', () => () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

function writeFixture(dir: string, name: string, content: string) {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

describe('RouteRegistry', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create a fresh temp directory with YAML fixtures for each test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-registry-'));

    writeFixture(tmpDir, 'example.yml', `
service:
  name: example
  host: EXAMPLE_URL
  port: 80

apis:
  - name: User APIs
    description: User management
    routes:
      - path: /api/users/
        methods: [GET, POST]
        bypass: [GEO_FENCE]
      - path: /api/users/{str:pk}/
        methods: [GET, PUT, PATCH, DELETE]
        bypass: [GEO_FENCE]
      - path: /api/trips/{str:trip_id}/slots/{int:slot_id}/
        methods: [GET, POST]
        bypass: [GEO_FENCE]
      - path: /api/login
        methods: [POST]
        bypass: [AUTH, GEO_FENCE]
        cache:
          strategy: LRU
          ttl: 3600
          key: PATH
`);

    writeFixture(tmpDir, 'auth.yml', `
service:
  name: auth
  host: AUTH_URL
  port: 80

apis:
  - name: Token APIs
    description: Token management
    routes:
      - path: /v1/generate/token
        methods: [POST]
        bypass: [AUTH, GEO_FENCE]
      - path: /v1/verify/token
        methods: [POST]
        bypass: [GEO_FENCE]
`);

    // Reset singleton for each test
    (RouteRegistry as any).instance = undefined;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialize()', () => {
    it('should load all YAML configs and register services', () => {
      const registry = RouteRegistry.getInstance();
      registry.initialize(tmpDir);

      expect(registry.getService('example')).toBeDefined();
      expect(registry.getService('auth')).toBeDefined();
    });

    it('should skip non-YAML files', () => {
      writeFixture(tmpDir, 'readme.txt', 'not a yaml file');
      const registry = RouteRegistry.getInstance();
      registry.initialize(tmpDir);

      // Should still only have 2 services
      expect(registry.getService('example')).toBeDefined();
      expect(registry.getService('auth')).toBeDefined();
    });

    it('should handle .yaml extension files', () => {
      writeFixture(tmpDir, 'extra.yaml', `
service:
  name: extra
  host: EXTRA_URL
  port: 8080
apis:
  - name: Extra API
    description: Extra service
    routes:
      - path: /extra/health
        methods: [GET]
`);
      const registry = RouteRegistry.getInstance();
      registry.initialize(tmpDir);

      expect(registry.getService('extra')).toBeDefined();
      expect(registry.getService('extra')!.port).toBe(8080);
    });
  });

  describe('getService()', () => {
    it('should return service details by name', () => {
      const registry = RouteRegistry.getInstance();
      registry.initialize(tmpDir);

      const service = registry.getService('example');
      expect(service).toEqual({
        name: 'example',
        host: 'EXAMPLE_URL',
        port: 80,
      });
    });

    it('should return undefined for unknown service', () => {
      const registry = RouteRegistry.getInstance();
      registry.initialize(tmpDir);

      expect(registry.getService('nonexistent')).toBeUndefined();
    });
  });

  describe('findRoute() — exact match', () => {
    let registry: RouteRegistry;

    beforeEach(() => {
      registry = RouteRegistry.getInstance();
      registry.initialize(tmpDir);
    });

    it('should match exact route with correct method', () => {
      const route = registry.findRoute('example', '/api/users/', 'GET');
      expect(route).toBeDefined();
      expect(route!.path).toBe('/api/users/');
      expect(route!.methods).toContain('GET');
    });

    it('should match exact route with POST method', () => {
      const route = registry.findRoute('example', '/api/login', 'POST');
      expect(route).toBeDefined();
      expect(route!.path).toBe('/api/login');
    });

    it('should return undefined for wrong method', () => {
      const route = registry.findRoute('example', '/api/login', 'GET');
      expect(route).toBeUndefined();
    });

    it('should return undefined for non-matching path', () => {
      const route = registry.findRoute('example', '/api/nonexistent/', 'GET');
      expect(route).toBeUndefined();
    });

    it('should return undefined for unknown service', () => {
      const route = registry.findRoute('unknown', '/api/users/', 'GET');
      expect(route).toBeUndefined();
    });

    it('should match OPTIONS method for any route', () => {
      const route = registry.findRoute('example', '/api/users/', 'OPTIONS');
      expect(route).toBeDefined();
      expect(route!.path).toBe('/api/users/');
    });
  });

  describe('findRoute() — parameterized routes', () => {
    let registry: RouteRegistry;

    beforeEach(() => {
      registry = RouteRegistry.getInstance();
      registry.initialize(tmpDir);
    });

    it('should match {str:pk} parameter', () => {
      const route = registry.findRoute('example', '/api/users/abc123/', 'GET');
      expect(route).toBeDefined();
      expect(route!.path).toBe('/api/users/{str:pk}/');
    });

    it('should match {str:pk} with special characters', () => {
      const route = registry.findRoute('example', '/api/users/abc-def_123/', 'PATCH');
      expect(route).toBeDefined();
      expect(route!.path).toBe('/api/users/{str:pk}/');
    });

    it('should match multiple parameters ({str:trip_id} and {int:slot_id})', () => {
      const route = registry.findRoute('example', '/api/trips/trip123/slots/42/', 'GET');
      expect(route).toBeDefined();
      expect(route!.path).toBe('/api/trips/{str:trip_id}/slots/{int:slot_id}/');
    });

    it('should not match int parameter with non-numeric value', () => {
      const route = registry.findRoute('example', '/api/trips/trip123/slots/abc/', 'GET');
      expect(route).toBeUndefined();
    });

    it('should not match parameterized route with extra path segments', () => {
      const route = registry.findRoute('example', '/api/users/abc123/extra/', 'GET');
      expect(route).toBeUndefined();
    });

    it('should return route with all properties preserved', () => {
      const route = registry.findRoute('example', '/api/login', 'POST');
      expect(route).toBeDefined();
      expect(route!.bypass).toEqual(['AUTH', 'GEO_FENCE']);
      expect(route!.cache).toEqual({
        strategy: 'LRU',
        ttl: 3600,
        key: 'PATH',
      });
    });
  });

  describe('findRoute() — cross-service isolation', () => {
    it('should accept HEAD wherever GET is allowed', () => {
      const registry = RouteRegistry.getInstance();
      registry.initialize(tmpDir);
      expect(registry.findRoute('example', '/api/users/', 'HEAD')).toBeDefined();
      expect(registry.findRoute('auth', '/v1/generate/token', 'HEAD')).toBeUndefined();
      expect(registry.allowedMethods('example', '/api/users/')).toContain('HEAD');
    });

    it('should not find example routes in auth service', () => {
      const registry = RouteRegistry.getInstance();
      registry.initialize(tmpDir);

      const route = registry.findRoute('auth', '/api/users/', 'GET');
      expect(route).toBeUndefined();
    });

    it('should find auth routes only in auth service', () => {
      const registry = RouteRegistry.getInstance();
      registry.initialize(tmpDir);

      const route = registry.findRoute('auth', '/v1/generate/token', 'POST');
      expect(route).toBeDefined();
      expect(route!.path).toBe('/v1/generate/token');
    });
  });

  describe('singleton behavior', () => {
    it('should return the same instance', () => {
      const a = RouteRegistry.getInstance();
      const b = RouteRegistry.getInstance();
      expect(a).toBe(b);
    });
  });
});
