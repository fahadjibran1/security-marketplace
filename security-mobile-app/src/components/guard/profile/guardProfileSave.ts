import type { GuardProfile, UpdateGuardPayload } from '../../../types/models';

/**
 * S4 Guard Profile save safety (Friday release patch).
 *
 * PATCH /guards/me applies the body with Object.assign: a field that is left out is kept, but an empty string replaces
 * what is stored. The Profile form starts empty and is only filled once the Guard's own record has loaded, so before
 * this patch a failed or slow load let "Save profile" send "" for the name and phone. These rules make that impossible:
 * nothing can be saved until a record has loaded, only the fields the Guard actually changed are sent, the name can
 * never be blank and a stored phone number can never be blanked.
 */
export type GuardProfileFields = { fullName: string; phone: string; locationSharing: boolean };

export type GuardProfileSavePlan =
  | { kind: 'unavailable'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'unchanged'; message: string }
  | { kind: 'save'; payload: UpdateGuardPayload };

export const PROFILE_UNAVAILABLE_MESSAGE =
  'Your profile could not be loaded, so nothing can be saved yet. Check your connection and tap Try again.';
export const PROFILE_NAME_REQUIRED_MESSAGE = 'Enter your full name before saving.';
export const PROFILE_PHONE_REQUIRED_MESSAGE = 'Enter your phone number before saving. It cannot be left empty.';
export const PROFILE_UNCHANGED_MESSAGE = 'There are no changes to save.';

/** The editable Profile fields exactly as the loaded record holds them. */
export function guardProfileFieldsFrom(guard: Pick<GuardProfile, 'fullName' | 'phone' | 'locationSharingEnabled'>): GuardProfileFields {
  return {
    fullName: guard.fullName || '',
    phone: guard.phone || '',
    locationSharing: guard.locationSharingEnabled ?? false,
  };
}

/** What "Save profile" may send, given the last loaded record (null when none has loaded) and the form. */
export function planGuardProfileSave(loaded: GuardProfileFields | null, form: GuardProfileFields): GuardProfileSavePlan {
  if (!loaded) return { kind: 'unavailable', message: PROFILE_UNAVAILABLE_MESSAGE };
  const fullName = form.fullName.trim();
  const phone = form.phone.trim();
  if (!fullName) return { kind: 'invalid', message: PROFILE_NAME_REQUIRED_MESSAGE };
  if (!phone && loaded.phone.trim()) return { kind: 'invalid', message: PROFILE_PHONE_REQUIRED_MESSAGE };
  const payload: UpdateGuardPayload = {};
  if (fullName !== loaded.fullName) payload.fullName = fullName;
  if (phone && phone !== loaded.phone) payload.phone = phone;
  if (form.locationSharing !== loaded.locationSharing) payload.locationSharingEnabled = form.locationSharing;
  if (Object.keys(payload).length === 0) return { kind: 'unchanged', message: PROFILE_UNCHANGED_MESSAGE };
  return { kind: 'save', payload };
}
