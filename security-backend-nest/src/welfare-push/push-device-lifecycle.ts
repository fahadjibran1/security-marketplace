/**
 * What happens to a user's push devices when every session of theirs ends. Plain SQL on the caller's transaction, so
 * it commits with the password change or the deletion, or not at all.
 *
 *   password reset    every device is revoked: a phone left signed in elsewhere stops showing reminders (which name
 *                     the site). The Guard's current phone registers again when they sign in.
 *   account deletion  the rows are removed: a token identifies a phone and is no evidence of anything.
 */
type Manager = { query: (sql: string, parameters?: unknown[]) => Promise<unknown> };

export async function revokePushDevicesForUser(manager: Manager, userId: number, reason: 'password_change'): Promise<void> {
  await manager.query(
    `UPDATE push_devices SET "revokedAt" = now(), "revokedReason" = $2 WHERE "userId" = $1 AND "revokedAt" IS NULL`,
    [userId, reason],
  );
}

export async function removePushDevicesForUser(manager: Manager, userId: number): Promise<void> {
  await manager.query(`DELETE FROM push_devices WHERE "userId" = $1`, [userId]);
}
