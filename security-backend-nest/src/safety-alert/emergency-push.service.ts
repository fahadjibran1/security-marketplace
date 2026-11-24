import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { revokeDeadPushDevice } from '../welfare-push/push-device-lifecycle';
import { ExpoPushClient, ExpoPushMessage } from '../welfare-push/expo-push.client';
import {
  EMERGENCY_PUSH_CHANNEL,
  EMERGENCY_PUSH_KIND,
  EMERGENCY_PUSH_TTL_SECONDS,
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
export class EmergencyPushService {
  private readonly logger = new Logger('EmergencyPush');

  constructor(
    private readonly dataSource: DataSource,
    private readonly expo: ExpoPushClient,
    private readonly auditLogService: AuditLogService,
    private readonly config: ConfigService,
  ) {}

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
