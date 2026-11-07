import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { brand, colors, control, radii, spacing } from '../../../theme';
import type { GuardHomeLayout } from './guardHomeLayout';

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
 * Navy, so the light status-bar content App sets stays readable. On a narrow screen or with large text the actions
 * move to a second row rather than squeezing or clipping the title.
 */
export interface GuardHeaderProps {
  title: string;
  productLabel: string;
  productIsUat: boolean;
  layout: Pick<GuardHomeLayout, 'headerWraps'>;
  notifications: ReactNode;
  onLogout: () => void;
}

export function GuardHeader({ title, productLabel, productIsUat, layout, notifications, onLogout }: GuardHeaderProps) {
  const showProductLabel = productIsUat || productLabel !== brand.shortBrand;
  const actions = (
    <View style={[styles.actions, layout.headerWraps && styles.actionsWrapped]} testID="guard-header-actions">
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
      <View style={styles.titleRow} testID="guard-header-title-row">
        <Text style={styles.brandMark} accessibilityLabel={brand.appName}>{brand.shortBrand}</Text>
        <View style={styles.titleBlock}>
          <Text style={styles.title} accessibilityRole="header">{title}</Text>
          {showProductLabel ? (
            <Text style={[styles.productLabel, productIsUat && styles.uatLabel]}>{productLabel}</Text>
          ) : null}
        </View>
        {layout.headerWraps ? null : actions}
      </View>
      {layout.headerWraps ? actions : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.primaryNavy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  brandMark: { color: colors.accentTeal, fontSize: 22, fontWeight: '900', letterSpacing: 1 },
  titleBlock: { flex: 1, minWidth: 0 },
  title: { color: colors.textOnBrand, fontSize: 20, lineHeight: 26, fontWeight: '800', letterSpacing: -0.2 },
  productLabel: { color: colors.border, fontSize: 13, lineHeight: 18 },
  uatLabel: { color: '#FBBF24', fontWeight: '800' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
  actionsWrapped: { flexWrap: 'wrap', justifyContent: 'flex-end' },
  logoutButton: {
    minHeight: control.minTouchTarget,
    justifyContent: 'center',
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.primaryNavySoft,
    paddingHorizontal: spacing.md,
  },
  logoutText: { color: colors.textOnBrand, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.8 },
});
