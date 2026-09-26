import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { APIConfig, APIRoute, HttpMethod, Service } from '../types/api';
import UrlUtils from '../utils/urlUtils';
import getLogger from '../configs/logger';

interface CompiledRoute {
  route: APIRoute;
  regex: RegExp | null; // null for exact-match (non-parameterized) routes
  isParameterized: boolean;
}

interface ServiceEntry {
  service: Service;
  compiledRoutes: CompiledRoute[];
}

class RouteRegistry {
  private static instance: RouteRegistry;
  private registry: Map<string, ServiceEntry> = new Map();

  private constructor() {}

  public static getInstance(): RouteRegistry {
    if (!RouteRegistry.instance) {
      RouteRegistry.instance = new RouteRegistry();
    }
    return RouteRegistry.instance;
  }

  /**
   * Called once at startup. Reads all YAML configs, parses them,
   * and pre-compiles route regexes for fast hot-path lookup.
   */
  public initialize(configDir: string): void {
    const logger = getLogger();
    const files = fs.readdirSync(configDir);
    const yamlFiles = files.filter(
      (file) => path.extname(file) === '.yml' || path.extname(file) === '.yaml'
    );

    for (const file of yamlFiles) {
      const filePath = path.join(configDir, file);
      const fileContents = fs.readFileSync(filePath, 'utf8');
      const config = yaml.load(fileContents) as APIConfig;

      if (!config || !config.service) continue;

      const compiledRoutes: CompiledRoute[] = [];
      for (const api of config.apis) {
        for (const route of api.routes) {
          const isParameterized = /{(\w+):(\w+)}/.test(route.path);
          compiledRoutes.push({
            route,
            regex: isParameterized ? UrlUtils.generateApiPathRegex(route.path) : null,
            isParameterized,
          });
        }
      }

      this.registry.set(config.service.name, {
        service: config.service,
        compiledRoutes,
      });

      logger.info(
        `RouteRegistry: loaded ${compiledRoutes.length} routes for service "${config.service.name}"`
      );
    }

    logger.info(`RouteRegistry: initialized with ${this.registry.size} services`);
  }

  /**
   * Hot-path: look up service details by name. No I/O, no allocation.
   */
  public getService(serviceName: string): Service | undefined {
    return this.registry.get(serviceName)?.service;
  }

  /**
   * Hot-path: find the matching route for a given path and method.
   * Uses pre-compiled regexes — zero allocations per call.
   */
  public findRoute(
    serviceName: string,
    routePath: string,
    method: HttpMethod
  ): APIRoute | undefined {
    const entry = this.registry.get(serviceName);
    if (!entry) return undefined;

    for (const { route, regex, isParameterized } of entry.compiledRoutes) {
      const routeMatches = isParameterized
        ? regex!.test(routePath)
        : routePath === route.path;

      if (routeMatches && (route.methods.includes(method) || method === 'OPTIONS')) {
        return route;
      }
    }

    return undefined;
  }
}

export default RouteRegistry;
