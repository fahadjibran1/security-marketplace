/**
 * S4 Guard app — Premium Enterprise visual tokens (S4-UX Stage 1: colours and component shapes).
 *
 * Guard-scoped on purpose. The shared brand tokens in ./brand (colors.primaryNavy, primaryNavySoft, accentTeal,
 * danger, textPrimary, background …) also paint the Company, Client and Platform Admin workspaces, which keep their
 * current look until a change there is approved. Only Guard surfaces import these.
 *
 * Typography (S4-UX Stage 2): Inter 400/500/600/700 for the Guard Home only; see guardType below.
 */
import { colors } from './brand';

export const guardColors = {
  /** Header, record tiles, Book Off outline, the selected tab's label. */
  navy: '#14263D',
  /** The Notifications control's fill on the navy header. */
  navySecondary: '#28445F',
  /** Outline of the header controls (Notifications, Log out): 3:1 against the navy header. */
  headerControlBorder: '#56718C',
  /** Primary actions (Record Welfare Check, Book On), the selected-tab indicator and the Offers badge. */
  teal: '#087F8C',
  /** The "S4" mark on the navy header: kept at the existing teal, 5.1:1 on navy. */
  headerMark: '#16A6A1',
  canvas: '#F5F7FA',
  surface: '#FFFFFF',
  textPrimary: '#17283C',
  /** Emergency and every danger state on the Guard Home (overdue, missed). */
  emergency: '#B42332',
  cardBorder: '#D7E0E8',
  /** The live shift's edge: green is operational success, never decoration. */
  liveEdge: colors.success,
  /** The selected tab's background tint. */
  navActiveTint: colors.accentTealSoft,
} as const;

export const guardShape = {
  /** Cards: 8dp corners and a 1dp border, no shadow. */
  cardRadius: 8,
  cardBorderWidth: 1,
  /** Buttons, tiles, Emergency and the header controls. */
  controlRadius: 6,
  /** Small status pills (LIVE). */
  statusRadius: 4,
  /** Outlined buttons (Book Off). */
  outlineWidth: 1.5,
  /** The live shift's left edge. */
  liveEdgeWidth: 4,
} as const;

/**
 * S4-UX Stage 2 — Inter, one family name per weight file (loaded by ./guardFonts.ts, official Inter 4.1, SIL OFL 1.1).
 *
 * The weight is chosen by the family name, never by `fontWeight`. expo-font registers each file as its own family at
 * normal weight, so on Android a `fontWeight` of 600 or more makes React Native look for a separate bold file, not find
 * one, and draw the system bold font instead of Inter; on web it makes the browser fake a heavier weight on top of the
 * real one. So these tokens carry no `fontWeight`, and only 400/500/600/700 exist (no 800/900 is synthesised).
 *
 * If the fonts cannot be loaded, the family is unknown and iOS, Android and web all fall back to the system font at
 * regular weight: the screen stays fully usable, and guardFonts.ts reports the failure.
 *
 * Accessibility font scaling is untouched: sizes are plain sp/pt values and allowFontScaling keeps its default.
 */
export const guardFontFamily = {
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semibold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
} as const;

export const guardType = {
  /** Screen title in the Guard header: 20/26, 700. */
  title: { fontFamily: guardFontFamily.bold, fontSize: 20, lineHeight: 26 },
  /** The "S4" mark: 22, 700. */
  mark: { fontFamily: guardFontFamily.bold, fontSize: 22 },
  /** Site name and shift time: 18/24, 700. */
  siteTime: { fontFamily: guardFontFamily.bold, fontSize: 18, lineHeight: 24 },
  /** Shift date: 14/20, 500. */
  date: { fontFamily: guardFontFamily.medium, fontSize: 14, lineHeight: 20 },
  /** Meta text: 14/20, 400. */
  meta: { fontFamily: guardFontFamily.regular, fontSize: 14, lineHeight: 20 },
  /** Section labels: 12/16, 600. */
  sectionLabel: { fontFamily: guardFontFamily.semibold, fontSize: 12, lineHeight: 16 },
  /** Status words such as DUE: 14/20, 700. */
  status: { fontFamily: guardFontFamily.bold, fontSize: 14, lineHeight: 20 },
  /** Buttons (Record Welfare Check, Book On/Off, Emergency, SOS): 16/22, 700. */
  button: { fontFamily: guardFontFamily.bold, fontSize: 16, lineHeight: 22 },
  /** Record tiles (Log Book, Site Request, Incident): 15/20, 700. */
  tile: { fontFamily: guardFontFamily.bold, fontSize: 15, lineHeight: 20 },
  /** Bottom navigation labels: 13/18, 600; the selected tab 700. */
  nav: { fontFamily: guardFontFamily.semibold, fontSize: 13, lineHeight: 18 },
  navActive: { fontFamily: guardFontFamily.bold },
  /** Header controls (Notifications, Log out): 14/20, 600. */
  headerButton: { fontFamily: guardFontFamily.semibold, fontSize: 14, lineHeight: 20 },
} as const;
