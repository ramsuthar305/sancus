import _ from 'lodash';
import { Key as PathKey, pathToRegexp } from 'path-to-regexp';
import { Logger } from 'winston';
import getLogger from '../configs/logger';
import { API, APIConfig, APIRoute, HttpMethod } from '../types/api';
import ConfigUtil from '../utils/configFinder';

class APIValidator {
  private apiConfig: APIConfig;
  private logger: Logger;
  

  constructor(apiConfig: APIConfig) {
    this.apiConfig = apiConfig;
    this.logger = getLogger();
  }

  public validateAPIRequest(path: string, method: HttpMethod): APIRoute|void {
      const matchingRoute = ConfigUtil.findMatchingRoute(path, method, this.apiConfig);
      
    if (!matchingRoute) {
      this.logger.error(
        `No matching route found for path '${path}' and method '${method}'`
      );
      return;
    }

    if (!this.isMethodMatch(matchingRoute.methods, method)) {
      this.logger.error(
        `Method '${method}' does not match route '${matchingRoute.methods}'`
      );
      return;
    }
      return matchingRoute;
  }

  private isMethodMatch(
    routeMethods: String[],
    requestMethod: string
  ): boolean {
    return routeMethods.includes(requestMethod.toUpperCase()) || requestMethod === 'OPTIONS';
  }
}

export default APIValidator;
