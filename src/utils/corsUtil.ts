import { Request, Response } from "express";

abstract class CorsHandler {
  // Comma-separated list, e.g. ALLOWED_ORIGINS="https://app.example.com,https://example.com"
  // Entries wrapped in slashes are treated as regexes, e.g. "/\\.example\\.com$/"
  protected static allowedOrigins: (string | RegExp)[] = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => (o.startsWith("/") && o.endsWith("/") ? new RegExp(o.slice(1, -1)) : o));

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

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With, Accept, Origin, Cache-Control, X-File-Name, X-Fb-Fbc, X-Fb-Fbp');
  }
}

export default CorsHandler;
