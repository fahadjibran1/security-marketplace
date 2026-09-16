import * as React from 'react';
import { KeyboardAvoidingView, Modal as RNModal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';

const IS_WEB = typeof document !== 'undefined';

export type ModalSize = 'small' | 'standard' | 'large';

const MAX_WIDTH: Record<ModalSize, number> = {
  small:    360,
  standard: 480,
  large:    640,
};

type AppModalProps = React.PropsWithChildren<{
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Footer slot — typically contains action Button components. Rendered below the scrollable body. */
  footer?: any;
  size?: ModalSize;
  /** Whether tapping the backdrop closes the modal. Set false during destructive confirm while loading. */
  closeOnBackdrop?: boolean;
}>;

/**
 * AppModal — centred overlay modal.
 *
 * Sizes:
 *   small    360px  — confirmation dialogs, short messages
 *   standard 480px  — standard workflows (default)
 *   large    640px  — complex forms, multi-step flows
 *
 * Use ConfirmationDialog for destructive confirms — it wraps this component.
 */
export function AppModal({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'standard',
  closeOnBackdrop = true,
}: AppModalProps) {
  const maxWidth = MAX_WIDTH[size];

  return (
    <RNModal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        {/* Backdrop */}
        {closeOnBackdrop ? (
          <Pressable
            style={styles.backdropFill}
            onPress={onClose}
            accessibilityLabel="Close dialog"
            accessibilityRole="button"
          />
        ) : (
          <View style={styles.backdropFill} pointerEvents="none" />
        )}

        {/* Panel */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[
            styles.panel,
            IS_WEB ? ({ maxWidth } as any) : null,
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
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

          {/* Body */}
          {children ? (
            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
          ) : null}

          {/* Footer */}
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </KeyboardAvoidingView>
      </View>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(11, 31, 51, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  backdropFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  panel: {
    width: '100%',
    backgroundColor: colors.card,
    borderRadius: radii.drawer,
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.12,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
    overflow: 'hidden',
  },
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
    width: 32,
    height: 32,
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
    fontSize: 12,
    fontWeight: '700',
    color: colors.textSecondary,
    lineHeight: 18,
  },
  body: {
    flexShrink: 1,
  },
  bodyContent: {
    padding: spacing.xl,
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
});
