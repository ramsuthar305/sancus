import morgan from 'morgan';
import { Request, Response, NextFunction } from 'express';
import { v5 as uuid } from 'uuid';

morgan.token('body', (req: Request) => {
  if (req.method === 'POST') return JSON.stringify(req.body);
  return '';
});

// Define a custom token for correlational ID
morgan.token('correlationalId', (req: Request) => {
  return (req as any).correlationalId || 'N/A';
});

const logFormat =
  '[Sancus] :remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" :body Correlational ID: :correlationalId Response Time: :response-time ms';

const correlationMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Generate a correlational ID
  const correlationalId: String = uuid(
    `Sancus|correlationalId|${new Date().getTime().toString()}`,
    "6ba7b811-9dad-11d1-80b4-00c04fd430c8"
  );

  // Attach the correlational ID to the request object
  (req as any).correlationalId = correlationalId; 
  next();
};

const requestFlowLogger = morgan(logFormat);

export { correlationMiddleware, requestFlowLogger };
