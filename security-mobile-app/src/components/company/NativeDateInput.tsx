import * as React from 'react';
import { TextInput } from 'react-native';
import { colors, control, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';

/**
 * The one date control the company workspaces share. (Moved out of the Rota Planner for Live Operations,
 * S4 Live Operations Phase 2.)
 *
 * On web it is the browser's own `<input type="date">`. React Native Web's TextInput drops a `type`
 * attribute, which is why Live Operations' "date picker" was a plain text box. Elsewhere it is a text
 * field. Either way the value in and out is the ISO `YYYY-MM-DD` the rest of the app stores and sends;
 * how dates are displayed to the user is Phase 3's to standardise, in this one place.
 */
export function NativeDateInput({ value, onChange, hasError, accessibilityLabel, style }: {
  value: string;
  onChange: (v: string) => void;
  hasError?: boolean;
  accessibilityLabel?: string;
  /** Layout overrides only (width, margins). */
  style?: Record<string, unknown>;
}) {
  if (IS_WEB) {
    const InputTag: any = 'input';
    return (
      <InputTag
        type="date"
        value={value}
        aria-label={accessibilityLabel}
        onChange={(e: any) => onChange(e.target.value)}
        style={{ ...nativeInputStyle, ...(hasError ? nativeInputErrorStyle : null), ...(style ?? null) }}
      />
    );
  }
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      accessibilityLabel={accessibilityLabel}
      placeholder="YYYY-MM-DD"
      placeholderTextColor={colors.fieldPlaceholder}
      style={[nativeInputStyle, hasError && nativeInputErrorStyle, style as any]}
    />
  );
}

export const nativeInputStyle: any = {
  height: control.inputHeight,
  borderWidth: 1.5,
  borderColor: colors.fieldBorder,
  borderRadius: radii.sm,
  paddingHorizontal: spacing.md,
  fontSize: 14,
  color: colors.textPrimary,
  backgroundColor: colors.card,
  outlineStyle: 'none',
};

export const nativeInputErrorStyle: any = {
  borderColor: colors.danger,
  backgroundColor: colors.dangerSurface,
};
