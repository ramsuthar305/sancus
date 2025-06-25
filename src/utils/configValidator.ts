import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { Logger } from 'winston';
import getLogger from '../configs/logger';
import { APIConfig, Service } from '../types/api';
import { forEach, some } from 'lodash';

// This util is to check if all the API configuration files are valid.
// If any of the files are invalid, the server will not start.
// This util is called from src/index.ts
class APIConfigValidator {
  private folderPath: string;
  private logger: Logger = getLogger();

  constructor(folderPath: string) {
    this.folderPath = folderPath;
  }

  public validateAllFiles(): void {
    // Read all the yaml files from the folder and validate them
    const files = fs.readdirSync(this.folderPath);
    const yamlFiles = files.filter(
      (file) => path.extname(file) === '.yml' || path.extname(file) === '.yaml'
    );

    for (const file of yamlFiles) {
      const filePath = path.join(this.folderPath, file);
      this.validateFile(filePath);
    }
  }

  private validateFile(filePath: string): void {
    // Read the file and validate the contents
    const fileContents = fs.readFileSync(filePath, 'utf8');

    try {
      const config = yaml.load(fileContents) as APIConfig;
      this.validateAPIConfig(config);
    } catch (error: any) {
      this.logger.error(
        `API configuration file ${filePath} is invalid. Error ${error.message}`
      );
    }
  }

  private isValidServiceConfig(serviceConfig: Service): boolean {
    // Your validation logic for service configuration
    // Example: Check if each service has the required fields
    return serviceConfig.name.length>0 && serviceConfig.host.length>0 && serviceConfig.port!=null;
  }

  private validateAPIConfig(config: APIConfig): void {
    // Check if the config has the required fields of defined types, and if the values are valid

    if (config.service && !this.isValidServiceConfig(config.service)) {
      throw new Error('Service configuration is invalid');
    }

    if (!Array.isArray(config.apis)) {
      throw new Error('API configuration must contain an array of "apis"');
    }

    forEach(config.apis, (api) => {
      if (!api.name || !api.description || !api.routes) {
        throw new Error('API configuration has invalid fields');
      }

      forEach(api.routes, (route) => {
        if (!route.path || !route.methods) {
          throw new Error('API route has invalid fields');
        }

        if (!Array.isArray(route.methods) || route.methods.length === 0) {
          throw new Error('API route methods must be a non-empty array');
        }

        if (some(route.methods, (method) => !this.isValidHTTPMethod(method))) {
          throw new Error(`API route has invalid HTTP method`);
        }

        if (route.bypass && !Array.isArray(route.bypass)) {
          throw new Error('API route bypass must be an array');
        }

        if (route.authorization && !Array.isArray(route.authorization)) {
          throw new Error('API route authorization must be an array');
        }
      });
    });
  }

  private isValidHTTPMethod(method: string): boolean {
    const validMethods = [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
      'CONNECT',
      'TRACE'
    ];
    return validMethods.includes(method);
  }
}

export default APIConfigValidator;
