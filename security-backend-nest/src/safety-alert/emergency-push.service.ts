import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { revokeDeadPushDevice } from '../welfare-push/push-device-lifecycle';
import { ExpoPushClient, ExpoPushMessage } from '../welfare-push/expo-push.client';
import { EMERGENCY_PUSH_RECOVERY_LOCK_NAMESPACE } from '../operations/advisory-locks';
import { SingleFlightJob } from '../scheduler/single-flight-job';
import {
  EMERGENCY_PUSH_CHANNEL,
  EMERGENCY_PUSH_KIND,
  EMERGENCY_PUSH_RECOVERY_INTERVAL_MS,
  EMERGENCY_PUSH_RECOVERY_MAX_AGE_SECONDS,
  EMERGENCY_PUSH_RECOVERY_MIN_AGE_SECONDS,
  EMERGENCY_PUSH_TTL_SECONDS,
  emergencyNotificationText,
  emergencyRecipientUserIds,
} from './emergency-alert';

export type EmergencyPushOutcome = {
  devices: number;
  providerAccepted: number;
  providerRejected: number;
  transportFailed: boolean;
  devicesRevoked: number;
  skipped: 'disabled' | 'no_devices' | null;
};

/**
 * S4-EM-01: push for an Emergency, to the registered phones of the people responsible for responding (the same people who
 * got the in-app notification inside the alert's transaction).
 *
 * Runs AFTER the alert has committed and never throws: a provider outage can delay a push, it can never lose or roll back
 * the alert, which is already in Live Operations and every responsible person's S4 notifications. The outcome is audited
 * on the alert (counts only: no token, no device, no provider body) so "was anyone's phone notified?" has an answer that
 * is not confused with "did anyone acknowledge it?".
 *
 * Push is attempted wherever it is supported: a responsible person signed in to the S4 app on a phone that allowed
 * notifications. The web portal has no push; it shows the alert and the notification on its next refresh.
 * PUSH_EMERGENCY_ALERTS_ENABLED=false turns the push (only) off; anything else, including unset, leaves it on.
 */
@Injectable()
export class EmergencyPushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EmergencyPush');
  private recoveryJob?: SingleFlightJob;
  private recoveryTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly expo: ExpoPushClient,
    private readonly auditLogService: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.recoveryJob = new SingleFlightJob('emergency-push-recovery', () => this.recoverOwedPushes(), {
      overrunAfterMs: EMERGENCY_PUSH_RECOVERY_INTERVAL_MS * 3,
    });
    this.recoveryTimer = setInterval(() => void this.recoveryJob?.tick(), EMERGENCY_PUSH_RECOVERY_INTERVAL_MS);
    this.recoveryTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryJob?.stop();
  }

  /**
   * Bounded recovery of a push that was owed and never attempted: the process stopped after the Emergency committed
   * (with its 'safety_alert.emergency_push_pending' record) and before the dispatch ran. Runs every minute.
   *
   * Each candidate is claimed in its own transaction under a TRY advisory lock on the alert id: still OPEN, between
   * EMERGENCY_PUSH_RECOVERY_MIN_AGE_SECONDS and _MAX_AGE_SECONDS old, push owed, and no attempt or earlier recovery
   * recorded. The claim ('safety_alert.emergency_push_recovery') commits BEFORE the push, so an Emergency is recovered at
   * most once, even if this process stops again: no duplicate pushes, and nothing stale is pushed late. The push goes to
   * the people responsible NOW (same rule as at raise time). Returns how many were recovered.
   */
  async recoverOwedPushes(): Promise<number> {
    if (!this.enabled()) return 0;
    const candidates: Array<{ id: number | string }> = await this.dataSource.query(
      `SELECT id FROM safety_alerts
        WHERE type = 'panic' AND status = 'open'
          AND "createdAt" < now() - ($1 || ' seconds')::interval
          AND "createdAt" > now() - ($2 || ' seconds')::interval
        ORDER BY id`,
      [String(EMERGENCY_PUSH_RECOVERY_MIN_AGE_SECONDS), String(EMERGENCY_PUSH_RECOVERY_MAX_AGE_SECONDS)],
    );
    let recovered = 0;
    for (const candidate of candidates) {
      const alertId = Number(candidate.id);
      try {
        const claim = await this.dataSource.transaction(async (manager) => {
          const [{ locked }] = await manager.query('SELECT pg_try_advisory_xact_lock($1, $2) AS locked', [
            EMERGENCY_PUSH_RECOVERY_LOCK_NAMESPACE,
            alertId,
          ]);
          if (!locked) return null;
          const actions: Array<{ action: string }> = await manager.query(
            `SELECT action FROM audit_logs WHERE "entityType" = 'safety_alert' AND "entityId" = $1
               AND action IN ('safety_alert.emergency_push_pending', 'safety_alert.emergency_push_attempted',
                              'safety_alert.emergency_push_recovery')`,
            [alertId],
          );
          const seen = new Set(actions.map((a) => a.action));
          if (!seen.has('safety_alert.emergency_push_pending')) return null;
          if (seen.has('safety_alert.emergency_push_attempted') || seen.has('safety_alert.emergency_push_recovery')) return null;
          const [alert] = await manager.query(
            `SELECT a.id, a."companyId", a.status, EXTRACT(EPOCH FROM (now() - a."createdAt"))::int AS "ageSeconds",
                    g."fullName" AS "guardName", COALESCE(s.name, sh."siteName") AS "siteName"
               FROM safety_alerts a
               LEFT JOIN guard_profiles g ON g.id = a."guardId"
               LEFT JOIN shifts sh ON sh.id = a."shiftId"
               LEFT JOIN sites s ON s.id = sh."siteId"
              WHERE a.id = $1 AND a.status = 'open'`,
            [alertId],
          );
          if (!alert) return null;
          const companyId = Number(alert.companyId);
          const recipients = await emergencyRecipientUserIds(manager, companyId);
          const devices = await this.activeDevices(recipients, manager);
          await this.auditLogService.logInTransaction(manager, {
            company: { id: companyId },
            user: null,
            action: 'safety_alert.emergency_push_recovery',
            entityType: 'safety_alert',
            entityId: alertId,
            afterData: { ageSeconds: Number(alert.ageSeconds), devices: devices.length },
          });
          return { companyId, devices, text: emergencyNotificationText(alert.guardName, alert.siteName) };
        });
        if (!claim) continue;
        await this.dispatch({
          alertId,
          companyId: claim.companyId,
          title: claim.text.title,
          body: claim.text.pushBody,
          devices: claim.devices,
        });
        recovered += 1;
      } catch (error) {
        this.logger.error(JSON.stringify({ event: 'emergency_push_recovery_failed', alertId, reason: error instanceof Error ? error.name : 'unknown' }));
      }
    }
    return recovered;
  }

  enabled(): boolean {
    return String(this.config.get<string>('PUSH_EMERGENCY_ALERTS_ENABLED') ?? '').trim().toLowerCase() !== 'false';
  }

  /** Active push devices of these users: the count the Guard is told will be attempted. */
  async activeDevices(
    userIds: number[],
    runner: Pick<EntityManager, 'query'> = this.dataSource,
  ): Promise<Array<{ id: number; token: string; userId: number }>> {
    if (!userIds.length || !this.enabled()) return [];
    const rows = await runner.query(
      `SELECT id, token, "userId" FROM push_devices WHERE "userId" = ANY($1::int[]) AND "revokedAt" IS NULL ORDER BY id`,
      [userIds],
    );
    return (rows as Array<{ id: number | string; token: string; userId: number | string }>)
      .map((r) => ({ id: Number(r.id), token: String(r.token), userId: Number(r.userId) }));
  }

  async dispatch(input: {
    alertId: number;
    companyId: number;
    title: string;
    body: string;
    devices: Array<{ id: number; token: string }>;
  }): Promise<EmergencyPushOutcome> {
    const outcome: EmergencyPushOutcome = {
      devices: input.devices.length, providerAccepted: 0, providerRejected: 0, transportFailed: false, devicesRevoked: 0,
      skipped: !this.enabled() ? 'disabled' : input.devices.length ? null : 'no_devices',
    };
    try {
      if (!outcome.skipped) {
        const valid = input.devices.filter((d) => ExpoPushClient.isExpoToken(d.token));
        const messages: ExpoPushMessage[] = valid.map((device) => ({
          to: device.token,
          title: input.title,
          body: input.body,
          data: { kind: EMERGENCY_PUSH_KIND, alertId: input.alertId },
          sound: 'default',
          priority: 'high',
          channelId: EMERGENCY_PUSH_CHANNEL,
          ttl: EMERGENCY_PUSH_TTL_SECONDS,
        }));
        outcome.providerRejected += input.devices.length - valid.length;
        try {
          const tickets = messages.length ? await this.expo.send(messages) : [];
          for (let i = 0; i < tickets.length; i += 1) {
            const ticket = tickets[i];
            if (ticket.status === 'ok') outcome.providerAccepted += 1;
            else {
              outcome.providerRejected += 1;
              if (ticket.error === 'DeviceNotRegistered') outcome.devicesRevoked += await revokeDeadPushDevice(this.dataSource, valid[i].id);
            }
          }
        } catch {
          outcome.transportFailed = true;
        }
      }
      await this.auditLogService.log({
        company: { id: input.companyId },
        user: null,
        action: 'safety_alert.emergency_push_attempted',
        entityType: 'safety_alert',
        entityId: input.alertId,
        afterData: { ...outcome },
      });
    } catch (error) {
      this.logger.error(JSON.stringify({ event: 'emergency_push_record_failed', alertId: input.alertId, reason: error instanceof Error ? error.name : 'unknown' }));
    }
    this.logger.log(JSON.stringify({ event: 'emergency_push', alertId: input.alertId, ...outcome }));
    return outcome;
  }
}
