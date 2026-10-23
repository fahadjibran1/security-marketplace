import { WelfareReminder, WelfareReminderKind } from './entities/welfare-reminder.entity';

/** A reminder as the Control Room sees it. Provider words only; never a claim that the Guard saw it. */
export type WelfareReminderView = {
  id: number;
  windowIndex: number;
  kind: WelfareReminderKind;
  status: WelfareReminder['status'];
  receiptStatus: WelfareReminder['receiptStatus'];
  deviceCount: number;
  attempts: number;
  sentAt: string | null;
};

/** Only on GET /coverage/operations, beside the window grid it annotates. */
export function toReminderView(r: WelfareReminder): WelfareReminderView {
  return {
    id: r.id,
    windowIndex: r.windowIndex,
    kind: r.kind,
    status: r.status,
    receiptStatus: r.receiptStatus,
    deviceCount: r.deviceCount,
    attempts: r.attempts,
    sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
  };
}
