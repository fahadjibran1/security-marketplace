import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import * as path from 'path';
import { appEntities } from './entities';

type DatabaseEnv = {
  DATABASE_URL?: string;
  DATABASE_SSL?: string;
  NODE_ENV?: string;
  DATABASE_SYNCHRONIZE?: string;
  DATABASE_HOST?: string;
  DATABASE_PORT?: string;
  DATABASE_USER?: string;
  DATABASE_PASSWORD?: string;
  DATABASE_NAME?: string;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') {
    return fallback;
  }

  return value.toLowerCase() === 'true';
}

export function buildTypeOrmOptions(env: DatabaseEnv): DataSourceOptions {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const synchronize = parseBoolean(
    env.DATABASE_SYNCHRONIZE,
    nodeEnv === 'production' ? false : true
  );
  const databaseSsl = parseBoolean(env.DATABASE_SSL, false);

  const shared: Pick<
    PostgresConnectionOptions,
    'type' | 'entities' | 'migrations' | 'migrationsTableName' | 'synchronize'
  > = {
    type: 'postgres',
    entities: appEntities,
    migrations: [path.join(__dirname, 'migrations', '*{.ts,.js}')],
    migrationsTableName: 'typeorm_migrations',
    synchronize,
  };

  if (env.DATABASE_URL) {
    return {
      ...shared,
      url: env.DATABASE_URL,
      ssl: databaseSsl ? { rejectUnauthorized: false } : false,
    };
  }

  return {
    ...shared,
    host: env.DATABASE_HOST ?? 'localhost',
    port: parseInt(env.DATABASE_PORT ?? '5432', 10),
    username: env.DATABASE_USER ?? 'postgres',
    password: env.DATABASE_PASSWORD ?? 'postgres',
    database: env.DATABASE_NAME ?? 'security_mvp',
  };
}

export function buildNestTypeOrmOptions(env: DatabaseEnv): TypeOrmModuleOptions {
  return buildTypeOrmOptions(env) as TypeOrmModuleOptions;
}
