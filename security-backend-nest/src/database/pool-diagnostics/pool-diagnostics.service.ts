import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { readPoolDiagnosticsConfig } from './pool-diagnostics.config';
import { PoolDiagnostics, PoolLike, setActivePoolDiagnostics } from './pool-diagnostics';

/**
 * Attaches pool diagnostics to TypeORM's node-postgres pool when DB_POOL_DIAGNOSTICS is enabled.
 * Disabled (the default): does nothing at all — no hooks, no timer, no log lines.
 */
@Injectable()
export class PoolDiagnosticsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('DbPool');
  private diagnostics: PoolDiagnostics | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dataSource: DataSource) {}

  onApplicationBootstrap() {
    const config = readPoolDiagnosticsConfig(process.env);
    if (!config.enabled) return;

    const pool = (this.dataSource.driver as unknown as { master?: PoolLike }).master;
    if (!pool || typeof pool.connect !== 'function' || typeof pool.on !== 'function') {
      this.logger.warn(JSON.stringify({ event: 'db_pool_diagnostics_unavailable', reason: 'no node-postgres pool' }));
      return;
    }

    this.diagnostics = new PoolDiagnostics(pool, config, (level, event, payload) => {
      const line = JSON.stringify({ event, ...payload });
      if (level === 'warn') this.logger.warn(line);
      else this.logger.log(line);
    }).attach();
    setActivePoolDiagnostics(this.diagnostics);

    this.timer = setInterval(() => this.diagnostics?.snapshot(), config.snapshotIntervalMs);
    this.timer.unref?.();

    const options = pool.options ?? {};
    this.logger.log(
      JSON.stringify({
        event: 'db_pool_diagnostics_enabled',
        max: options.max ?? null,
        connectionTimeoutMillis: options.connectionTimeoutMillis ?? null,
        idleTimeoutMillis: options.idleTimeoutMillis ?? null,
        slowAcquireMs: config.slowAcquireMs,
        longHoldMs: config.longHoldMs,
        snapshotIntervalMs: config.snapshotIntervalMs,
        maxEventsPerMinute: config.maxEventsPerMinute,
      }),
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.diagnostics?.detach();
    this.diagnostics = null;
    setActivePoolDiagnostics(null);
  }
}
