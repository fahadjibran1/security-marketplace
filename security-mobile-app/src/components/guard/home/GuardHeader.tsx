import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { brand, colors, control, spacing } from '../../../theme';
import { guardColors, guardShape } from '../../../theme/guard';

// The project's react-native type shim (src/types/react-shims.d.ts) does not export event types; these are the only
// fields read here.
type LayoutEvent = { nativeEvent: { layout: { width: number } } };
type TextLayoutEvent = { nativeEvent: { lines?: Array<{ width: number }> } };

/**
 * S4-UX-01.6 — the Guard's single header. It replaces, for Guards only, App's navy top bar AND the dashboard's own
 * title row, so a Guard sees one bar instead of two.
 *
 * It keeps everything both of them did:
 *  - the S4 mark, and the product label whenever it says more than the mark (the UAT app's "S4 UAT · STAGING");
 *  - the screen title;
 *  - the Notifications control, passed in unchanged by the dashboard (same handler, badge and labels);
 *  - Log out, calling the same `onLogout` App passes down (unregister push, sign out, clear the session).
 *
 * Navy, continuing the navy status-bar backdrop App draws above it for Guards, so the light status-bar content stays
 * readable.
 *
 * S4-UX-01.2a — wrapping is content-driven, not a width breakpoint. The actions share the title's row until the title
 * would need a second line beside them; then they move to their own right-aligned row and the title keeps the full
 * width. They move back only when the title's measured one-line width fits beside them again. (Plain flex-wrap was
 * tried first: on device Yoga shrank the title to two lines instead of wrapping the actions, CP-A shot 2.)
 */
export interface GuardHeaderProps {
  title: string;
  productLabel: string;
  productIsUat: boolean;
  notifications: ReactNode;
  onLogout: () => void;
  /**
   * S4-UX-01.3 Variant B (review only, see guardEmergencyPresentation.ts): a compact SOS control that opens the
   * existing Emergency form. Null (the default) renders nothing, which is Variant A.
   */
  sos?: { accessibilityLabel: string; onPress: () => void } | null;
}

const ROW_GAP = spacing.md;
/** The SOS control is larger than the 44pt minimum, like the Emergency bar's button. */
export const HEADER_SOS_MIN_SIZE = 48;

export interface HeaderFitInput {
  /** Whether the actions are currently on their own row. */
  wrapped: boolean;
  /** Lines the title (or product label) occupies in its current layout. */
  lines: number;
  /** The widest of those lines, in points: the text's natural width when it is on one line. */
  textWidth: number;
  /** Width of the header's content box, the S4 mark, and the actions group, in points (0 = not measured yet). */
  rowWidth: number;
  markWidth: number;
  actionsWidth: number;
}

/**
 * Pure decision for the next `wrapped` value. Beside the actions, a title that needs more than one line wraps the
 * actions away. Once wrapped, the title has the full width; the actions come back only if mark + title + actions
 * now fit on one line. The two states cannot alternate: the condition that unwraps is exactly a one-line fit.
 */
export function nextHeaderWrapped({ wrapped, lines, textWidth, rowWidth, markWidth, actionsWidth }: HeaderFitInput): boolean {
  if (!wrapped) return lines > 1;
  if (lines !== 1 || rowWidth <= 0 || actionsWidth <= 0) return true;
  return markWidth + ROW_GAP + Math.ceil(textWidth) + ROW_GAP + actionsWidth > rowWidth;
}

export function GuardHeader({ title, productLabel, productIsUat, notifications, onLogout, sos = null }: GuardHeaderProps) {
  const showProductLabel = productIsUat || productLabel !== brand.shortBrand;
  const [wrapped, setWrapped] = useState(false);
  const sizes = useRef({ row: 0, mark: 0, actions: 0, text: { title: { lines: 0, width: 0 }, label: { lines: 0, width: 0 } } });

  const evaluate = useCallback(() => {
    const s = sizes.current;
    const texts = showProductLabel ? [s.text.title, s.text.label] : [s.text.title];
    if (texts.some((t) => t.lines === 0)) return;
    const lines = Math.max(...texts.map((t) => t.lines));
    const textWidth = Math.max(...texts.map((t) => t.width));
    setWrapped((current) => nextHeaderWrapped({ wrapped: current, lines, textWidth, rowWidth: s.row, markWidth: s.mark, actionsWidth: s.actions }));
  }, [showProductLabel]);

  const onText = (key: 'title' | 'label') => (e: TextLayoutEvent) => {
    const lines = e.nativeEvent.lines || [];
    sizes.current.text[key] = { lines: lines.length, width: lines.reduce((w: number, l: { width: number }) => Math.max(w, l.width), 0) };
    evaluate();
  };
  const onSize = (key: 'row' | 'mark' | 'actions') => (e: LayoutEvent) => {
    sizes.current[key] = e.nativeEvent.layout.width;
    evaluate();
  };

  const actions = (
    <View style={[styles.actions, wrapped && styles.actionsWrapped]} onLayout={onSize('actions')} testID="guard-header-actions">
      {sos ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={sos.accessibilityLabel}
          accessibilityHint="Opens the Emergency form. Sending it needs a connection."
          onPress={sos.onPress}
          style={({ pressed }: { pressed: boolean }) => [styles.sosButton, pressed && styles.pressed]}
          testID="guard-header-sos"
        >
          <Text style={styles.sosText}>SOS</Text>
        </Pressable>
      ) : null}
      {notifications}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Log out"
        onPress={onLogout}
        style={({ pressed }: { pressed: boolean }) => [styles.logoutButton, pressed && styles.pressed]}
      >
        <Text style={styles.logoutText}>Log out</Text>
      </Pressable>
    </View>
  );

  return (
    <View style={styles.header} testID="guard-header">
      <View style={styles.row} onLayout={onSize('row')} testID="guard-header-row">
        <View style={styles.identity} testID="guard-header-title-row">
          <Text style={styles.brandMark} accessibilityLabel={brand.appName} onLayout={onSize('mark')}>{brand.shortBrand}</Text>
          <View style={styles.titleBlock}>
            <Text style={styles.title} accessibilityRole="header" onTextLayout={onText('title')}>{title}</Text>
            {showProductLabel ? (
              <Text style={[styles.productLabel, productIsUat && styles.uatLabel]} onTextLayout={onText('label')}>{productLabel}</Text>
            ) : null}
          </View>
        </View>
        {wrapped ? null : actions}
      </View>
      {wrapped ? actions : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: guardColors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: ROW_GAP },
  identity: { flexDirection: 'row', alignItems: 'center', gap: ROW_GAP, flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0 },
  brandMark: { color: guardColors.headerMark, fontSize: 22, fontWeight: '900', letterSpacing: 1 },
  titleBlock: { flexShrink: 1, minWidth: 0 },
  title: { color: colors.textOnBrand, fontSize: 20, lineHeight: 26, fontWeight: '800', letterSpacing: -0.2 },
  productLabel: { color: colors.border, fontSize: 13, lineHeight: 18 },
  uatLabel: { color: '#FBBF24', fontWeight: '800' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
  // On its own row: right-aligned, and its two buttons may wrap if even they do not fit side by side.
  actionsWrapped: { alignSelf: 'flex-end', flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 1, maxWidth: '100%' },
  // Stage 1: a compact rectangular control whose outline is 3:1 against the navy header (the Notifications control,
  // passed in by the dashboard, matches it).
  logoutButton: {
    minHeight: control.minTouchTarget,
    justifyContent: 'center',
    borderRadius: guardShape.controlRadius,
    borderWidth: 1,
    borderColor: guardColors.headerControlBorder,
    paddingHorizontal: spacing.md,
  },
  logoutText: { color: colors.textOnBrand, fontSize: 14, fontWeight: '700' },
  sosButton: {
    minHeight: HEADER_SOS_MIN_SIZE,
    minWidth: HEADER_SOS_MIN_SIZE + spacing.lg,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: guardShape.controlRadius,
    backgroundColor: guardColors.emergency,
    borderWidth: 2,
    borderColor: colors.textOnBrand,
    paddingHorizontal: spacing.md,
  },
  sosText: { color: colors.textOnBrand, fontSize: 16, fontWeight: '900', letterSpacing: 1 },
  pressed: { opacity: 0.8 },
});
