import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { getCorsOrigins, getTrustProxySetting, isSwaggerEnabled } from './config/runtime-env';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT || 3000);
  const enableSwagger = isSwaggerEnabled(process.env);
  const httpAdapter = app.getHttpAdapter().getInstance();
  const requestLogger = new Logger('HTTP');

  httpAdapter.disable('x-powered-by');
  httpAdapter.set('trust proxy', getTrustProxySetting(process.env));

  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = request.header('x-request-id')?.trim() || randomUUID();
    const startedAt = Date.now();

    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    response.on('finish', () => {
      requestLogger.log(
        JSON.stringify({
          event: 'http_request_completed',
          requestId,
          method: request.method,
          path: request.originalUrl,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
        }),
      );
    });

    next();
  });

  app.enableCors({
    origin: getCorsOrigins(process.env),
    credentials: true,
  });

  if (enableSwagger) {
    const config = new DocumentBuilder()
      .setTitle('S4 Security Platform API')
      .setDescription(
        'S4 workforce, operations and compliance API for UK private security companies',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api-docs', app, document);
  }

  await app.listen(port);

  logger.log(
    JSON.stringify({
      event: 'application_started',
      service: 's4-api',
      port,
      environment: process.env.NODE_ENV || 'development',
      swaggerEnabled: enableSwagger,
    }),
  );
}

bootstrap().catch((error: unknown) => {
  logger.error(
    JSON.stringify({
      event: 'application_start_failed',
      service: 's4-api',
      message: error instanceof Error ? error.message : String(error),
    }),
    error instanceof Error ? error.stack : undefined,
  );
  process.exit(1);
});
