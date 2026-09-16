import * as React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, control, radii } from '../../theme';

const IS_WEB = typeof document !== 'undefined';

export type IconButtonVariant = 'ghost' | 'surface' | 'danger';
export type IconButtonSize = 'sm' | 'md';

type IconButtonProps = {
  /** Text or emoji icon character — do not use decorative screen-reader text here. */
  icon: string;
  accessibilityLabel: string;
  onPress: () => void;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  disabled?: boolean;
  style?: any;
};

const BOX_SIZE: Record<IconButtonSize, number> = {
  sm: 36,
  md: control.minTouchTarget, // 44
};

const ICON_FONT: Record<IconButtonSize, number> = {
  sm: 14,
  md: 16,
};

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  size = 'md',
  variant = 'ghost',
  disabled = false,
  style,
}: IconButtonProps) {
  const boxSize = BOX_SIZE[size];
  const iconFontSize = ICON_FONT[size];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      {...({ onPress, onClick: onPress } as const)}
      style={({ hovered, pressed }: any) => [
        styles.base,
        {
          width:        boxSize,
          height:       boxSize,
          borderRadius: radii.sm,
          opacity:      disabled ? 0.4 : 1,
          backgroundColor: disabled
            ? 'transparent'
            : pressed
            ? pressedBg(variant)
            : hovered
            ? hoveredBg(variant)
            : defaultBg(variant),
        },
        IS_WEB && !disabled ? (styles.cursorPointer as any) : null,
        style,
      ]}
    >
      <Text
        accessible={false}
        style={[
          styles.icon,
          {
            fontSize: iconFontSize,
            color: disabled
              ? colors.disabledText
              : variant === 'danger'
              ? colors.danger
              : colors.textSecondary,
          },
        ]}
      >
        {icon}
      </Text>
    </Pressable>
  );
}

function defaultBg(variant: IconButtonVariant): string {
  return variant === 'surface' ? colors.surfaceSubtle : 'transparent';
}

function hoveredBg(variant: IconButtonVariant): string {
  return variant === 'danger'
    ? 'rgba(180, 35, 24, 0.08)'
    : colors.surfaceSubtle;
}

function pressedBg(variant: IconButtonVariant): string {
  return variant === 'danger'
    ? colors.dangerSurface
    : colors.border;
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  icon: {
    lineHeight: 20,
    textAlign: 'center',
  },
  cursorPointer: { cursor: 'pointer' } as any,
});
