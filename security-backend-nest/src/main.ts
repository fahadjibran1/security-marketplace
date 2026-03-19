import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT || 3000);
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  const enableSwagger = (process.env.ENABLE_SWAGGER || 'true').toLowerCase() === 'true';

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.enableCors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((origin) => origin.trim()),
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
  console.log(`Security MVP backend running on http://localhost:${port}`);
  if (enableSwagger) {
    console.log(`Swagger docs available at http://localhost:${port}/api-docs`);
  }
}

bootstrap();
