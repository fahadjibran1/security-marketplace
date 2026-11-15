// S4-UX-01.3 — which on-screen launcher opens the (unchanged) Emergency form while an Emergency can be raised.
//
//   'bar'    — Variant A, the persistent full-width on-duty bar under the header (S4-UX-01.2). THE SHIPPING DEFAULT.
//   'header' — Variant B, a compact "SOS" control in the Guard header. FOR REVIEW ONLY.
//
// Both call the same handler, which opens the same Emergency form with the same type-SOS confirmation and the same
// online submission. Variant B can only be selected in a development bundle (Metro, __DEV__) with
// EXPO_PUBLIC_S4_SOS_PREVIEW=header, so screenshots of it can be taken locally; every release build (EAS, store,
// TestFlight, UAT) has __DEV__ false and always gets Variant A. Making B the default is a separate, reviewed change.

declare const __DEV__: boolean | undefined;

export type GuardEmergencyPresentation = 'bar' | 'header';

export const DEFAULT_GUARD_EMERGENCY_PRESENTATION: GuardEmergencyPresentation = 'bar';

export function guardEmergencyPresentation(
  preview: string | undefined = process.env.EXPO_PUBLIC_S4_SOS_PREVIEW,
  developmentBundle: boolean = typeof __DEV__ !== 'undefined' && __DEV__ === true,
): GuardEmergencyPresentation {
  return developmentBundle && preview === 'header' ? 'header' : DEFAULT_GUARD_EMERGENCY_PRESENTATION;
}
