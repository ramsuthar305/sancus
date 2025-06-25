import winston from 'winston';
import httpContext from 'express-http-context';

const getLogger = () => {
  return winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
      winston.format.errors({ stack: true }),
      winston.format.metadata(),
      winston.format.printf((info:any) => `[${info.metadata.service}: ${info.metadata.timestamp} ${info.metadata.context}] ${info.level}: ${info.message}}]`)
    ),
    defaultMeta: { service: 'Sancus', context: httpContext.get('headers') },
    transports: [new winston.transports.Console()]
  });
};

export default getLogger;
