// Patrols on the Guard's PHONE only (Patrols P1-E). The S4 web app has no patrol camera, no private evidence folder and
// no offline outbox, so on web the Guard's Home shows no patrol panel at all — and the web bundle never loads the
// device modules (expo-sqlite, expo-file-system, expo-image-manipulator, expo-crypto) that only the phone uses.

export function GuardPatrolPanel(_props: { userId: number; shift: { id: number; status: string; companyId?: number | null; siteName?: string | null } | null }) {
  return null;
}
