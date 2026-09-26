import fs from 'fs';
import { APIRoute, HttpMethod, Service } from '../types/api';
import UrlUtils from '../utils/urlUtils';
import getLogger from '../configs/logger';
import { loadConfigDir } from '../utils/configValidator';
import { configReloads } from '../configs/metrics';
import AlertService from '../utils/alerts';
import PolicyRegistry from './policyRegistry';

interface CompiledRoute {
  route: APIRoute;
  regex: RegExp | null; // null for exact-match (non-parameterized) routes
  isParameterized: boolean;
}

interface ServiceEntry {
  service: Service;
  compiledRoutes: CompiledRoute[];
}

const logger = getLogger();

class RouteRegistry {
  private static instance: RouteRegistry;
  private registry: Map<string, ServiceEntry> = new Map();
  private watcher?: fs.FSWatcher;
  private reloadTimer?: NodeJS.Timeout;
  public loadedAt?: Date;

  private constructor() {}

  public static getInstance(): RouteRegistry {
    if (!RouteRegistry.instance) {
      RouteRegistry.instance = new RouteRegistry();
    }
    return RouteRegistry.instance;
  }

  /** Validate, compile and atomically swap in every config under `configDir`. Throws on invalid config. */
  public initialize(configDir: string): void {
    const next = new Map<string, ServiceEntry>();
    const policyRegistry = PolicyRegistry.getInstance();
    for (const config of loadConfigDir(configDir)) {
      policyRegistry.compile(config.service, config.service.policies, `service ${config.service.name}`);
      const compiledRoutes: CompiledRoute[] = [];
      for (const api of config.apis) {
        for (const route of api.routes) {
          policyRegistry.compile(route, route.policies, `${config.service.name} ${route.path}`);
          const isParameterized = /{(\w+):(\w+)}/.test(route.path);
          compiledRoutes.push({
            route,
            regex: isParameterized ? UrlUtils.generateApiPathRegex(route.path) : null,
            isParameterized,
          });
        }
      }
      // Exact routes win over parameterized ones regardless of YAML order
      compiledRoutes.sort((a, b) => Number(a.isParameterized) - Number(b.isParameterized));
      next.set(config.service.name, { service: config.service, compiledRoutes });
      logger.info(`RouteRegistry: loaded ${compiledRoutes.length} routes for service "${config.service.name}"`);
    }
    this.registry = next;
    this.loadedAt = new Date();
    logger.info(`RouteRegistry: ${this.registry.size} services active`);
  }

  /** Reload on file changes. Invalid configs are rejected and the previous registry stays live. */
  public watch(configDir: string): void {
    if (this.watcher) return;
    this.watcher = fs.watch(configDir, { persistent: false }, () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        try {
          this.initialize(configDir);
          configReloads.inc({ status: 'success' });
          logger.info('RouteRegistry: config reloaded');
        } catch (e) {
          configReloads.inc({ status: 'error' });
          logger.error({ err: (e as Error).message }, 'RouteRegistry: reload rejected, keeping previous config');
          AlertService.getInstance().alert('config-reload', '⚠️ Config reload rejected', (e as Error).message);
        }
      }, 300);
    });
    logger.info(`RouteRegistry: watching ${configDir}`);
  }

  public close(): void {
    this.watcher?.close();
    clearTimeout(this.reloadTimer);
  }

  public get isLoaded(): boolean {
    return this.registry.size > 0;
  }

  /** Hot-path: look up service details by name. No I/O, no allocation. */
  public getService(serviceName: string): Service | undefined {
    return this.registry.get(serviceName)?.service;
  }

  /** For the /routes introspection endpoint. */
  public listServices(): Array<{ service: Service; routes: APIRoute[] }> {
    return [...this.registry.values()].map((e) => ({ service: e.service, routes: e.compiledRoutes.map((c) => c.route) }));
  }

  /** Hot-path: find the matching route for a given path and method. Uses pre-compiled regexes. */
  public findRoute(serviceName: string, routePath: string, method: HttpMethod): APIRoute | undefined {
    const entry = this.registry.get(serviceName);
    if (!entry) return undefined;

    for (const { route, regex, isParameterized } of entry.compiledRoutes) {
      const routeMatches = isParameterized ? regex!.test(routePath) : routePath === route.path;
      if (routeMatches && (route.methods.includes(method) || method === 'OPTIONS')) {
        return route;
      }
    }
    return undefined;
  }

  /** Methods accepted on a path (any route). Empty means the path is unknown → 404, else → 405. */
  public allowedMethods(serviceName: string, routePath: string): HttpMethod[] {
    const entry = this.registry.get(serviceName);
    if (!entry) return [];
    const methods = new Set<HttpMethod>();
    for (const { route, regex, isParameterized } of entry.compiledRoutes) {
      if (isParameterized ? regex!.test(routePath) : routePath === route.path) {
        route.methods.forEach((m) => methods.add(m));
      }
    }
    return [...methods];
  }
}

export default RouteRegistry;
