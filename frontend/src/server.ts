import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import crypto from 'crypto';

export function app(): express.Express {
  const server = express();

  server.use(cors({
    origin: ["https://michaelglendinning.com"],
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
  }));

  // Middleware to generate a nonce per request and store it in res.locals
  server.use((req: Request, res: Response, next: NextFunction) => {
    res.locals['cspNonce'] = crypto.randomBytes(32).toString("hex");
    next();
  });

  // Configure Helmet with a relaxed CSP.
  server.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'","'unsafe-inline'", "'unsafe-eval'",
            (req, res) => `'nonce-${(res as Response).locals['cspNonce']}'`
          ],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
            "https://cdn.jsdelivr.net",

            (req, res) => `'nonce-${(res as Response).locals['cspNonce']}'`
          ],
          fontSrc: [
            "'self'",
            "https://fonts.gstatic.com",
            "https://cdn.jsdelivr.net",
            "https://maxcdn.bootstrapcdn.com"
          ],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https:"]
        }
      }
    })
  );
  
  let serverDistFolder: string;
  
  // Check for ESM vs CommonJS environment
  if (typeof __dirname === 'undefined') {
    // ESM
    const modulePath = fileURLToPath(import.meta.url);
    serverDistFolder = dirname(modulePath);
  } else {
    // CommonJS
    serverDistFolder = __dirname;
  }
  
  const browserDistFolder = resolve(serverDistFolder, '../browser');

  server.use(express.static(browserDistFolder, { maxAge: '1y' }));

  server.get('*', (req: Request, res: Response) => {
    res.sendFile(join(browserDistFolder, 'index.html'));
  });

  return server;
}

function run(): void {
  const port = process.env['PORT'] || 4000;
  const server = app();
  server.listen(port, () => {
    console.log(`Node Express server listening on port ${port}`);
  });
}

run();
