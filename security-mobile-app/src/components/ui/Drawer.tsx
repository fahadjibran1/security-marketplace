import * as React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';

const IS_WEB = typeof document !== 'undefined';

type DrawerProps = React.PropsWithChildren<{
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Footer slot — typically contains primary and secondary Button components. */
  footer?: any;
  /**
   * Maximum panel width on desktop.
   * Defaults to 480. Use 520 for wider forms (e.g. Site setup).
   */
  width?: number;
  /** Compact density — tighter header/footer for commercial management drawers. */
  compact?: boolean;
}>;

/**
 * Drawer — right-anchored slide-in panel for add/edit workflows.
 *
 * Desktop: fixed panel on the right, backdrop covers the rest of the screen.
 * Mobile/native: full-screen modal (same component, unbounded width).
 *
 * Do NOT convert existing page forms to Drawer in Phase 1C.
 * This component is wired up to real business flows in Phase 1D+.
 */
export function Drawer({ visible, onClose, title, subtitle, children, footer, width = 480, compact }: DrawerProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        {/* Backdrop — tapping closes the drawer */}
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityLabel="Close panel"
          accessibilityRole="button"
        />

        {/* Panel */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[
            styles.panel,
            IS_WEB ? styles.panelRadiusWeb : null,
            IS_WEB ? ({ maxWidth: width } as any) : null,
          ]}
        >
          {/* Header */}
          <View style={[styles.header, compact ? styles.headerCompact : null]}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>{title}</Text>
              {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={({ pressed }: any) => [
                styles.closeBtn,
                pressed ? styles.closeBtnPressed : null,
                IS_WEB ? (styles.closeBtnCursor as any) : null,
              ]}
            >
              <Text accessible={false} style={styles.closeIcon}>✕</Text>
            </Pressable>
          </View>

          {/* Scrollable body */}
          <ScrollView
            style={styles.body}
            contentContainerStyle={compact ? styles.bodyContentCompact : styles.bodyContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            {children}
          </ScrollView>

          {/* Footer */}
          {footer ? <View style={[styles.footer, compact ? styles.footerCompact : null]}>{footer}</View> : null}
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: 'rgba(11, 31, 51, 0.5)',
  },
  backdrop: {
    flex: 1,
  },
  panel: {
    width: '100%',
    backgroundColor: colors.card,
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.09,
    shadowRadius: 24,
    shadowOffset: { width: -4, height: 0 },
    elevation: 8,
  },
  panelRadiusWeb: {
    borderTopLeftRadius: radii.drawer,
    borderBottomLeftRadius: radii.drawer,
  } as any,
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  headerCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  title: {
    ...typography.heading,
    color: colors.textPrimary,
  },
  subtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSubtle,
    flexShrink: 0,
  },
  closeBtnPressed: {
    backgroundColor: colors.border,
  },
  closeBtnCursor: { cursor: 'pointer' } as any,
  closeIcon: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textSecondary,
    lineHeight: 18,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: spacing.xl,
    gap: spacing.lg,
    flexGrow: 1,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  // ── Compact density overrides ──────────────────────────────────────────────
  headerCompact: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  footerCompact: {
    paddingVertical: spacing.md,
  },
  bodyContentCompact: {
    flexGrow: 1,
  },
});
