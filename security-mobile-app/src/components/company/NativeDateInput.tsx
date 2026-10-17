import * as React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { colors, control, radii, spacing } from '../../theme';
import {
  UK_OPERATIONAL_DATE_PLACEHOLDER,
  isoToUkOperationalDate,
  ukOperationalDateError,
  ukOperationalDateToIso,
} from '../../services/ukDate';

const IS_WEB = typeof document !== 'undefined';
/** The browser's own date element, used on web only for its picker. */
const PickerTag: any = 'input';

/**
 * The one date control the company workspaces share: Live Operations and the Rota Planner.
 *
 * S4 Live Operations Phase 3: people read and type DD-MM-YYYY; the value in and out stays the ISO
 * YYYY-MM-DD the app stores, filters on and sends. A browser's own `<input type="date">` displays in the
 * browser's locale and cannot be made to show DD-MM-YYYY, so the field is a text box everywhere, and on
 * web a calendar button opens the native picker as a helper.
 *
 * `onChange` receives:
 *   - the ISO date, when the text is a real date (31-02-2026 and 29-02-2025 are not)
 *   - '' when the field is cleared
 *   - the typed text itself when it is not a real date, so a form's own validation sees an invalid
 *     value and refuses it — a half-typed date is never silently replaced by the previous valid one.
 * Parsing, validation and the error wording all come from services/ukDate.ts: there is no second parser.
 */
export function NativeDateInput({ value, onChange, hasError, accessibilityLabel, style }: {
  value: string;
  onChange: (v: string) => void;
  hasError?: boolean;
  accessibilityLabel?: string;
  /** Layout overrides for the text field (width, height, font size). */
  style?: Record<string, unknown>;
}) {
  const display = (iso: string) => isoToUkOperationalDate(iso) ?? iso;
  const [draft, setDraft] = React.useState(() => display(value));
  const [touched, setTouched] = React.useState(false);

  // Follow the value when it changes from outside (Today, the day steps, a form reset). The draft is left
  // alone while it already means that value, so typing "1-1-2026" is not rewritten under the cursor.
  React.useEffect(() => {
    const draftIso = ukOperationalDateToIso(draft) ?? draft.trim();
    if (draftIso !== value) setDraft(display(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (text: string) => {
    setDraft(text);
    const trimmed = text.trim();
    onChange(trimmed ? ukOperationalDateToIso(trimmed) ?? trimmed : '');
  };

  // Shown once the field has been left, or as soon as a full-length entry is wrong.
  const error = touched || draft.trim().length >= 10 ? ukOperationalDateError(draft) : null;
  const invalid = Boolean(hasError || error);

  const pickerRef = React.useRef<any>(null);
  const isoValue = ukOperationalDateToIso(draft) ?? '';

  return (
    <View>
      <View style={rowStyle}>
        <TextInput
          value={draft}
          onChangeText={emit}
          onBlur={() => setTouched(true)}
          accessibilityLabel={accessibilityLabel}
          placeholder={UK_OPERATIONAL_DATE_PLACEHOLDER}
          placeholderTextColor={colors.fieldPlaceholder}
          maxLength={10}
          {...(IS_WEB ? ({ inputMode: 'numeric' } as any) : { keyboardType: 'numbers-and-punctuation' })}
          style={[nativeInputStyle, { flex: 1, minWidth: 0 }, invalid && nativeInputErrorStyle, style as any]}
        />
        {IS_WEB ? (
          <View style={pickerWrapStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel ? `Choose ${accessibilityLabel.toLowerCase()} from a calendar` : 'Choose a date from a calendar'}
              style={pickerButtonStyle}
              onPress={() => {
                try { pickerRef.current?.showPicker?.(); } catch { pickerRef.current?.focus?.(); }
              }}
            >
              <Text style={pickerGlyphStyle}>📅</Text>
            </Pressable>
            <PickerTag
              ref={pickerRef}
              type="date"
              tabIndex={-1}
              aria-hidden
              value={isoValue}
              onChange={(e: any) => {
                const iso = String(e.target.value || '');
                setTouched(true);
                emit(iso ? isoToUkOperationalDate(iso) ?? '' : '');
              }}
              // A plain object: this is a DOM element, where a React Native style array would not apply.
              style={HIDDEN_PICKER_STYLE}
            />
          </View>
        ) : null}
      </View>
      {error ? (
        <Text style={errorTextStyle} {...({ accessibilityLiveRegion: 'polite', role: 'alert' } as any)}>{error}</Text>
      ) : null}
    </View>
  );
}

/** Underneath the calendar button, invisible: only its picker is used. */
const HIDDEN_PICKER_STYLE = {
  position: 'absolute', left: 0, bottom: 0, width: 1, height: 1, opacity: 0, border: 0, padding: 0,
  pointerEvents: 'none',
};

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

const rowStyle: any = { flexDirection: 'row', alignItems: 'center', gap: 4 };
const pickerWrapStyle: any = { position: 'relative' };
const pickerButtonStyle: any = {
  width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
  borderRadius: radii.sm, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.card,
};
const pickerGlyphStyle: any = { fontSize: 14 };
const errorTextStyle: any = { marginTop: 4, fontSize: 12, color: colors.danger };
