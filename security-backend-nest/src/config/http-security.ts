import { INestApplication } from '@nestjs/common';
import helmet, { HelmetOptions } from 'helmet';
import { NextFunction, Request, Response } from 'express';

const ONE_YEAR_SECONDS = 31_536_000;

export function buildHelmetOptions(env: NodeJS.ProcessEnv): HelmetOptions {
  const production = env.NODE_ENV === 'production';

  return {
    contentSecurityPolicy: production
      ? {
          useDefaults: false,
          directives: {
            defaultSrc: ["'none'"],
            frameAncestors: ["'none'"],
          },
        }
      : false,
    strictTransportSecurity: production
      ? {
          maxAge: ONE_YEAR_SECONDS,
          includeSubDomains: false,
          preload: false,
        }
      : false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  };
}

export function configureHttpSecurity(app: INestApplication, env: NodeJS.ProcessEnv): void {
  const httpAdapter = app.getHttpAdapter().getInstance();
  httpAdapter.disable('x-powered-by');
  app.use(helmet(buildHelmetOptions(env)));
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
}
