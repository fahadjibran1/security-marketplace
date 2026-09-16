import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, control, radii, spacing, typography } from '../../theme';

const IS_WEB = typeof document !== 'undefined';

// ─── FormField container ──────────────────────────────────────────────────────

type FormFieldProps = React.PropsWithChildren<{
  label: string;
  required?: boolean;
  helperText?: string;
  error?: string;
  style?: any;
}>;

/** Wraps a form control with a label, optional required indicator, helper text, and validation error. */
export function FormField({ label, required, helperText, error, children, style }: FormFieldProps) {
  return (
    <View style={[styles.field, style]}>
      <View style={styles.labelRow}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {required ? (
          <Text style={styles.required} accessibilityLabel="required field">
            *
          </Text>
        ) : null}
      </View>
      {children}
      {error ? (
        <Text style={styles.errorText} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : helperText ? (
        <Text style={styles.helperText}>{helperText}</Text>
      ) : null}
    </View>
  );
}

// ─── FieldInput ───────────────────────────────────────────────────────────────

type FieldInputProps = {
  hasError?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  style?: any;
  onFocus?: (e: any) => void;
  onBlur?: (e: any) => void;
  [key: string]: any;
};

/** Styled single-line text input. Supports focus ring, error, disabled, and read-only states. */
export function FieldInput({ hasError, disabled, readOnly, style, onFocus, onBlur, ...rest }: FieldInputProps) {
  const [focused, setFocused] = React.useState(false);
  const isInert = disabled || readOnly;

  return (
    <TextInput
      placeholderTextColor={colors.fieldPlaceholder}
      {...rest}
      editable={!isInert}
      accessibilityState={{ disabled }}
      onFocus={(e: any) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e: any) => { setFocused(false); onBlur?.(e); }}
      style={[
        styles.input,
        focused && !isInert          ? styles.inputFocused : null,
        hasError                     ? styles.inputError   : null,
        isInert                      ? styles.inputInert   : null,
        IS_WEB ? (styles.inputWeb as any) : null,
        style,
      ]}
    />
  );
}

// ─── FieldTextarea ────────────────────────────────────────────────────────────

type FieldTextareaProps = FieldInputProps & {
  minLines?: number;
};

/** Styled multiline textarea. */
export function FieldTextarea({ minLines = 3, hasError, disabled, readOnly, style, onFocus, onBlur, ...rest }: FieldTextareaProps) {
  const [focused, setFocused] = React.useState(false);
  const isInert = disabled || readOnly;

  return (
    <TextInput
      multiline
      placeholderTextColor={colors.fieldPlaceholder}
      {...rest}
      editable={!isInert}
      accessibilityState={{ disabled }}
      onFocus={(e: any) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e: any) => { setFocused(false); onBlur?.(e); }}
      style={[
        styles.input,
        styles.textarea,
        { minHeight: minLines * 24 + spacing.xl },
        focused && !isInert          ? styles.inputFocused : null,
        hasError                     ? styles.inputError   : null,
        isInert                      ? styles.inputInert   : null,
        IS_WEB ? (styles.inputWeb as any) : null,
        style,
      ]}
    />
  );
}

// ─── FieldSelectTrigger ───────────────────────────────────────────────────────

type FieldSelectTriggerProps = {
  value?: string;
  placeholder?: string;
  onPress?: () => void;
  hasError?: boolean;
  disabled?: boolean;
  style?: any;
};

/**
 * Visual trigger for a custom select/picker.
 * Wire up the `onPress` handler in Phase 1D+ to open a picker or dropdown.
 */
export function FieldSelectTrigger({ value, placeholder, onPress, hasError, disabled, style }: FieldSelectTriggerProps) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="combobox"
      accessibilityState={{ disabled, expanded: false }}
      style={({ pressed }: any) => [
        styles.input,
        styles.selectTrigger,
        hasError             ? styles.inputError  : null,
        disabled             ? styles.inputInert  : null,
        pressed && !disabled ? styles.selectPressed : null,
        IS_WEB && !disabled  ? (styles.selectCursor as any) : null,
        style,
      ]}
    >
      <Text
        style={[styles.selectValue, !value ? styles.selectPlaceholder : null]}
        numberOfLines={1}
      >
        {value || placeholder || 'Select…'}
      </Text>
      <Text accessible={false} style={styles.selectChevron}>▾</Text>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  fieldLabel: {
    ...typography.label,
    color: colors.textPrimary,
  },
  required: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
    color: colors.danger,
  },
  helperText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  errorText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.danger,
  },
  input: {
    height: control.inputHeight,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    ...typography.body,
    color: colors.textPrimary,
    backgroundColor: colors.card,
  },
  inputFocused: {
    borderColor: colors.focusRing,
    borderWidth: 2,
  },
  inputError: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerSurface,
  },
  inputInert: {
    backgroundColor: colors.disabledSurface,
    borderColor: colors.border,
    color: colors.disabledText,
  },
  inputWeb: {
    outlineStyle: 'none',
  } as any,
  textarea: {
    height: undefined,
    paddingVertical: spacing.md,
    textAlignVertical: 'top',
  },
  selectTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectPressed: {
    backgroundColor: colors.surfaceSubtle,
  },
  selectCursor: { cursor: 'pointer' } as any,
  selectValue: {
    flex: 1,
    ...typography.body,
    color: colors.textPrimary,
  },
  selectPlaceholder: {
    color: colors.fieldPlaceholder,
  },
  selectChevron: {
    fontSize: 13,
    color: colors.textSecondary,
    marginLeft: spacing.sm,
    flexShrink: 0,
  },
});
