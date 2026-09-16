import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { brand, colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';

type CompanyTopBarProps = {
  pageTitle: string;
  userEmail: string;
  onMenuAction: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  onLogout: () => void;
};

/**
 * CompanyTopBar — fixed 56px application bar for the authenticated company shell.
 *
 * LEFT : hamburger toggle (collapses sidebar or opens overlay nav) + S4 / page breadcrumb
 * RIGHT: refresh + user initial badge + log out
 */
export function CompanyTopBar({
  pageTitle,
  userEmail,
  onMenuAction,
  refreshing,
  onRefresh,
  onLogout,
}: CompanyTopBarProps) {
  const userInitial = userEmail.charAt(0).toUpperCase() || '?';

  return (
    <View style={styles.bar}>
      {/* Left */}
      <View style={styles.left}>
        <Pressable
          onPress={onMenuAction}
          accessibilityRole="button"
          accessibilityLabel="Toggle navigation"
          style={({ pressed }: any) => [
            styles.iconBtn,
            pressed ? styles.iconBtnPressed : null,
            IS_WEB ? (styles.cursorPointer as any) : null,
          ]}
        >
          <Text accessible={false} style={styles.menuIcon}>☰</Text>
        </Pressable>

        <View style={styles.breadcrumb}>
          <Text style={styles.brandMark}>{brand.shortBrand}</Text>
          <Text accessible={false} style={styles.slash}>  /  </Text>
          <Text style={styles.pageTitle} numberOfLines={1}>{pageTitle}</Text>
        </View>
      </View>

      {/* Right */}
      <View style={styles.right}>
        <Pressable
          onPress={onRefresh}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel={refreshing ? 'Refreshing' : 'Refresh data'}
          style={({ pressed }: any) => [
            styles.textBtn,
            refreshing ? styles.textBtnDisabled : null,
            pressed && !refreshing ? styles.textBtnPressed : null,
            IS_WEB && !refreshing ? (styles.cursorPointer as any) : null,
          ]}
        >
          <Text style={[styles.textBtnLabel, refreshing ? styles.textBtnLabelDisabled : null]}>
            {refreshing ? 'Refreshing…' : '↻ Refresh'}
          </Text>
        </Pressable>

        <View
          style={styles.identityBadge}
          accessibilityLabel={`Signed in as ${userEmail}`}
        >
          <Text accessible={false} style={styles.identityInitial}>{userInitial}</Text>
        </View>

        <Pressable
          onPress={onLogout}
          accessibilityRole="button"
          accessibilityLabel="Log out"
          style={({ pressed }: any) => [
            styles.textBtn,
            pressed ? styles.textBtnPressed : null,
            IS_WEB ? (styles.cursorPointer as any) : null,
          ]}
        >
          <Text style={styles.textBtnLabel}>Log out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.primaryNavy,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148, 163, 184, 0.18)',
    gap: spacing.md,
    flexShrink: 0,
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minWidth: 0,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(148, 163, 184, 0.1)',
    flexShrink: 0,
  },
  iconBtnPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.2)',
  },
  menuIcon: {
    color: colors.textOnBrand,
    fontSize: 16,
    lineHeight: 20,
  },
  breadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  brandMark: {
    color: colors.accentTeal,
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.5,
    flexShrink: 0,
  },
  slash: {
    color: 'rgba(148, 163, 184, 0.45)',
    fontSize: 13,
    flexShrink: 0,
  },
  pageTitle: {
    color: colors.textOnBrand,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.1,
    flex: 1,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 0,
  },
  textBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.28)',
    backgroundColor: 'transparent',
    minHeight: 32,
    justifyContent: 'center',
  },
  textBtnDisabled: {
    opacity: 0.55,
    borderColor: 'transparent',
  },
  textBtnPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.15)',
  },
  textBtnLabel: {
    color: colors.textOnBrand,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  textBtnLabelDisabled: {
    color: 'rgba(226, 232, 240, 0.6)',
  },
  identityBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accentTeal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityInitial: {
    color: colors.primaryNavy,
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 18,
  },
  cursorPointer: { cursor: 'pointer' },
});
