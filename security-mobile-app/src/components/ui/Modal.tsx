import * as React from 'react';
import { KeyboardAvoidingView, Modal as RNModal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '../../theme';
import { resolveModalLayout, type ModalPlatform, type SafeAreaInsets } from './modalLayout';

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
 *
 * WHY THIS IS THE HOST FOR EVERY FORM (Phase 2)
 * A real RNModal renders in its own native window above the host view hierarchy, so the persistent
 * bottom navigation cannot paint over it — which is precisely what happened to the Guard action forms
 * when they were absolutely-positioned Views with a zIndex and no elevation. See modalLayout.ts.
 *
 * The footer is rendered OUTSIDE the scrollable body. That is the property that keeps Submit reachable:
 * however long the content is, and whatever the keyboard does, the action row is still there.
 */
export function AppModal(props: AppModalProps) {
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  return (
    <ModalFrame
      {...props}
      viewport={{ height, width }}
      insets={{ top: insets.top, bottom: insets.bottom }}
      platform={Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web'}
    />
  );
}

/**
 * The modal's layout, with every environment value passed in rather than read from a hook.
 *
 * Split out so the structure can be executed in tests — a spec can call this directly and walk the
 * element tree to prove there is a scroll container and that the footer sits outside it, which is the
 * behaviour the pilot defect turned on. AppModal above is only the hook wiring.
 */
export function ModalFrame({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'standard',
  closeOnBackdrop = true,
  viewport,
  insets,
  platform,
  keyboardVisible = false,
  keyboardHeight = 0,
}: AppModalProps & {
  viewport: { height: number; width: number };
  insets: SafeAreaInsets;
  platform: ModalPlatform;
  keyboardVisible?: boolean;
  keyboardHeight?: number;
}) {
  const maxWidth = MAX_WIDTH[size];
  const layout = resolveModalLayout({ viewport, insets, platform, keyboardVisible, keyboardHeight });

  return (
    <RNModal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View
        style={[
          styles.overlay,
          {
            paddingTop: layout.overlayPaddingTop,
            paddingBottom: layout.overlayPaddingBottom,
            paddingHorizontal: layout.overlayPaddingHorizontal,
          },
        ]}
      >
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
          behavior={layout.keyboardBehavior}
          style={[
            styles.panel,
            // The ceiling is what gives the body ScrollView something to scroll within. Without it the
            // panel sizes to its content, the content simply overflows the screen, and no amount of
            // ScrollView helps.
            { maxHeight: layout.panelMaxHeight },
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
              // A tap on Submit must land even while an input holds focus; without this the first tap is
              // consumed dismissing the keyboard and the user has to press twice.
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="none"
              showsVerticalScrollIndicator
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
    // Padding is supplied per render from modalLayout, because it carries the safe-area insets.
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
    // Allowed to shrink, so panelMaxHeight is respected rather than being overridden by content height.
    flexShrink: 1,
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
    // flexShrink:0 is the guarantee: a long body can never squeeze the action row down to nothing.
    flexShrink: 0,
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
