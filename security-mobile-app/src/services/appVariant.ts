// Which app this is: the store app, or the side-by-side UAT app that talks only to staging (app.config.js).
// Pure, so the label rule can be executed in a spec without a device.

export type AppVariant = 'production' | 'uat';

/** Shown in the signed-in top bar of the UAT app so a tester can never mistake it for the real S4. */
export const UAT_PRODUCT_LABEL = 'S4 UAT · STAGING';

/** Anything other than an explicit 'uat' is the store app — a missing or unknown value never turns UAT on. */
export function resolveAppVariant(extra: { appVariant?: unknown } | null | undefined): AppVariant {
  return extra?.appVariant === 'uat' ? 'uat' : 'production';
}

export function productLabelFor(variant: AppVariant, appName: string): string {
  return variant === 'uat' ? UAT_PRODUCT_LABEL : appName;
}
