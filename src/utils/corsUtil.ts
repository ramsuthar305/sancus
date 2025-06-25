import { Request, Response } from "express";

abstract class CorsHandler {
  // Define allowed origins as a protected static property
  protected static allowedOrigins: (string | RegExp)[] = [
    'http://localhost:5173',
    // 'https://example.com', // your domains
    // /\.example\.com$/
  ];

  // Static method to set CORS headers
  public static setHeaders(req: Request, res: Response): void {
    const origin = req.get('Origin'); // Get the origin of the request

    if (
      origin &&
      CorsHandler.allowedOrigins.some((o) =>
        typeof o === 'string' ? o === origin : o.test(origin)
      )
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
}

export default CorsHandler;
