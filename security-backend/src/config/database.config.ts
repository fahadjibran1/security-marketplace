import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

function asBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function buildDatabaseConfig(config: ConfigService): TypeOrmModuleOptions {
  const databaseUrl = config.get<string>('DATABASE_URL');
  const sslEnabled = asBool(config.get<string>('DATABASE_SSL'), false);

  const base: TypeOrmModuleOptions = {
    type: 'postgres',
    autoLoadEntities: true,
    synchronize: asBool(config.get<string>('DATABASE_SYNCHRONIZE'), true),
    logging: asBool(config.get<string>('DATABASE_LOGGING'), false),
    retryAttempts: Number(config.get<string>('DATABASE_RETRY_ATTEMPTS', '2')),
    retryDelay: Number(config.get<string>('DATABASE_RETRY_DELAY_MS', '1000')),
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  };

  if (databaseUrl) {
    return {
      ...base,
      url: databaseUrl,
    };
  }

  return {
    ...base,
    host: config.get<string>('DATABASE_HOST', 'localhost'),
    port: Number(config.get<string>('DATABASE_PORT', '5432')),
    username: config.get<string>('DATABASE_USER', 'postgres'),
    password: config.get<string>('DATABASE_PASSWORD', 'postgres'),
    database: config.get<string>('DATABASE_NAME', 'security_mvp'),
  };
}
