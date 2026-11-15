/**
 * S4-UX Stage 2 — loads the four Inter weights the Guard Home uses (see guardType in ./guard.ts).
 *
 * The files are the official Inter 4.1 static TTFs (github.com/rsms/inter, release v4.1), unmodified, in
 * assets/fonts with their licence (assets/fonts/OFL.txt, SIL Open Font License 1.1).
 *
 * Loading never blocks the app for long and never throws:
 *  - it settles as 'loaded', 'failed' or 'timeout', at most GUARD_FONT_TIMEOUT_MS after it starts;
 *  - on 'failed' or 'timeout' the Guard text falls back to the system font (still fully usable), and the outcome is
 *    reported with console.warn rather than substituted silently.
 *
 * expo-font and the font files are required lazily, inside the try, so that environments without a native font
 * loader (the Node test harness) settle as 'failed' instead of crashing at import. The require paths are literal, so
 * Metro still bundles the files.
 */
export const GUARD_FONT_TIMEOUT_MS = 4000;

export type GuardFontOutcome = 'loaded' | 'failed' | 'timeout';

export async function loadGuardFonts(timeoutMs: number = GUARD_FONT_TIMEOUT_MS): Promise<GuardFontOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const Font = require('expo-font') as { loadAsync: (map: Record<string, unknown>) => Promise<void> };
    const load = Font.loadAsync({
      'Inter-Regular': require('../../assets/fonts/Inter-Regular.ttf'),
      'Inter-Medium': require('../../assets/fonts/Inter-Medium.ttf'),
      'Inter-SemiBold': require('../../assets/fonts/Inter-SemiBold.ttf'),
      'Inter-Bold': require('../../assets/fonts/Inter-Bold.ttf'),
    }).then(
      (): GuardFontOutcome => 'loaded',
      (error: unknown): GuardFontOutcome => {
        console.warn('[S4] Inter fonts could not be loaded; Guard text uses the system font.', error instanceof Error ? error.message : error);
        return 'failed';
      },
    );
    const timeout = new Promise<GuardFontOutcome>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([load, timeout]);
    if (outcome === 'timeout') console.warn(`[S4] Inter fonts did not load within ${timeoutMs} ms; Guard text uses the system font.`);
    return outcome;
  } catch (error) {
    console.warn('[S4] Inter fonts could not be loaded; Guard text uses the system font.', error instanceof Error ? error.message : error);
    return 'failed';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
