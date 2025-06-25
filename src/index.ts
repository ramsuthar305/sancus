// import 'newrelic';
import bodyParser from 'body-parser';
import express, { Express, Request, Response } from 'express';
import httpContext from 'express-http-context';
import path from 'path';
import getLogger from './configs/logger';
import { correlationMiddleware, requestFlowLogger } from './middlewares/requestLogger';
import APIConfigValidator from './utils/configValidator';
import CommonRequestRoute from './routes/commonRequest.route';
import GeoFenceRoute from './routes/geoFenceRequest.route';
import { createProxyServer } from 'http-proxy';


const apiConfigValidator = new APIConfigValidator(
  path.join(__dirname, '..', 'api_configs')
);
apiConfigValidator.validateAllFiles();

const app: Express = express();
const proxy = createProxyServer();
const port = 3000;

app.use(bodyParser.urlencoded({ extended: false }));

// parse application/json
app.use(bodyParser.json());
app.use(correlationMiddleware);
app.use(requestFlowLogger);
app.use(httpContext.middleware);


app.use((req: Request, res: Response, next: Function) => {
  httpContext.set('headers', req.headers);
  next();
});

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'UP' });
});
app.use('/api/geo', GeoFenceRoute);
app.use('/api/*', CommonRequestRoute);

app.listen(port, () => {
  const logger = getLogger();
  logger.info(`⚡️[server]: Server is running at http://localhost:${port}`);
});
