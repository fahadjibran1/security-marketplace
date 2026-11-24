import { EntityManager } from 'typeorm';
import { CompanyMembership } from '../company-membership/entities/company-membership.entity';
import {
  CompanyMembershipStatus,
  CompanyPermission,
  hasPermission,
} from '../company-membership/company-membership-types';

/**
 * S4-EM-01 — the minimum reliable Emergency.
 *
 * A Guard's Emergency is SafetyAlertType.PANIC on the wire (unchanged for compatibility with every app build in use).
 * Three things are kept apart, because a Guard in danger must never be told more than is true:
 *
 *   RECEIVED       the server committed the alert, its audit entry and an in-app notification for every responsible
 *                  person, in one transaction. This is the only thing the Guard's app may state as fact.
 *   NOTIFIED       push delivery was ATTEMPTED to the responsible people's registered phones, after the commit. A push
 *                  accepted by the provider is not a person having seen it.
 *   ACKNOWLEDGED   a named person at the company acknowledged the alert (status 'acknowledged', acknowledgedByUserId).
 *                  Only this means a human has taken it up.
 */

/**
 * A second Emergency from the same Guard on the same shift while the first is still OPEN (nobody has acknowledged it)
 * and younger than this is the same emergency: a double tap, a retry after a lost response, or the notification's Need
 * Help racing the in-app button. It is answered with the alert already raised. Once the first has been acknowledged or
 * closed, or this long has passed, a new press is a genuinely new Emergency and raises a new alert.
 */
export const EMERGENCY_DEDUPE_SECONDS = 120;

/** The alert body when the Guard typed nothing, which is now the normal case: no description is required. */
export const EMERGENCY_DEFAULT_MESSAGE = 'Emergency raised by the Guard from the S4 app.';

/** The longest optional description accepted with an Emergency. */
export const EMERGENCY_MESSAGE_MAX_LENGTH = 1000;

/** The Android notification channel the app creates for Emergency pushes (maximum importance). */
export const EMERGENCY_PUSH_CHANNEL = 'emergency-alerts';
export const EMERGENCY_PUSH_KIND = 'emergency_alert';
/** Long enough to reach a phone that was briefly out of signal; short enough not to arrive hours late. */
export const EMERGENCY_PUSH_TTL_SECONDS = 30 * 60;

/** What the Guard's app is told about its Emergency. Counts only: never who, never a token. */
export type EmergencyReceipt = {
  /** True when this request matched an Emergency already raised (see EMERGENCY_DEDUPE_SECONDS). */
  duplicate: boolean;
  /** When S4 committed the alert. */
  receivedAt: string;
  /** People at the company who were given an in-app notification in the same transaction as the alert. */
  responsiblePeopleNotified: number;
  /** Registered phones a push will be attempted to, after the commit. Attempted, never "delivered". */
  pushDevicesTargeted: number;
  /** Always false when raised; the app reads the alert's own status afterwards to learn of a human acknowledgement. */
  acknowledged: boolean;
};

/**
 * Who is responsible for responding to a company's Emergency: the company owner account, and every ACTIVE company member
 * whose role holds alerts.manage (Owner, Admin, Operations and Control Room memberships). Never another company's people,
 * never a suspended or removed member, never HR / Compliance, Finance or Viewer, never Guards. Sorted, de-duplicated.
 * The person's own account must also be able to sign in (status active, never deleted) — the same rule login applies —
 * so a suspended, inactive or deleted account is neither notified nor pushed, whatever its membership row says.
 *
 * Memberships carry no site restriction in S4 today, so "site access" is the company: everyone responsible for the
 * company's live operations is responsible for every one of its sites.
 */
export async function emergencyRecipientUserIds(manager: EntityManager, companyId: number): Promise<number[]> {
  const out = new Set<number>();
  const [owner] = await manager.query('SELECT "userId" FROM "companies" WHERE id = $1', [companyId]);
  if (owner?.userId) out.add(Number(owner.userId));
  const members = await manager.getRepository(CompanyMembership).find({
    where: { companyId, status: CompanyMembershipStatus.ACTIVE },
  });
  for (const member of members) {
    if (hasPermission(member.membershipRole, CompanyPermission.ALERTS_MANAGE)) out.add(Number(member.userId));
  }
  if (!out.size) return [];
  const usable = await manager.query(
    `SELECT id FROM "users" WHERE id = ANY($1::int[]) AND status = 'active' AND "deletionCompletedAt" IS NULL`,
    [[...out]],
  );
  return usable.map((row: { id: number | string }) => Number(row.id)).sort((a: number, b: number) => a - b);
}

/** May this company member see and act on its own company's Emergencies? Owner, Admin, Operations, Control Room. */
export function memberMayHandleEmergency(role: Parameters<typeof hasPermission>[0]): boolean {
  return hasPermission(role, CompanyPermission.ALERTS_MANAGE);
}

/** The text of the in-app notification and the push. Names the Guard and site only: both are already on the alert. */
export function emergencyNotificationText(guardName: string | null | undefined, siteName: string | null | undefined) {
  const guard = (guardName ?? '').trim() || 'A Guard';
  const site = (siteName ?? '').trim() || 'their site';
  return {
    title: 'EMERGENCY — Guard needs help',
    message: `${guard} raised an Emergency at ${site}. Open Live Operations in S4 now, acknowledge it and contact the Guard.`,
    pushBody: `${guard} raised an Emergency at ${site}. Open S4 now.`,
  };
}
