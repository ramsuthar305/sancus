import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import _ from 'lodash';
import { Key as PathKey, pathToRegexp } from 'path-to-regexp';
import { APIConfig, HttpMethod, APIRoute, API } from '../types/api';
import UrlUtils from './urlUtils';

class ConfigUtil {
  public static getApiConfigs(serviceName: string): APIConfig {
    const filePath = path.join(
      __dirname,
      `../../api_configs/${serviceName}.yml`
    );
    const fileContents = fs.readFileSync(filePath, 'utf8');
    const apiConfig = yaml.load(fileContents) as APIConfig;

    if (!apiConfig) {
      throw new Error(`Invalid API configuration for service: ${serviceName}`);
    }

    return apiConfig;
  }

  public static findMatchingRoute(
    path: string,
    method: HttpMethod,
    apiConfig: APIConfig
  ): APIRoute | undefined {
    // Iterate through each API in the configuration
    for (const api of apiConfig.apis) {
      // Iterate through each route in the current API
      for (const route of api.routes) {
        // Generate the regex pattern only if the route path contains parameters
        const isParameterized = /{(\w+):(\w+)}/.test(route.path);
        let routeMatches: boolean;

        if (isParameterized) {
          // For paths with parameters, use regex to match
          const routeRegex = UrlUtils.generateApiPathRegex(route.path);
          routeMatches = routeRegex.test(path);
        } else {
          // For paths without parameters, match directly
          routeMatches = path === route.path;
        }

        // Check if the route matches and the HTTP method is correct
        if (routeMatches && (route.methods.includes(method)|| method === 'OPTIONS')) {
          return route;
        }
      }
    }
    // Return undefined if no matching route is found
    return undefined;
  }
}

export default ConfigUtil;
