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

/**
 * The provider said this installation is gone (Expo DeviceNotRegistered): revoke the device so nothing is sent to it
 * again, exactly as the Welfare Check path does. The phone registers afresh when the app next signs in. Returns 1 if a
 * device was revoked, else 0.
 */
export async function revokeDeadPushDevice(manager: Manager, deviceId: number): Promise<number> {
  const result = await manager.query(
    `UPDATE push_devices SET "revokedAt" = now(), "revokedReason" = 'device_not_registered' WHERE id = $1 AND "revokedAt" IS NULL RETURNING id`,
    [deviceId],
  );
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : Array.isArray(result) ? result : [];
  return rows.length;
}
