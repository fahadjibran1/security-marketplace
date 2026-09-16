import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../../theme';
import { Button } from './Button';
import { AppModal } from './Modal';

type ConfirmationDialogProps = {
  visible: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  /** Clear, plain-language description of what will happen. Avoid jargon. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Use 'danger' when the action is irreversible or destructive
   * (delete, suspend, cancel a financial record).
   * Use 'standard' for non-destructive confirmations.
   */
  variant?: 'standard' | 'danger';
  loading?: boolean;
};

/**
 * ConfirmationDialog — modal for confirming consequential actions.
 *
 * Future uses: suspension, deactivation, deletion, financial lifecycle actions.
 */
export function ConfirmationDialog({
  visible,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'standard',
  loading = false,
}: ConfirmationDialogProps) {
  return (
    <AppModal
      visible={visible}
      onClose={onClose}
      title={title}
      size="small"
      closeOnBackdrop={!loading}
      footer={
        <View style={styles.actions}>
          <Button
            label={cancelLabel}
            variant="secondary"
            onPress={onClose}
            disabled={loading}
          />
          <Button
            label={confirmLabel}
            variant={variant === 'danger' ? 'danger' : 'primary'}
            onPress={onConfirm}
            loading={loading}
          />
        </View>
      }
    >
      <Text style={styles.message}>{message}</Text>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  message: {
    ...typography.body,
    color: colors.textPrimary,
    lineHeight: 26,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
    flex: 1,
  },
});
