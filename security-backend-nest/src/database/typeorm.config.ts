import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import * as path from 'path';
import { appEntities } from './entities';
import { buildDatabaseSslOptions } from './database-tls.config';

type DatabaseEnv = {
  DATABASE_POOLER_URL?: string;
  DATABASE_URL?: string;
  DATABASE_SSL?: string;
  DATABASE_CA_CERT?: string;
  NODE_ENV?: string;
  DATABASE_SYNCHRONIZE?: string;
  DATABASE_HOST?: string;
  DATABASE_PORT?: string;
  DATABASE_USER?: string;
  DATABASE_PASSWORD?: string;
  DATABASE_NAME?: string;
  DATABASE_POOL_IDLE_TIMEOUT_MS?: string;
};

/**
 * How long an unused pooled connection is kept before it is closed. Unset: 30 s, as it has always been.
 * Opening a connection through the production pooler costs several cross-region round trips, and the
 * dashboard refreshes every 60 s, so 30 s closes and reopens connections on every refresh; this lets
 * that be tuned from pool diagnostics evidence without a code change. Bounded to 10 s – 10 min. It
 * changes how long connections are kept, never how many (max stays 10).
 */
export function poolIdleTimeoutMillis(value: string | undefined): number {
  const parsed = Number(value);
  if (value == null || value.trim() === '' || !Number.isFinite(parsed)) return 30000;
  return Math.min(600000, Math.max(10000, Math.round(parsed)));
}

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
  const connectionUrl = env.DATABASE_POOLER_URL || env.DATABASE_URL;
  const ssl = buildDatabaseSslOptions(env);

  const shared: Pick<
    PostgresConnectionOptions,
    'type' | 'entities' | 'migrations' | 'migrationsTableName' | 'synchronize' | 'extra'
  > = {
    type: 'postgres',
    entities: appEntities,
    migrations: [path.join(__dirname, 'migrations', '*{.ts,.js}')],
    migrationsTableName: 'typeorm_migrations',
    synchronize,
    extra: {
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: poolIdleTimeoutMillis(env.DATABASE_POOL_IDLE_TIMEOUT_MS),
      max: 10,
      keepAlive: true,
    },
  };

  if (connectionUrl) {
    return {
      ...shared,
      url: connectionUrl,
      ssl,
    };
  }

  return {
    ...shared,
    host: env.DATABASE_HOST ?? 'localhost',
    port: parseInt(env.DATABASE_PORT ?? '5432', 10),
    username: env.DATABASE_USER ?? 'postgres',
    password: env.DATABASE_PASSWORD ?? 'postgres',
    database: env.DATABASE_NAME ?? 'security_mvp',
    ssl,
  };
}

export function buildNestTypeOrmOptions(env: DatabaseEnv): TypeOrmModuleOptions {
  return buildTypeOrmOptions(env) as TypeOrmModuleOptions;
}
