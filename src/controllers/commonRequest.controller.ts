import { NextFunction, Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import uuid from 'uuid';
import VeritasServiceClient from '../clients/veritasClients';
import getLogger from '../configs/logger';
import APIValidator from '../pipeline_logics/ApiValidator';
import { HttpMethod } from '../types/api';
import ClientResponseStatus from '../types/requestStatus';
import ResponseEnum from '../types/responseEnums';
import { VeritasResponse } from '../types/veritas';
import ConfigUtil from '../utils/configFinder';
import SancusResponse from '../utils/responseUtil';
import UrlUtils from '../utils/urlUtils';
import GeoUtils from '../utils/geoFenceUtil';
import CorsHandler from '../utils/corsUtil';
// import DiscordService from '../utils/discordAlerts';

const geoUtils = GeoUtils.getInstance('./in.json');
geoUtils
  .loadGeoJsonData()
  .then(() => {
    console.log('GeoJSON data loaded successfully.');
  })
  .catch((err) => {
    console.error('Error loading GeoJSON data:', err);
    process.exit(1);
  });

const logger = getLogger();
// const alertService = new DiscordService(
//   process.env.DISCORD_WEBHOOK_URL || '', // Replace with actual webhook URL
//   process.env.ALERTS_ENABLED === 'true' // Enable or disable alerts based on environment
// );

class CommonRequestController {
  constructor() {
    this.isVeritasResponse = this.isVeritasResponse.bind(this); // <- Add this
    this.validateToken = this.validateToken.bind(this); // <- Add this
    this.pipeline = this.pipeline.bind(this); // <- Add this
    this.validateGeofence = this.validateGeofence.bind(this); // <- Add this
  }

  private getHostUrl(serviceDetailsHostId: string): string {
    let hostUrl: string = process.env[serviceDetailsHostId] || '';
    if(!hostUrl) {
      throw new Error(`No host URL found for host ID: ${serviceDetailsHostId}`);
    }
    return hostUrl;
  }

  private isVeritasResponse(
    response: VeritasResponse | ClientResponseStatus
  ): response is VeritasResponse {
    return (
      response instanceof Object &&
      'id' in response &&
      'user_data' in response &&
      'role' in response &&
      'issued_at' in response &&
      'expires_at' in response &&
      'token_type' in response
    );
  }

  private async validateToken(
    token: string
  ): Promise<VeritasResponse | boolean> {
    try {
      const veritasClient = new VeritasServiceClient();
      const response = await veritasClient.callVeritasService(token);

      if (this.isVeritasResponse(response)) {
        return response;
      }

      if (response === ClientResponseStatus.UNAUTHORIZED) {
        return false;
      } else if (response === ClientResponseStatus.BAD_REQUEST) {
        logger.info('Veritas Client failed');
        throw new Error('Veritas client failed');
      }
      throw new Error('Veritas client failed');
    } catch (error: any) {
      console.error('Error calling Veritas service:', error.message);
      throw error; // Rethrow the error to be handled by the caller
    }
  }

  private async validateGeofence(
    req: Request,
    res: Response
  ): Promise<boolean> {
    const coordinates = req.header('X-COORDINATES');
    if (!coordinates) {
      new SancusResponse(ResponseEnum.COORDINATES_MISSING, {}, res);
      return false;
    }

    const [lat, lon] = coordinates.split(',').map(Number);
    if (isNaN(lat) || isNaN(lon)) {
      logger.info(`Unauthorized request: Invalid coordinates.${lat},${lon}`);
      new SancusResponse(ResponseEnum.INVALID_COORDINATES, {}, res);
      return false;
    }

    try {
      const stateName = await geoUtils.findStateName(lat, lon);
      if (stateName) {
        logger.info(
          `Unauthorized request: Banned territory. state: ${stateName}`
        );
        new SancusResponse(ResponseEnum.BANNED_TERRITORY, {}, res);
        return false;
      }
    } catch (err) {
      console.error('Error finding state:', err);
      new SancusResponse(ResponseEnum.INTERNAL_SERVER_ERROR, {}, res);
      return false;
    }
    return true;
  }

  public async pipeline(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<Response | void> {
    try {
      const { originalUrl, method } = req;
      const token = req.headers.authorization;

      const serviceName = UrlUtils.extractServiceName(originalUrl);
      if (!serviceName) {
        return res.status(400).send('Bad Request');
      }

      const apiConfig = ConfigUtil.getApiConfigs(serviceName);
      const serviceDetails = apiConfig.service;
      const baseUrl = UrlUtils.extractPathWithQuery(originalUrl);
      const basePath = UrlUtils.extractPathWithoutQuery(originalUrl);
      if (!baseUrl || !basePath) {
        return res.status(400).send('Bad Request');
      }

      const apiEndpointValidator = new APIValidator(apiConfig);
      const matchingRoute = apiEndpointValidator.validateAPIRequest(
        basePath,
        method as HttpMethod
      );
      if (!matchingRoute) {
        return res.status(400).send('Bad Request');
      }
      logger.info(
        `API structure validation successful for path '${baseUrl}' and method '${method}'`
      );

      let tokenDetails: VeritasResponse;
      const geoFenceCheckRequired =
        !matchingRoute.bypass?.includes('GEO_FENCE');
      if (geoFenceCheckRequired && method !== 'OPTIONS') {
        logger.info('GeoFence validation check exist, validating coordinates.');
        const geoFenceCheck = await this.validateGeofence(req, res);
        if (!geoFenceCheck) {
          logger.info('Unauthorized request: GeoFence validation failed.');
          return;
        }
        logger.info('GeoFence validation successful');
      }
      const authRequired =
        !matchingRoute.bypass?.includes('AUTH') && method !== 'OPTIONS';
      if (authRequired) {
        logger.info('Auth validation check exist, validating token.');
        if (!token) {
          logger.info('Unauthorized request: Token does not exist.');
          CorsHandler.setHeaders(req, res);
          return res.status(401).send('Unauthorized');
        }
        const validationResult = await this.validateToken(token);
        if (!validationResult) {
          logger.info('Unauthorized request: Token is invalid.');
          CorsHandler.setHeaders(req, res);
          return res.status(401).send('Unauthorized');
        }
        if (
          validationResult != true &&
          this.isVeritasResponse(validationResult)
        ) {
          logger.info('Token validated successfully');
          tokenDetails = validationResult;
        }
      }

      let hostUrl: string;
      try {
        hostUrl = this.getHostUrl(serviceDetails.host);
      } catch (error) {
        logger.error(error);
        return res.status(500).send('Internal Server Error');
      }

      const destination = `${hostUrl}${serviceDetails.port !== 80 ? `:${serviceDetails.port}` : ''}`;
      // const destination = `http://localhost:9000/hello`;
      const startTime = Date.now();
      const pathRewrite: Record<string, string> = {};
      pathRewrite[`${originalUrl.split('?')[0]}`] = basePath;
      logger.info(`New destination :${destination}`);
      const proxyMiddleware = createProxyMiddleware({
        target: destination,
        changeOrigin: true,
        pathRewrite,
        onProxyReq: (proxyReq, req, res, options) => {
          const correlationalId = (req as any).correlationalId || uuid.v4();
          logger.info(`Generated correlationId: ${correlationalId}`);

          // Attach the correlational ID to the request object
          (req as any).correlationalId = correlationalId;
          proxyReq.setHeader('Correlation-ID', correlationalId);

          if (authRequired)
            proxyReq.setHeader('X-AUTHORIZED-FOR-ID', tokenDetails.id);
          if (req.body) {
            let bodyData = JSON.stringify(req.body);
            proxyReq.setHeader('Content-Type', 'application/json');
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            proxyReq.write(bodyData);
          }
        },
      //   onProxyRes: async (proxyRes, req, res) => {
      //   const statusCode = proxyRes.statusCode;
      //   const method = proxyRes.method;
      //   const responseTime = Date.now() - startTime; // Calculate response time

      //   // Log destination, response time, and status
      //   logger.info(`Response returned for: ${method} ${destination} with status: ${statusCode}, in: ${responseTime}ms`);

      //   // Send an alert if the status code is in the 5xx range
      //   if (statusCode && statusCode >= 500 && statusCode < 600) {
      //     const heading = 'API Exception Alert';
      //     const message = `Status Code: ${statusCode}\nDestination: ${destination}\nResponse Time: ${responseTime}ms`;
      //     await alertService.sendAlert(heading, message);
      //   }
      // },
      });

      proxyMiddleware(req, res, next);
    } catch (error) {
      next(error);
    }
  }
}

export default CommonRequestController;
