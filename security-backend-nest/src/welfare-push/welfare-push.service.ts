import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { effectiveAttendance } from '../attendance/effective-attendance';
import { AuditLogService } from '../audit-log/audit-log.service';
import { DailyLog, DailyLogType } from '../daily-log/entities/daily-log.entity';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { WELFARE_ACTION_LOCK_NAMESPACE } from '../operations/advisory-locks';
import { toOperationalCompletions, WELFARE_COMPLETION_LOG_TYPES } from '../operations/operational-completion';
import { OperationalWindowResolution, OperationalWindowState } from '../operations/operational-window.types';
import { WelfareWindowService } from '../operations/welfare-window.service';
import {
  SafetyAlert,
  SafetyAlertPriority,
  SafetyAlertStatus,
  SafetyAlertType,
} from '../safety-alert/entities/safety-alert.entity';
import { SafetyAlertService } from '../safety-alert/safety-alert.service';
import { SingleFlightJob } from '../scheduler/single-flight-job';
import { Shift } from '../shift/entities/shift.entity';
import { ShiftService } from '../shift/shift.service';
import { PushDevice, PushPlatform } from './entities/push-device.entity';
import { WelfareReminder, WelfareReminderKind } from './entities/welfare-reminder.entity';
import { ExpoPushClient, ExpoPushMessage, ExpoPushTransportError } from './expo-push.client';
import { toReminderView, WelfareReminderView } from './welfare-reminder.view';

/** How often the reminder job looks for Welfare windows that have opened. Single-flight; the timer only ticks it. */
export const WELFARE_REMINDER_INTERVAL_MS = 60_000;
/** Delivery attempts per reminder when the provider cannot be reached. Retried only while its window is still due. */
export const WELFARE_REMINDER_MAX_ATTEMPTS = 3;
/** Default minutes before a window ends at which one follow-up is sent if no check has been recorded. 0 = none. */
export const WELFARE_FOLLOW_UP_DEFAULT_MINUTES_BEFORE_END = 10;
/** Repeated Need Help taps within this many minutes return the alert already raised instead of raising another. */
export const NEED_HELP_DEDUPE_MINUTES = 10;
/** At most this many active devices per account; registering another revokes the least recently seen. */
export const MAX_ACTIVE_DEVICES_PER_USER = 5;
/** Expo publishes receipts within about 15 minutes of a ticket. */
const RECEIPT_DELAY_MS = 15 * 60_000;
const RECEIPT_GIVE_UP_MS = 24 * 60 * 60_000;
const STALE_SENDING_MS = 2 * 60_000;
const RETRY_AFTER_MS = 60_000;

/**
 * PUSH_WELFARE_REMINDER_COMPANY_IDS: the companies whose Guards receive reminders, e.g. "9" or "8,9", or exactly "all" for
 * every company (see parseReminderScope). Fail-closed: missing, empty, or any entry that is not a positive whole number
 * means no company at all, never every company.
 */
export function parseReminderCompanyIds(raw: string | undefined | null): number[] {
  const entries = String(raw ?? '').split(',').map((entry) => entry.trim());
  if (entries.every((entry) => entry === '')) return [];
  if (!entries.every((entry) => /^[1-9]\d{0,9}$/.test(entry))) return [];
  return [...new Set(entries.map(Number))].filter((id) => Number.isSafeInteger(id));
}

/** Which companies' Guards receive reminders: every company, or the listed ones (possibly none). */
export type ReminderScope = 'all' | number[];

/**
 * The reminder scope from PUSH_WELFARE_REMINDER_COMPANY_IDS. Exactly "all" (any case, surrounding spaces ignored) is the
 * standard production setting: every company, including companies created later. Anything else is read as a company
 * list by parseReminderCompanyIds, so a typo ("al", "all,9", "*") still means no company. PUSH_WELFARE_REMINDERS_ENABLED
 * remains the global switch above this: while it is not "true", no company receives reminders whatever the scope.
 */
export function parseReminderScope(raw: string | undefined | null): ReminderScope {
  if (String(raw ?? '').trim().toLowerCase() === 'all') return 'all';
  return parseReminderCompanyIds(raw);
}

export const WELFARE_NOTIFICATION_TITLE = 'S4 — Welfare Check';
export const WELFARE_NOTIFICATION_CATEGORY = 'welfare_check';
export const WELFARE_NOTIFICATION_CHANNEL = 'welfare-checks';
export const PUSH_CONFIRMATION_MESSAGE = 'Confirmed safe and on duty from the Welfare Check notification.';
export const NEED_HELP_ALERT_MESSAGE = 'Guard requested help from a Welfare Check notification.';

export function welfareNotificationBody(siteName: string, kind: WelfareReminderKind): string {
  const site = siteName.trim() || 'your site';
  return kind === 'follow_up'
    ? `Your Welfare Check at ${site} is still due. Please confirm that you are safe and on duty.`
    : `Time for your Welfare Check at ${site}. Please confirm that you are safe and on duty.`;
}

/**
 * When the one follow-up for a window becomes due: `minutesBeforeEnd` before the window ends, but never in its first
 * half (a short window gets its follow-up at the half-way point). Null when follow-ups are off.
 */
export function followUpAt(windowStart: Date, windowEnd: Date, minutesBeforeEnd: number): Date | null {
  if (!(minutesBeforeEnd > 0)) return null;
  const start = windowStart.getTime();
  const end = windowEnd.getTime();
  return new Date(Math.max(start + (end - start) / 2, end - minutesBeforeEnd * 60_000));
}

export type WelfareConfirmResult = {
  result: 'recorded' | 'already_recorded';
  shiftId: number;
  windowIndex: number;
  windowStart: string;
  windowEnd: string;
  recordedAt: string | null;
};

export type NeedHelpResult = {
  result: 'raised' | 'already_raised';
  alertId: number;
  shiftId: number;
  raisedAt: string;
};

export type ReminderJobCounters = {
  shiftsChecked: number;
  remindersSent: number;
  noDevice: number;
  failed: number;
  retried: number;
  receiptsChecked: number;
  devicesRevoked: number;
};

type ShiftEvidence = { logs: DailyLog[]; attendance: AttendanceEvent[] };

/** TypeORM returns [rows, count] for UPDATE … RETURNING on PostgreSQL. */
const updatedRows = (result: unknown): unknown[] =>
  Array.isArray(result) && Array.isArray(result[0]) ? result[0] : Array.isArray(result) ? result : [];

const ERROR_CODE =(value: unknown) => String(value ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'unknown';

/**
 * Welfare Check push reminders and the two notification actions (I'm Safe, Need Help).
 *
 * Nothing here changes what a Welfare Check is. The window grid, the grace period, missed-check detection and Control
 * Room escalation stay exactly where they were (WelfareWindowService and the safety sweep). This service only:
 *   - sends a reminder when a window the Guard owes opens, and at most one follow-up, while the server's own window
 *     state says the check is still due (never the phone's clock);
 *   - records "I'm Safe" as the same welfare_check daily log the in-app form writes, at the server's time, once per
 *     window, only for the Guard on duty on that shift;
 *   - raises "Need Help" through the existing panic alert, at most once per ten minutes per shift.
 *
 * A notification sent, delivered or opened is never a confirmation.
 */
@Injectable()
export class WelfarePushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('WelfarePush');
  private reminderJob?: SingleFlightJob;
  private reminderInterval?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @InjectRepository(PushDevice) private readonly deviceRepo: Repository<PushDevice>,
    @InjectRepository(WelfareReminder) private readonly reminderRepo: Repository<WelfareReminder>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(DailyLog) private readonly dailyLogRepo: Repository<DailyLog>,
    @InjectRepository(AttendanceEvent) private readonly attendanceRepo: Repository<AttendanceEvent>,
    private readonly expo: ExpoPushClient,
    private readonly welfareWindowService: WelfareWindowService,
    private readonly guardProfileService: GuardProfileService,
    private readonly shiftService: ShiftService,
    private readonly safetyAlertService: SafetyAlertService,
    private readonly auditLogService: AuditLogService,
  ) {}

  onModuleInit() {
    this.reminderJob = new SingleFlightJob(
      'welfare-push-reminders',
      () =>
        this.runReminderJob().then(
          () => undefined,
          (error) => this.logger.error(`Welfare reminder run failed: ${error?.message || error}`),
        ),
      { overrunAfterMs: 2 * WELFARE_REMINDER_INTERVAL_MS },
    );
    this.reminderInterval = setInterval(() => void this.reminderJob?.tick(), WELFARE_REMINDER_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.reminderInterval) clearInterval(this.reminderInterval);
    this.reminderJob?.stop();
  }

  /** Off unless PUSH_WELFARE_REMINDERS_ENABLED=true. The two actions and device registration work either way. */
  remindersEnabled(): boolean {
    return this.config.get<string>('PUSH_WELFARE_REMINDERS_ENABLED')?.trim().toLowerCase() === 'true';
  }

  /** The companies reminders are sent for: 'all', or the valid ids PUSH_WELFARE_REMINDER_COMPANY_IDS names ([] = none). */
  reminderScope(): ReminderScope {
    return parseReminderScope(this.config.get<string>('PUSH_WELFARE_REMINDER_COMPANY_IDS'));
  }

  private followUpMinutes(): number {
    const raw = this.config.get<string>('WELFARE_REMINDER_FOLLOW_UP_MINUTES_BEFORE_END');
    if (raw === undefined || raw === null || String(raw).trim() === '') return WELFARE_FOLLOW_UP_DEFAULT_MINUTES_BEFORE_END;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.min(value, 120) : WELFARE_FOLLOW_UP_DEFAULT_MINUTES_BEFORE_END;
  }

  // ── Devices ───────────────────────────────────────────────────────────────────────────────────────

  async registerDevice(userId: number, input: { token: string; platform: PushPlatform; appVersion?: string | null }) {
    if (!ExpoPushClient.isExpoToken(input.token)) throw new ConflictException('Not a push token');
    await this.dataSource.transaction(async (manager) => {
      // One row per token: the same phone signing in as someone else moves the row, and a revoked one comes back.
      await manager.query(
        `INSERT INTO push_devices ("userId", token, platform, "appVersion", "lastSeenAt")
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (token) DO UPDATE SET "userId" = EXCLUDED."userId", platform = EXCLUDED.platform,
           "appVersion" = EXCLUDED."appVersion", "lastSeenAt" = now(), "revokedAt" = NULL, "revokedReason" = NULL`,
        [userId, input.token, input.platform, input.appVersion?.slice(0, 32) ?? null],
      );
      await manager.query(
        `UPDATE push_devices SET "revokedAt" = now(), "revokedReason" = 'superseded'
          WHERE id IN (SELECT id FROM push_devices WHERE "userId" = $1 AND "revokedAt" IS NULL
                        ORDER BY "lastSeenAt" DESC, id DESC OFFSET $2)`,
        [userId, MAX_ACTIVE_DEVICES_PER_USER],
      );
    });
    return { registered: true };
  }

  /** The signed-in user's own token only. Unknown or someone else's token: nothing changes, same answer. */
  async unregisterDevice(userId: number, token: string) {
    await this.deviceRepo.query(
      `UPDATE push_devices SET "revokedAt" = now(), "revokedReason" = 'signed_out'
        WHERE token = $1 AND "userId" = $2 AND "revokedAt" IS NULL`,
      [token, userId],
    );
    return { unregistered: true };
  }

  // ── The reminder job ──────────────────────────────────────────────────────────────────────────────

  /** Timer entry point; exposed so tests and operators can drive one run. */
  triggerReminderJob() {
    return this.reminderJob?.tick() ?? Promise.resolve({ ran: false });
  }

  async runReminderJob(now: Date = new Date()): Promise<ReminderJobCounters> {
    const counters: ReminderJobCounters = {
      shiftsChecked: 0, remindersSent: 0, noDevice: 0, failed: 0, retried: 0, receiptsChecked: 0, devicesRevoked: 0,
    };
    if (!this.remindersEnabled()) return counters;
    const scope = this.reminderScope();
    if (scope !== 'all' && !scope.length) return counters;

    // Only shifts a Guard is Booked On to, in the allowed companies (every company when the scope is 'all'). Cancelled,
    // completed (Booked Off) and not-started shifts are never read. Each reminder still goes only to that shift's Guard.
    const shifts = await this.shiftRepo.find({
      where: scope === 'all' ? { status: 'in_progress' } : { status: 'in_progress', company: { id: In(scope) } },
      relations: { company: true, guard: true, assignment: { guard: true }, site: true },
      loadEagerRelations: false,
      order: { start: 'ASC' },
    });
    if (shifts.length) {
      const evidence = await this.evidenceFor(this.dataSource.manager, shifts.map((s) => s.id));
      const existing = await this.reminderRepo.find({ where: { shiftId: In(shifts.map((s) => s.id)) } });
      const byKey = new Map(existing.map((r) => [`${r.shiftId}:${r.windowIndex}:${r.kind}`, r]));
      for (const shift of shifts) {
        counters.shiftsChecked += 1;
        try {
          await this.remindShift(shift, evidence.get(shift.id) ?? { logs: [], attendance: [] }, byKey, now, counters);
        } catch (error) {
          // One shift's failure never stops the others.
          this.logger.error(JSON.stringify({ event: 'welfare_reminder_shift_failed', shiftId: shift.id, reason: (error as Error)?.message }));
        }
      }
    }
    await this.checkReceipts(now, counters);
    if (counters.remindersSent || counters.failed || counters.noDevice || counters.retried || counters.devicesRevoked) {
      this.logger.log(JSON.stringify({ event: 'welfare_reminder_run', ...counters }));
    }
    return counters;
  }

  private async remindShift(
    shift: Shift,
    evidence: ShiftEvidence,
    byKey: Map<string, WelfareReminder>,
    now: Date,
    counters: ReminderJobCounters,
  ) {
    const guard = shift.guard ?? shift.assignment?.guard;
    if (!guard?.id || !shift.company?.id) return;
    const resolution = this.resolve(shift, evidence, now);
    const nowMs = now.getTime();
    // The window the server says is open now and still owed. A window already met (including by a check made in the
    // last minutes of the previous one) is COMPLETED and gets nothing.
    const window = resolution.windows.find(
      (w) => w.applicable && w.state === OperationalWindowState.DUE && w.start.getTime() <= nowMs && nowMs < w.end.getTime(),
    );
    if (!window) return;

    const followUp = followUpAt(window.start, window.end, this.followUpMinutes());
    const opened = byKey.get(`${shift.id}:${window.index}:window_open`);
    const followed = byKey.get(`${shift.id}:${window.index}:follow_up`);

    if (!opened) {
      // Started late (e.g. after a restart) and already past the follow-up point: one reminder, recorded as the
      // window-open one, never two at once.
      await this.sendNew(shift, guard.id, window, 'window_open', now, counters);
      return;
    }
    if (this.retryable(opened, nowMs)) {
      await this.resend(shift, opened, window, now, counters);
      return;
    }
    if (followUp && nowMs >= followUp.getTime()) {
      if (!followed) await this.sendNew(shift, guard.id, window, 'follow_up', now, counters);
      else if (this.retryable(followed, nowMs)) await this.resend(shift, followed, window, now, counters);
    }
  }

  private retryable(reminder: WelfareReminder, nowMs: number): boolean {
    if (reminder.attempts >= WELFARE_REMINDER_MAX_ATTEMPTS) return false;
    const last = reminder.sentAt ? new Date(reminder.sentAt).getTime() : new Date(reminder.createdAt).getTime();
    if (reminder.status === 'failed') return nowMs - last >= RETRY_AFTER_MS;
    // A run that died between deciding and sending leaves 'sending' behind.
    if (reminder.status === 'sending') return nowMs - last >= STALE_SENDING_MS;
    return false;
  }

  private async sendNew(
    shift: Shift,
    guardId: number,
    window: { index: number; start: Date; end: Date },
    kind: WelfareReminderKind,
    now: Date,
    counters: ReminderJobCounters,
  ) {
    // The unique (shiftId, windowIndex, kind) decides: a concurrent or repeated run inserts nothing and sends nothing.
    const inserted = await this.reminderRepo
      .createQueryBuilder()
      .insert()
      .into(WelfareReminder)
      .values({
        shiftId: shift.id, companyId: shift.company!.id, guardId, windowIndex: window.index, kind,
        windowStart: window.start, windowEnd: window.end, status: 'sending', attempts: 1, sentAt: now,
      })
      .orIgnore()
      .returning(['id'])
      .execute();
    const id = inserted.raw?.[0]?.id as number | undefined;
    if (!id) return;
    const reminder = await this.reminderRepo.findOneByOrFail({ id });
    await this.deliver(shift, reminder, window, now, counters);
  }

  private async resend(
    shift: Shift,
    reminder: WelfareReminder,
    window: { index: number; start: Date; end: Date },
    now: Date,
    counters: ReminderJobCounters,
  ) {
    // Claim the retry atomically: only one run moves attempts from N to N + 1.
    const claimed = await this.reminderRepo.query(
      `UPDATE welfare_reminders SET attempts = attempts + 1, status = 'sending', "sentAt" = $3
        WHERE id = $1 AND attempts = $2 AND status IN ('failed', 'sending') RETURNING id`,
      [reminder.id, reminder.attempts, now],
    );
    if (!updatedRows(claimed).length) return;
    counters.retried += 1;
    await this.deliver(shift, { ...reminder, attempts: reminder.attempts + 1 } as WelfareReminder, window, now, counters);
  }

  private async deliver(
    shift: Shift,
    reminder: WelfareReminder,
    window: { index: number; start: Date; end: Date },
    now: Date,
    counters: ReminderJobCounters,
  ) {
    const devices: Array<{ id: number; token: string }> = await this.deviceRepo.query(
      `SELECT d.id, d.token FROM push_devices d JOIN guard_profiles g ON g."userId" = d."userId"
        WHERE g.id = $1 AND d."revokedAt" IS NULL ORDER BY d.id`,
      [reminder.guardId],
    );
    if (!devices.length) {
      counters.noDevice += 1;
      await this.reminderRepo.update(reminder.id, { status: 'no_device', deviceCount: 0 });
      return;
    }
    const ttl = Math.max(60, Math.floor((window.end.getTime() - now.getTime()) / 1000));
    const body = welfareNotificationBody(shift.site?.name || shift.siteName || '', reminder.kind);
    // Identifiers only. The app re-validates everything with the server; nothing here authorises anything.
    const data = {
      kind: 'welfare_check',
      reminderId: reminder.id,
      shiftId: shift.id,
      windowIndex: window.index,
      windowEnd: window.end.toISOString(),
    };
    const messages: ExpoPushMessage[] = devices.map((d) => ({
      to: d.token, title: WELFARE_NOTIFICATION_TITLE, body, data, sound: 'default', priority: 'high',
      channelId: WELFARE_NOTIFICATION_CHANNEL, categoryId: WELFARE_NOTIFICATION_CATEGORY, ttl,
    }));

    try {
      const tickets = await this.expo.send(messages);
      const accepted: Array<{ id: string; deviceId: number }> = [];
      let firstError: string | null = null;
      for (let i = 0; i < tickets.length; i += 1) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') accepted.push({ id: ticket.id, deviceId: devices[i].id });
        else {
          firstError ??= ERROR_CODE(ticket.error);
          if (ticket.error === 'DeviceNotRegistered') {
            counters.devicesRevoked += await this.revokeDevice(devices[i].id, 'device_not_registered');
          }
        }
      }
      await this.reminderRepo.update(reminder.id, {
        status: accepted.length ? 'provider_accepted' : 'provider_rejected',
        deviceCount: devices.length,
        ticketIds: accepted,
        error: firstError,
      });
      if (accepted.length) counters.remindersSent += 1;
      else counters.failed += 1;
    } catch (error) {
      counters.failed += 1;
      const code = error instanceof ExpoPushTransportError ? ERROR_CODE(error.message) : 'transport_error';
      await this.reminderRepo.update(reminder.id, { status: 'failed', deviceCount: devices.length, error: code });
    }
  }

  private async revokeDevice(deviceId: number, reason: string): Promise<number> {
    const result = await this.deviceRepo.query(
      `UPDATE push_devices SET "revokedAt" = now(), "revokedReason" = $2 WHERE id = $1 AND "revokedAt" IS NULL RETURNING id`,
      [deviceId, reason],
    );
    return updatedRows(result).length;
  }

  /** Expo's receipts: what Apple/Google told Expo. Still not the phone, and never a Welfare Check. */
  private async checkReceipts(now: Date, counters: ReminderJobCounters) {
    const due = await this.reminderRepo
      .createQueryBuilder('r')
      .where(`r.status = 'provider_accepted'`)
      .andWhere('r."receiptCheckedAt" IS NULL')
      .andWhere('r."sentAt" <= :ready', { ready: new Date(now.getTime() - RECEIPT_DELAY_MS) })
      .orderBy('r.id', 'ASC')
      .limit(300)
      .getMany();
    if (!due.length) return;
    let receipts: Awaited<ReturnType<ExpoPushClient['receipts']>>;
    try {
      receipts = await this.expo.receipts(due.flatMap((r) => (r.ticketIds ?? []).map((t) => t.id)));
    } catch {
      return; // Next run tries again.
    }
    for (const reminder of due) {
      const tickets = reminder.ticketIds ?? [];
      const found = tickets.map((t) => ({ t, receipt: receipts.get(t.id) })).filter((x) => x.receipt);
      const expired = now.getTime() - new Date(reminder.sentAt ?? reminder.createdAt).getTime() >= RECEIPT_GIVE_UP_MS;
      if (found.length < tickets.length && !expired) continue;
      let error: string | null = null;
      for (const { t, receipt } of found) {
        if (receipt!.status === 'error') {
          error ??= ERROR_CODE(receipt!.error);
          if (receipt!.error === 'DeviceNotRegistered') counters.devicesRevoked += await this.revokeDevice(t.deviceId, 'device_not_registered');
        }
      }
      await this.reminderRepo.update(reminder.id, {
        receiptStatus: found.length ? (error ? 'provider_delivery_error' : 'provider_delivery_ok') : null,
        receiptCheckedAt: now,
        ...(error ? { error } : {}),
      });
      counters.receiptsChecked += 1;
    }
  }

  // ── I'm Safe ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Record "I'm Safe" as a Welfare Check: the same welfare_check daily log the in-app form writes, at the server's
   * time, graded by the same engine. The Guard comes from the session, the shift from the database, the window from the
   * server's clock. Repeats for a window already met record nothing and say so. A reminder whose window has closed is
   * refused: the Guard is asked to confirm the CURRENT check instead.
   */
  async confirmSafe(userId: number, input: { shiftId: number; reminderId?: number }, now?: Date): Promise<WelfareConfirmResult> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    const shift = await this.shiftService.findOne(input.shiftId);
    this.shiftService.assertGuardCanOperateShift(shift, guard.id, 'confirm a Welfare Check');
    const reminder = await this.ownReminder(input.reminderId, shift.id, guard.id);

    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [WELFARE_ACTION_LOCK_NAMESPACE, shift.id]);
      const at = now ?? new Date();
      // Re-read inside the lock: Book Off may have happened since the check above.
      const fresh = await manager.getRepository(Shift).findOne({ where: { id: shift.id }, loadEagerRelations: false, relations: { site: true } });
      if (!fresh || fresh.status !== 'in_progress') {
        throw new ConflictException({ code: 'not_on_duty', message: 'You are not Booked On to this shift, so no Welfare Check is due.' });
      }
      const evidence = (await this.evidenceFor(manager, [shift.id])).get(shift.id) ?? { logs: [], attendance: [] };
      const before = this.resolve(fresh, evidence, at);
      // Which window a check made now would meet, by the engine's own attribution (early tolerance and on-duty rules
      // included): the window that is met with it and was not without it.
      const withCheck = this.resolve(fresh, { ...evidence, logs: [...evidence.logs, { createdAt: at, logType: DailyLogType.WELFARE_CHECK } as DailyLog] }, at);
      const target = withCheck.windows.find(
        (w, i) => w.state === OperationalWindowState.COMPLETED && before.windows[i]?.state !== OperationalWindowState.COMPLETED,
      );

      if (reminder) {
        const reminded = before.windows.find((w) => w.index === reminder.windowIndex);
        if (reminded?.state === OperationalWindowState.COMPLETED) return this.confirmResult('already_recorded', shift.id, reminded);
        if (!target || target.index !== reminder.windowIndex) {
          throw new ConflictException({
            code: 'reminder_expired',
            message: 'That Welfare Check reminder has expired. Open S4 and confirm your current Welfare Check.',
          });
        }
      }
      if (!target) {
        const containing = before.windows.find((w) => w.start.getTime() <= at.getTime() && at.getTime() < w.end.getTime());
        if (containing?.state === OperationalWindowState.COMPLETED) return this.confirmResult('already_recorded', shift.id, containing);
        throw new ConflictException({ code: 'no_check_due', message: 'There is no Welfare Check due on this shift right now.' });
      }

      const repo = manager.getRepository(DailyLog);
      const saved = await repo.save(
        repo.create({
          company: shift.company, guard, shift: { id: shift.id } as Shift,
          message: PUSH_CONFIRMATION_MESSAGE, logType: DailyLogType.WELFARE_CHECK, createdAt: at,
        }),
      );
      await this.auditLogService.logInTransaction(manager, {
        company: shift.company,
        user: { id: userId } as any,
        action: 'daily_log.created',
        entityType: 'daily_log',
        entityId: saved.id,
        afterData: {
          logType: saved.logType, shiftId: shift.id, source: 'welfare_notification',
          windowIndex: target.index, reminderId: reminder?.id ?? null,
        },
      });
      return this.confirmResult('recorded', shift.id, target, saved.createdAt);
    });
  }

  private confirmResult(
    result: WelfareConfirmResult['result'],
    shiftId: number,
    window: { index: number; start: Date; end: Date; completedAt?: Date | null },
    recordedAt?: Date,
  ): WelfareConfirmResult {
    const at = recordedAt ?? window.completedAt ?? null;
    return {
      result, shiftId, windowIndex: window.index,
      windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(),
      recordedAt: at ? new Date(at).toISOString() : null,
    };
  }

  // ── Need Help ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Raise the existing panic alert for the Guard's own in-progress shift. Never a Welfare Check. Repeated taps (or a
   * retried request) within ten minutes return the alert already open instead of raising another. The alert reaches
   * the company's Control Room through the existing alert flow; nothing here contacts emergency services.
   */
  async needHelp(userId: number, input: { shiftId: number; reminderId?: number }): Promise<NeedHelpResult> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');
    const shift = await this.shiftService.findOne(input.shiftId);
    this.shiftService.assertGuardCanOperateShift(shift, guard.id, 'request help');
    await this.ownReminder(input.reminderId, shift.id, guard.id);

    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [WELFARE_ACTION_LOCK_NAMESPACE, shift.id]);
      const [open] = await manager.query(
        `SELECT id, "createdAt" FROM safety_alerts
          WHERE "shiftId" = $1 AND "guardId" = $2 AND type = $3 AND status IN ($4, $5)
            AND "createdAt" > now() - ($6 || ' minutes')::interval
          ORDER BY id DESC LIMIT 1`,
        [shift.id, guard.id, SafetyAlertType.PANIC, SafetyAlertStatus.OPEN, SafetyAlertStatus.ACKNOWLEDGED, String(NEED_HELP_DEDUPE_MINUTES)],
      );
      if (open) {
        return { result: 'already_raised', alertId: open.id, shiftId: shift.id, raisedAt: new Date(open.createdAt).toISOString() };
      }
      // The existing Guard panic path: CRITICAL priority, audit, and the Control Room notification.
      const alert: SafetyAlert = await this.safetyAlertService.createForGuard(userId, {
        shiftId: shift.id, type: SafetyAlertType.PANIC, priority: SafetyAlertPriority.CRITICAL, message: NEED_HELP_ALERT_MESSAGE,
      });
      return { result: 'raised', alertId: alert.id, shiftId: shift.id, raisedAt: new Date(alert.createdAt).toISOString() };
    });
  }

  // ── Control Room ──────────────────────────────────────────────────────────────────────────────────

  /** Reminders for shifts already scoped to the caller's company by the caller. */
  async remindersForShifts(companyId: number, shiftIds: number[]): Promise<Map<number, WelfareReminderView[]>> {
    const out = new Map<number, WelfareReminderView[]>();
    if (!shiftIds.length) return out;
    const rows = await this.reminderRepo.find({
      where: { companyId, shiftId: In(shiftIds) },
      order: { windowIndex: 'ASC', id: 'ASC' },
    });
    for (const r of rows) {
      const list = out.get(r.shiftId) ?? [];
      list.push(toReminderView(r));
      out.set(r.shiftId, list);
    }
    return out;
  }

  // ── Shared ────────────────────────────────────────────────────────────────────────────────────────

  /** A reminder id from a notification is only a hint; it must be this Guard's, for this shift. */
  private async ownReminder(reminderId: number | undefined, shiftId: number, guardId: number) {
    if (reminderId === undefined || reminderId === null) return null;
    const reminder = await this.reminderRepo.findOne({ where: { id: reminderId } });
    if (!reminder || reminder.shiftId !== shiftId || reminder.guardId !== guardId) {
      throw new NotFoundException('Welfare Check reminder not found');
    }
    return reminder;
  }

  private async evidenceFor(manager: EntityManager, shiftIds: number[]): Promise<Map<number, ShiftEvidence>> {
    const out = new Map<number, ShiftEvidence>();
    if (!shiftIds.length) return out;
    const read = { relations: { shift: true }, loadEagerRelations: false } as const;
    const logs = await manager.getRepository(DailyLog).find({
      ...read, where: { shift: { id: In(shiftIds) }, logType: In(WELFARE_COMPLETION_LOG_TYPES) }, order: { createdAt: 'ASC' },
    });
    const attendance = await manager.getRepository(AttendanceEvent).find({
      ...read, where: { shift: { id: In(shiftIds) } }, order: { occurredAt: 'ASC' },
    });
    for (const id of shiftIds) out.set(id, { logs: [], attendance: [] });
    for (const log of logs) if (log.shift?.id) out.get(log.shift.id)?.logs.push(log);
    for (const event of attendance) if (event.shift?.id) out.get(event.shift.id)?.attendance.push(event);
    return out;
  }

  /** Exactly the safety sweep's resolution of a shift's Welfare windows. */
  private resolve(shift: Shift, evidence: ShiftEvidence, now: Date): OperationalWindowResolution {
    // Effective attendance (Migration 67), judged from monitoredFrom exactly as the sweep is.
    const effective = effectiveAttendance(evidence.attendance);
    return this.welfareWindowService.resolve({
      shiftStart: new Date(shift.start),
      shiftEnd: new Date(shift.end),
      interval: {
        siteWelfareCheckIntervalMinutes: shift.site?.welfareCheckIntervalMinutes,
        shiftCheckCallIntervalMinutes: shift.checkCallIntervalMinutes,
      },
      completions: toOperationalCompletions(evidence.logs),
      applicability: {
        bookOnAt: effective.monitoredFrom,
        bookOffAt: effective.bookOffAt,
        shiftEnd: new Date(shift.end),
        cancelled: shift.status === 'cancelled',
      },
      now,
    });
  }
}
