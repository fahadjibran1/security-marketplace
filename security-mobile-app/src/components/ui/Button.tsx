import * as React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors, control, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  fullWidth?: boolean;
  style?: any;
};

type VariantTokens = {
  bg: string;
  bgHover: string;
  bgPressed: string;
  bgDisabled: string;
  fg: string;
  fgDisabled: string;
  border: string;
  borderWidth: number;
};

const VARIANTS: Record<ButtonVariant, VariantTokens> = {
  primary: {
    bg:         colors.accentTeal,
    bgHover:    colors.accentTealStrong,
    bgPressed:  colors.accentTealStrong,
    bgDisabled: colors.disabledSurface,
    fg:         colors.textOnBrand,
    fgDisabled: colors.disabledText,
    border:     'transparent',
    borderWidth: 0,
  },
  secondary: {
    bg:         colors.card,
    bgHover:    colors.surfaceSubtle,
    bgPressed:  colors.surfaceSubtle,
    bgDisabled: colors.card,
    fg:         colors.primaryNavy,
    fgDisabled: colors.disabledText,
    border:     colors.border,
    borderWidth: 1.5,
  },
  tertiary: {
    bg:         'transparent',
    bgHover:    colors.surfaceSubtle,
    bgPressed:  colors.surfaceSubtle,
    bgDisabled: 'transparent',
    fg:         colors.accentTeal,
    fgDisabled: colors.disabledText,
    border:     'transparent',
    borderWidth: 0,
  },
  danger: {
    bg:         colors.danger,
    bgHover:    '#941F15',
    bgPressed:  '#941F15',
    bgDisabled: colors.disabledSurface,
    fg:         '#FFFFFF',
    fgDisabled: colors.disabledText,
    border:     'transparent',
    borderWidth: 0,
  },
};

const SIZE_HEIGHT: Record<ButtonSize, number> = {
  sm: control.buttonHeightSm,
  md: control.buttonHeightMd,
  lg: control.buttonHeight,
};

const SIZE_PADDING_H: Record<ButtonSize, number> = {
  sm: spacing.md,
  md: spacing.lg,
  lg: spacing.xl,
};

const SIZE_LABEL: Record<ButtonSize, { fontSize: number; lineHeight: number; fontWeight: string }> = {
  sm: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  md: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  lg: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  accessibilityLabel,
  fullWidth = false,
  style,
}: ButtonProps) {
  const v = VARIANTS[variant];
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      {...({ onPress, onClick: onPress } as const)}
      style={({ hovered, pressed }: any) => [
        styles.base,
        {
          minHeight:        SIZE_HEIGHT[size],
          paddingHorizontal: SIZE_PADDING_H[size],
          borderWidth:      v.borderWidth,
          borderColor:      v.border,
          backgroundColor:  isDisabled
            ? v.bgDisabled
            : pressed
            ? v.bgPressed
            : hovered
            ? v.bgHover
            : v.bg,
          borderRadius: radii.sm,
          alignSelf:    fullWidth ? 'stretch' : 'flex-start',
          opacity:      isDisabled ? 0.65 : 1,
        },
        IS_WEB && !isDisabled ? (styles.cursorPointer as any) : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'secondary' || variant === 'tertiary' ? colors.accentTeal : colors.textOnBrand}
        />
      ) : (
        <Text
          style={[styles.labelBase, SIZE_LABEL[size] as any, { color: isDisabled ? v.fgDisabled : v.fg }]}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  labelBase: {
    textAlign: 'center',
  },
  cursorPointer: { cursor: 'pointer' } as any,
});
