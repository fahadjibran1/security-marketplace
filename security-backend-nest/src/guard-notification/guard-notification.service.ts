import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, EntitySubscriberInterface, QueryRunner, TransactionCommitEvent, TransactionRollbackEvent } from 'typeorm';
import { DEFAULT_SITE_TIME_ZONE } from '../common/site-time';
import { NotificationStatus } from '../notification/entities/notification.entity';
import { returningRows } from '../operations/advisory-locks';
import { SingleFlightJob } from '../scheduler/single-flight-job';
import { ExpoPushClient, ExpoPushMessage, ExpoPushTransportError } from '../welfare-push/expo-push.client';
import { revokeDeadPushDevice } from '../welfare-push/push-device-lifecycle';
import { GuardDispatchStatus, GuardPushType, GUARD_PUSH_TYPES } from './entities/guard-notification-dispatch.entity';

/** How often undelivered pushes (missed after a restart, or a provider outage) are retried and receipts read. */
export const GUARD_NOTIFICATION_INTERVAL_MS = 60_000;
/** Delivery attempts per push when the provider cannot be reached. Retried only while the shift has not ended. */
export const GUARD_NOTIFICATION_MAX_ATTEMPTS = 3;
/** The Android channel the app creates for these notifications. */
export const GUARD_NOTIFICATION_CHANNEL = 'shift-updates';
/** The `data.kind` the app routes on. */
export const GUARD_NOTIFICATION_KIND = 'guard_notification';

const RECEIPT_DELAY_MS = 15 * 60_000;
const RECEIPT_GIVE_UP_MS = 24 * 60 * 60_000;
const STALE_PENDING_MS = 60_000;
const STALE_SENDING_MS = 2 * 60_000;
const RETRY_AFTER_MS = 60_000;
/** Older undelivered pushes are left alone: the in-app notice is still there. */
const RETRY_WINDOW_MS = 24 * 60 * 60_000;
const MIN_TTL_SECONDS = 60;
/** FCM's maximum. */
const MAX_TTL_SECONDS = 28 * 24 * 60 * 60;

const ERROR_CODE = (value: unknown) => String(value ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'unknown';

/**
 * One Guard-facing event. `guardId` is the guard_profiles id of the Guard on `shiftId`; `companyId` is the company that
 * owns the shift and made the change. `eventKey` names the event (with the Guard's user, it is the idempotency key).
 */
export type GuardNotificationEvent = {
  type: GuardPushType;
  companyId: number;
  guardId: number;
  shiftId: number;
  amendmentId?: number | null;
  eventKey: string;
};

/** The in-app notice to write with a new event (title and message are shown only inside the signed-in app). */
export type GuardInAppNotice = { title: string; message: string };

/**
 * The lock-screen text. Short, generic, no personal data: never a name, address, phone number or site name. A shift
 * date and time (in the site's time zone) is the only detail.
 */
export function guardPushContent(type: GuardPushType, shiftStartMs: number | null, timeZone: string | null): { title: string; body: string } {
  const when = shiftStartMs === null ? 'an upcoming date' : formatShiftTime(shiftStartMs, timeZone);
  switch (type) {
    case 'shift_offered':
      return { title: 'New shift offer', body: `You have a new shift offer for ${when}. Open S4 to accept or decline.` };
    case 'shift_offer_withdrawn':
      return { title: 'Shift withdrawn', body: `Your shift on ${when} has been withdrawn. Open S4 for details.` };
    case 'shift_reacceptance_required':
      return { title: 'Shift changed', body: `Your shift on ${when} has changed. Open S4 to review it and accept it again.` };
    case 'shift_replaced':
      return { title: 'Shift reassigned', body: `Your shift on ${when} is no longer assigned to you. Open S4 for details.` };
    case 'shift_amendment_requested':
      return { title: 'Shift extension request', body: 'Your company asks you to extend your current shift. Open S4 to accept or decline.' };
    case 'shift_amendment_responded':
      return { title: 'Shift extension update', body: 'There is an update about a shift extension. Open S4 for details.' };
    case 'shift_amendment_expired':
      return { title: 'Shift extension expired', body: 'A shift extension request expired. Your shift end is unchanged.' };
  }
}

function formatShiftTime(ms: number, timeZone: string | null): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(ms));
  try {
    return format(timeZone?.trim() || DEFAULT_SITE_TIME_ZONE);
  } catch {
    return format(DEFAULT_SITE_TIME_ZONE);
  }
}

/** PUSH_GUARD_NOTIFICATIONS_ENABLED: only exactly "true" (trimmed, any case) enables the push. */
export function guardPushEnabled(raw: string | undefined | null): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'true';
}

type DispatchRow = {
  id: number;
  userId: number;
  guardId: number;
  companyId: number;
  notificationId: number | null;
  shiftId: number | null;
  amendmentId: number | null;
  type: GuardPushType;
  status: GuardDispatchStatus;
  attempts: number;
  role: string | null;
  profileUserId: number | null;
  shiftCompanyId: number | null;
  shiftGuardId: number | null;
  shiftExists: boolean;
  startMs: string | null;
  endMs: string | null;
  timeZone: string | null;
  nowMs: string;
};

/**
 * Guard shift notifications: for one Guard and one event, the in-app notice and an OS push to the Guard's active
 * devices, at most once.
 *
 *   - The notice and the dispatch record are written on the caller's transaction, so they commit with the business
 *     change or not at all. UNIQUE (userId, eventKey) makes a repeated or concurrent call for one event a no-op.
 *   - The push is sent only after that transaction commits, best effort: a push failure never fails, blocks or rolls
 *     back the business action. Its outcome is recorded on the dispatch row.
 *   - Only to a Guard account (never company staff), only the Guard on that company's shift (never another company's
 *     Guard; for a replacement, the Guard who held it when it was recorded), never for a shift that has ended, and
 *     only to active (not revoked) devices. DeviceNotRegistered revokes the device, exactly as the Welfare Check path
 *     does.
 *   - PUSH_GUARD_NOTIFICATIONS_ENABLED (default off) gates the push only; the in-app notice is written regardless.
 */
@Injectable()
export class GuardNotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('GuardNotifications');
  private retryJob?: SingleFlightJob;
  private retryInterval?: NodeJS.Timeout;
  /** Dispatches recorded on a transaction that has not committed yet. */
  private readonly pendingByRunner = new WeakMap<QueryRunner, Set<number>>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly subscriber: EntitySubscriberInterface;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly expo: ExpoPushClient,
  ) {
    const self = this;
    this.subscriber = {
      afterTransactionCommit(event: TransactionCommitEvent) {
        // Fires on every RELEASE SAVEPOINT too; only the outermost COMMIT makes the dispatches visible.
        const runner = event.queryRunner;
        if (runner.isTransactionActive) return;
        const ids = self.pendingByRunner.get(runner);
        self.pendingByRunner.delete(runner);
        // Not returned: the commit (and the HTTP response) never waits for the push.
        if (ids?.size) self.deliverInBackground([...ids]);
      },
      afterTransactionRollback(event: TransactionRollbackEvent) {
        const runner = event.queryRunner;
        // A rolled-back savepoint leaves nothing to deliver either; delivery would find no row and send nothing.
        if (!runner.isTransactionActive) self.pendingByRunner.delete(runner);
      },
    };
  }

  onModuleInit() {
    this.dataSource.subscribers.push(this.subscriber);
    this.retryJob = new SingleFlightJob(
      'guard-notification-push',
      () =>
        this.runRetryJob().then(
          () => undefined,
          (error) => this.logger.error(`Guard notification retry run failed: ${error?.message || error}`),
        ),
      { overrunAfterMs: 2 * GUARD_NOTIFICATION_INTERVAL_MS },
    );
    this.retryInterval = setInterval(() => void this.retryJob?.tick(), GUARD_NOTIFICATION_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.retryInterval) clearInterval(this.retryInterval);
    this.retryJob?.stop();
    const index = this.dataSource.subscribers.indexOf(this.subscriber);
    if (index >= 0) this.dataSource.subscribers.splice(index, 1);
  }

  /** Off unless PUSH_GUARD_NOTIFICATIONS_ENABLED=true. In-app notices are written either way. */
  pushEnabled(): boolean {
    return guardPushEnabled(this.config.get<string>('PUSH_GUARD_NOTIFICATIONS_ENABLED'));
  }

  // ── Recording (on the caller's transaction) ───────────────────────────────────────────────────────

  /**
   * The business transaction's id, for events that can recur on the same shift (an offer, a revised offer). Each such
   * transition commits in exactly one transaction, under the shift row lock and a status guard, so (shift,
   * transaction) names it: a duplicate call inside the transaction collapses onto one dispatch, and a retried HTTP
   * request either changes nothing (and notifies nothing) or is a genuinely new transition.
   */
  async transactionKey(manager: EntityManager): Promise<string> {
    const [{ tx }] = await manager.query(`SELECT txid_current()::text AS "tx"`);
    return String(tx);
  }

  /** Each path that puts a shift into `offered` for a Guard. */
  async shiftOffered(manager: EntityManager, input: { companyId: number; guardId: number; shiftId: number }) {
    const tx = await this.transactionKey(manager);
    return this.notify(manager, { type: 'shift_offered', ...input, eventKey: `shift_offered:shift:${input.shiftId}:tx:${tx}` });
  }

  /** A material change returned an accepted shift to its Guard for re-acceptance. */
  async shiftReacceptanceRequired(manager: EntityManager, input: { companyId: number; guardId: number; shiftId: number }) {
    const tx = await this.transactionKey(manager);
    return this.notify(manager, {
      type: 'shift_reacceptance_required', ...input, eventKey: `shift_reacceptance_required:shift:${input.shiftId}:tx:${tx}`,
    });
  }

  /**
   * An offered or accepted (not yet Booked On) shift was cancelled, withdrawn or deleted. Cancelled is terminal, so
   * the shift alone names the event.
   */
  async shiftOfferWithdrawn(manager: EntityManager, input: { companyId: number; guardId: number; shiftId: number }) {
    return this.notify(manager, { type: 'shift_offer_withdrawn', ...input, eventKey: `shift_offer_withdrawn:shift:${input.shiftId}` });
  }

  /**
   * Replace Guard: the Guard who held an offered or accepted shift is told it is no longer theirs. Recorded on the
   * replacement's transaction while they still hold the shift (before the reassignment is written), so the recipient
   * check sees them as its Guard. `replacementKey` is that replacement's audit entry id: each replacement is one
   * event, and a later replacement of the same Guard on the same shift (after being given it back) is another.
   */
  async shiftReplaced(manager: EntityManager, input: { companyId: number; guardId: number; shiftId: number; replacementKey: number }) {
    const { replacementKey, ...target } = input;
    return this.notify(manager, {
      type: 'shift_replaced', ...target, eventKey: `shift_replaced:shift:${input.shiftId}:audit:${replacementKey}`,
    });
  }

  /**
   * A new Guard event: writes the in-app notice and the dispatch on `manager` (the business transaction). Returns
   * null, writing nothing, when the event was already recorded or the recipient is not the Guard on that company's
   * shift.
   */
  async notify(manager: EntityManager, event: GuardNotificationEvent, notice?: GuardInAppNotice): Promise<{ notificationId: number; dispatchId: number } | null> {
    const dispatch = await this.insertDispatch(manager, event);
    if (!dispatch) return null;
    const dispatchId = dispatch.id;
    // By default the in-app notice says what the push says (no site name or other detail; the app shows the shift).
    notice ??= (() => {
      const content = guardPushContent(event.type, dispatch.startMs, dispatch.timeZone);
      return { title: content.title, message: content.body };
    })();
    // The same row shape every other producer writes (see ShiftAmendmentService.notify).
    const [row] = await manager.query(
      `INSERT INTO "notifications" ("userId", "companyId", "type", "title", "message", "status", "sentAt")
       VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING "id"`,
      [dispatch.userId, event.companyId, event.type, notice.title, notice.message, NotificationStatus.UNREAD],
    );
    const notificationId = Number(row.id);
    await manager.query(`UPDATE "guard_notification_dispatches" SET "notificationId" = $2 WHERE "id" = $1`, [dispatchId, notificationId]);
    this.afterCommit(manager, dispatchId);
    return { notificationId, dispatchId };
  }

  /**
   * An in-app notice another service has already written to the Guard (Live Shift Amendments): adds only the push.
   * The notice itself is left exactly as written.
   */
  async pushForNotice(manager: EntityManager, event: GuardNotificationEvent, notificationId: number): Promise<number | null> {
    const dispatch = await this.insertDispatch(manager, event, notificationId);
    if (dispatch) this.afterCommit(manager, dispatch.id);
    return dispatch?.id ?? null;
  }

  private async insertDispatch(manager: EntityManager, event: GuardNotificationEvent, notificationId: number | null = null): Promise<{ id: number; userId: number; startMs: number | null; timeZone: string | null } | null> {
    if (!GUARD_PUSH_TYPES.includes(event.type) || !event.eventKey || event.eventKey.length > 160) {
      throw new Error(`Invalid Guard notification event: ${event.type}`);
    }
    // The recipient is the Guard on this shift of this company, with a Guard account. Anything else gets nothing.
    const [who] = (await manager.query(
      `SELECT g."userId", u."role", s."companyId" AS "shiftCompanyId", s."guardId" AS "shiftGuardId",
              EXTRACT(EPOCH FROM s."start") * 1000 AS "startMs", st."timezone" AS "timeZone"
         FROM "guard_profiles" g
         JOIN "users" u ON u."id" = g."userId"
         LEFT JOIN "shifts" s ON s."id" = $2
         LEFT JOIN "sites" st ON st."id" = s."siteId"
        WHERE g."id" = $1`,
      [event.guardId, event.shiftId],
    )) as Array<{ userId: number; role: string; shiftCompanyId: number | null; shiftGuardId: number | null; startMs: string | null; timeZone: string | null }>;
    if (
      !who ||
      who.role !== 'guard' ||
      Number(who.shiftCompanyId) !== event.companyId ||
      Number(who.shiftGuardId) !== event.guardId
    ) {
      this.logger.warn(JSON.stringify({ event: 'guard_notification_refused', type: event.type, shiftId: event.shiftId, reason: 'not_the_shift_guard' }));
      return null;
    }
    const inserted = returningRows<{ id: number }>(
      await manager.query(
        `INSERT INTO "guard_notification_dispatches"
           ("userId", "guardId", "companyId", "notificationId", "shiftId", "amendmentId", "type", "eventKey", "shiftStartAt", "shiftEndAt", "status")
         SELECT $1::int, $2::int, $3::int, $4::int, s."id", $6::int, $7::varchar, $8::varchar, s."start", s."end", 'pending'
           FROM "shifts" s WHERE s."id" = $5::int
         ON CONFLICT ("userId", "eventKey") DO NOTHING
         RETURNING "id"`,
        [Number(who.userId), event.guardId, event.companyId, notificationId, event.shiftId, event.amendmentId ?? null, event.type, event.eventKey],
      ),
    );
    if (!inserted[0]?.id) return null;
    return {
      id: Number(inserted[0].id),
      userId: Number(who.userId),
      startMs: who.startMs === null ? null : Number(who.startMs),
      timeZone: who.timeZone,
    };
  }

  private afterCommit(manager: EntityManager, dispatchId: number) {
    const runner = manager.queryRunner;
    if (runner?.isTransactionActive) {
      const set = this.pendingByRunner.get(runner) ?? new Set<number>();
      set.add(dispatchId);
      this.pendingByRunner.set(runner, set);
      return;
    }
    // Written outside a transaction: it is already committed.
    this.deliverInBackground([dispatchId]);
  }

  // ── Delivery (after commit, best effort) ──────────────────────────────────────────────────────────

  private deliverInBackground(ids: number[]) {
    const run = (async () => {
      for (const id of ids) {
        try {
          await this.deliver(id);
        } catch (error) {
          this.logger.error(JSON.stringify({ event: 'guard_notification_delivery_failed', dispatchId: id, reason: (error as Error)?.message }));
        }
      }
    })();
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }

  /** Waits for every push started so far (tests, and an orderly shutdown). */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /**
   * Sends one dispatch, if it is still owed: pending (or, from the retry job, a failed / stale attempt). Every check is
   * made again here against the committed state: the switch, the recipient, the shift's company and Guard, and the
   * shift's current end.
   */
  async deliver(id: number, retry = false): Promise<GuardDispatchStatus | null> {
    const [row] = (await this.dataSource.query(
      `SELECT d."id", d."userId", d."guardId", d."companyId", d."notificationId", d."shiftId", d."amendmentId", d."type",
              d."status", d."attempts", u."role", g."userId" AS "profileUserId",
              s."id" IS NOT NULL AS "shiftExists", s."companyId" AS "shiftCompanyId", s."guardId" AS "shiftGuardId",
              EXTRACT(EPOCH FROM COALESCE(s."start", d."shiftStartAt")) * 1000 AS "startMs",
              EXTRACT(EPOCH FROM COALESCE(s."end", d."shiftEndAt")) * 1000 AS "endMs",
              st."timezone" AS "timeZone",
              EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS "nowMs"
         FROM "guard_notification_dispatches" d
         JOIN "users" u ON u."id" = d."userId"
         LEFT JOIN "guard_profiles" g ON g."id" = d."guardId"
         LEFT JOIN "shifts" s ON s."id" = d."shiftId"
         LEFT JOIN "sites" st ON st."id" = s."siteId"
        WHERE d."id" = $1`,
      [id],
    )) as DispatchRow[];
    if (!row) return null;
    const owed = row.status === 'pending' || (retry && (row.status === 'failed' || row.status === 'sending'));
    if (!owed || row.attempts >= GUARD_NOTIFICATION_MAX_ATTEMPTS) return null;

    const finish = (status: GuardDispatchStatus, extra: { error?: string | null } = {}) =>
      this.settle(row, status, extra.error ?? null);
    if (!this.pushEnabled()) return finish('skipped_disabled');
    // A replaced Guard is, by definition, no longer the shift's Guard: their push stays owed while the shift is still
    // that company's and still not theirs (if it has been given back to them since, the news is stale).
    const replaced = row.type === 'shift_replaced';
    const stillTheGuard =
      row.role === 'guard' &&
      Number(row.profileUserId) === Number(row.userId) &&
      (!row.shiftExists ||
        (Number(row.shiftCompanyId) === Number(row.companyId) &&
          (replaced ? Number(row.shiftGuardId) !== Number(row.guardId) : Number(row.shiftGuardId) === Number(row.guardId))));
    if (!stillTheGuard) return finish('skipped_ineligible');
    const nowMs = Number(row.nowMs);
    const endMs = row.endMs === null ? null : Number(row.endMs);
    if (endMs === null || endMs <= nowMs) return finish('skipped_ended');

    // Claim the attempt atomically: only one sender moves attempts from N to N + 1.
    const claimed = returningRows<{ id: number }>(
      await this.dataSource.query(
        `UPDATE "guard_notification_dispatches" SET "attempts" = "attempts" + 1, "status" = 'sending', "sentAt" = now()
          WHERE "id" = $1 AND "attempts" = $2 AND "status" = $3 RETURNING "id"`,
        [row.id, row.attempts, row.status],
      ),
    );
    if (!claimed.length) return null;

    const devices = (await this.dataSource.query(
      `SELECT "id", "token" FROM "push_devices" WHERE "userId" = $1 AND "revokedAt" IS NULL ORDER BY "id"`,
      [row.userId],
    )) as Array<{ id: number; token: string }>;
    if (!devices.length) {
      await this.dataSource.query(`UPDATE "guard_notification_dispatches" SET "status" = 'no_device', "deviceCount" = 0 WHERE "id" = $1`, [row.id]);
      return 'no_device';
    }

    const startMs = row.startMs === null ? null : Number(row.startMs);
    const { title, body } = guardPushContent(row.type, startMs, row.timeZone);
    // An offer or a revised offer matters until the shift starts; everything else until it ends.
    const untilStart = (row.type === 'shift_offered' || row.type === 'shift_reacceptance_required') && startMs !== null && startMs > nowMs;
    const ttl = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(((untilStart ? startMs! : endMs) - nowMs) / 1000)));
    // Identifiers only. The app reads the notice and the shift from the server; nothing here authorises anything.
    const data: Record<string, string | number> = {
      kind: GUARD_NOTIFICATION_KIND,
      notificationId: Number(row.notificationId),
      type: row.type,
    };
    if (row.shiftExists && row.shiftId) data.shiftId = Number(row.shiftId);
    if (row.amendmentId) data.amendmentId = Number(row.amendmentId);
    const messages: ExpoPushMessage[] = devices.map((d) => ({
      to: d.token, title, body, data, sound: 'default', priority: 'normal', channelId: GUARD_NOTIFICATION_CHANNEL, ttl,
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
          if (ticket.error === 'DeviceNotRegistered') await revokeDeadPushDevice(this.dataSource, devices[i].id);
        }
      }
      const status: GuardDispatchStatus = accepted.length ? 'provider_accepted' : 'provider_rejected';
      await this.dataSource.query(
        `UPDATE "guard_notification_dispatches" SET "status" = $2, "deviceCount" = $3, "ticketIds" = $4::jsonb, "error" = $5 WHERE "id" = $1`,
        [row.id, status, devices.length, JSON.stringify(accepted), firstError],
      );
      return status;
    } catch (error) {
      const code = error instanceof ExpoPushTransportError ? ERROR_CODE(error.message) : 'transport_error';
      await this.dataSource.query(
        `UPDATE "guard_notification_dispatches" SET "status" = 'failed', "deviceCount" = $2, "error" = $3 WHERE "id" = $1`,
        [row.id, devices.length, code],
      );
      return 'failed';
    }
  }

  private async settle(row: DispatchRow, status: GuardDispatchStatus, error: string | null): Promise<GuardDispatchStatus | null> {
    const updated = returningRows<{ id: number }>(
      await this.dataSource.query(
        `UPDATE "guard_notification_dispatches" SET "status" = $3, "error" = COALESCE($4, "error")
          WHERE "id" = $1 AND "status" = $2 AND "attempts" = $5 RETURNING "id"`,
        [row.id, row.status, status, error, row.attempts],
      ),
    );
    return updated.length ? status : null;
  }

  // ── Retries and receipts ──────────────────────────────────────────────────────────────────────────

  /** Timer entry point; exposed so tests and operators can drive one run. */
  triggerRetryJob() {
    return this.retryJob?.tick() ?? Promise.resolve({ ran: false });
  }

  /**
   * Pushes still owed: recorded but never sent (the process stopped between the commit and the send), a provider
   * outage (at most three attempts, a minute apart), or a send that died mid-way. Then Expo's receipts.
   */
  async runRetryJob(): Promise<{ retried: number; receiptsChecked: number; devicesRevoked: number }> {
    const counters = { retried: 0, receiptsChecked: 0, devicesRevoked: 0 };
    if (!this.pushEnabled()) return counters;
    const due = (await this.dataSource.query(
      `SELECT "id" FROM "guard_notification_dispatches"
        WHERE "createdAt" > now() - ($1 || ' milliseconds')::interval AND "attempts" < $2
          AND (("status" = 'pending' AND "createdAt" <= now() - ($3 || ' milliseconds')::interval)
            OR ("status" = 'failed' AND "sentAt" <= now() - ($4 || ' milliseconds')::interval)
            OR ("status" = 'sending' AND "sentAt" <= now() - ($5 || ' milliseconds')::interval))
        ORDER BY "id" LIMIT 200`,
      [String(RETRY_WINDOW_MS), GUARD_NOTIFICATION_MAX_ATTEMPTS, String(STALE_PENDING_MS), String(RETRY_AFTER_MS), String(STALE_SENDING_MS)],
    )) as Array<{ id: number }>;
    for (const { id } of due) {
      try {
        if (await this.deliver(Number(id), true)) counters.retried += 1;
      } catch (error) {
        this.logger.error(JSON.stringify({ event: 'guard_notification_retry_failed', dispatchId: id, reason: (error as Error)?.message }));
      }
    }
    await this.checkReceipts(counters);
    if (counters.retried || counters.receiptsChecked || counters.devicesRevoked) {
      this.logger.log(JSON.stringify({ event: 'guard_notification_run', ...counters }));
    }
    return counters;
  }

  /** Expo's receipts: what Apple/Google told Expo. Still not the phone. */
  private async checkReceipts(counters: { receiptsChecked: number; devicesRevoked: number }) {
    const due = (await this.dataSource.query(
      `SELECT "id", "ticketIds", "sentAt", "createdAt", EXTRACT(EPOCH FROM now()) * 1000 AS "nowMs"
         FROM "guard_notification_dispatches"
        WHERE "status" = 'provider_accepted' AND "receiptCheckedAt" IS NULL AND "sentAt" <= now() - ($1 || ' milliseconds')::interval
        ORDER BY "id" LIMIT 300`,
      [String(RECEIPT_DELAY_MS)],
    )) as Array<{ id: number; ticketIds: Array<{ id: string; deviceId: number }>; sentAt: Date | null; createdAt: Date; nowMs: string }>;
    if (!due.length) return;
    let receipts: Awaited<ReturnType<ExpoPushClient['receipts']>>;
    try {
      receipts = await this.expo.receipts(due.flatMap((r) => (r.ticketIds ?? []).map((t) => t.id)));
    } catch {
      return; // Next run tries again.
    }
    for (const dispatch of due) {
      const tickets = dispatch.ticketIds ?? [];
      const found = tickets.map((t) => ({ t, receipt: receipts.get(t.id) })).filter((x) => x.receipt);
      const sent = new Date(dispatch.sentAt ?? dispatch.createdAt).getTime();
      const expired = Number(dispatch.nowMs) - sent >= RECEIPT_GIVE_UP_MS;
      if (found.length < tickets.length && !expired) continue;
      let error: string | null = null;
      for (const { t, receipt } of found) {
        if (receipt!.status === 'error') {
          error ??= ERROR_CODE(receipt!.error);
          if (receipt!.error === 'DeviceNotRegistered') counters.devicesRevoked += await revokeDeadPushDevice(this.dataSource, t.deviceId);
        }
      }
      await this.dataSource.query(
        `UPDATE "guard_notification_dispatches" SET "receiptStatus" = $2, "receiptCheckedAt" = now(), "error" = COALESCE($3, "error") WHERE "id" = $1`,
        [dispatch.id, found.length ? (error ? 'provider_delivery_error' : 'provider_delivery_ok') : null, error],
      );
      counters.receiptsChecked += 1;
    }
  }
}
