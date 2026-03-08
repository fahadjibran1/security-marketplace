import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors();

  const port = Number(process.env.PORT || 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Security MVP backend running on http://localhost:${port}`);
}

bootstrap();
