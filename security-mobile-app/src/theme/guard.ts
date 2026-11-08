/**
 * S4 Guard app — Premium Enterprise visual tokens (S4-UX Stage 1: colours and component shapes).
 *
 * Guard-scoped on purpose. The shared brand tokens in ./brand (colors.primaryNavy, primaryNavySoft, accentTeal,
 * danger, textPrimary, background …) also paint the Company, Client and Platform Admin workspaces, which keep their
 * current look until a change there is approved. Only Guard surfaces import these.
 *
 * Typography is deliberately not here: font families, sizes, weights and line heights are unchanged (Stage 2).
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
