import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { getCorsOrigins, getTrustProxySetting, getJwtSecret, isSwaggerEnabled } from './config/runtime-env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT || 3000);
  const enableSwagger = isSwaggerEnabled(process.env);
  const httpAdapter = app.getHttpAdapter().getInstance();

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

  app.use((_: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.enableCors({
    origin: getCorsOrigins(process.env),
    credentials: true,
  });

  if (enableSwagger) {
    const config = new DocumentBuilder()
      .setTitle('Security Marketplace API')
      .setDescription(
        'Backend API for companies, guards, jobs, assignments, shifts, timesheets, attendance, and incidents',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api-docs', app, document);
  }

  await app.listen(port);
  console.log(`Security Marketplace API running on port ${port}`);
  console.log(`JWT secret loaded: ${getJwtSecret(process.env) !== 'super-secret-change-me'}`);
  if (enableSwagger) {
    console.log(`Swagger docs enabled at /api-docs`);
  }
}

bootstrap();
