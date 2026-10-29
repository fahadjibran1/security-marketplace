// Shared building blocks for the Patrol Management page (Patrols P1-D). The S4 Navy + Teal design system only: theme
// tokens, Card, Button, StatusBadge, StatePanel and FormField from the existing component library.

import * as React from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { StatusBadge } from '../StatusBadge';
import { StatePanel } from '../StatePanel';
import { FieldInput, FormField } from '../ui/FormField';
import { classifyPatrolFailure, patrolFailureMessage, type PatrolFailureKind } from './patrolAccess';
import { PATROL_POLL_MS, shouldPollPatrols, type PatrolTone } from './patrolPresentation';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as any) : null;

// ─── data ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PatrolResource<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  failure: PatrolFailureKind | null;
  reload: (quiet?: boolean) => Promise<void>;
};

/** Whether the page is on screen: the browser tab is visible (web) or the app is in the foreground (native). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = React.useState(() => !(IS_WEB && (document as any).visibilityState === 'hidden'));
  React.useEffect(() => {
    if (IS_WEB && typeof (document as any).addEventListener === 'function') {
      const onChange = () => setVisible((document as any).visibilityState !== 'hidden');
      (document as any).addEventListener('visibilitychange', onChange);
      return () => (document as any).removeEventListener('visibilitychange', onChange);
    }
    try {
      const sub = AppState.addEventListener('change', (next: string) => setVisible(next === 'active'));
      return () => sub?.remove?.();
    } catch {
      return undefined;
    }
  }, []);
  return visible;
}

/**
 * Re-runs `tick` every PATROL_POLL_MS while enabled AND on screen, and never after a refusal that a retry cannot change
 * (the switch is off, the permission is gone). One interval per caller, always cleared on unmount.
 */
export function usePatrolPolling(tick: () => void, enabled: boolean, failure: PatrolFailureKind | null) {
  const visible = usePageVisible();
  const ref = React.useRef(tick);
  ref.current = tick;
  const active = shouldPollPatrols({ enabled, hidden: !visible, failure });
  React.useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => ref.current(), PATROL_POLL_MS);
    return () => clearInterval(id);
  }, [active]);
}

/**
 * One server read with loading / error / refusal state. `key` identifies what is being read (the company and the
 * filters): when it changes the previous answer is dropped at once, so nothing from another company or filter is ever
 * shown while the new one loads. A late answer for an old key is discarded.
 */
export function usePatrolResource<T>(
  key: string,
  load: () => Promise<T>,
  options: { enabled?: boolean; poll?: boolean } = {},
): PatrolResource<T> {
  const enabled = options.enabled !== false;
  const [state, setState] = React.useState<{ key: string; data: T | null; loading: boolean; error: string | null; failure: PatrolFailureKind | null }>(
    { key, data: null, loading: enabled, error: null, failure: null },
  );
  const loadRef = React.useRef(load);
  loadRef.current = load;
  const current = React.useRef(key);
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  const reload = React.useCallback(async (quiet = false) => {
    const k = current.current;
    if (!quiet) setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loadRef.current();
      if (!mounted.current || current.current !== k) return;
      setState({ key: k, data, loading: false, error: null, failure: null });
    } catch (error) {
      if (!mounted.current || current.current !== k) return;
      setState((s) => ({ key: k, data: s.key === k ? s.data : null, loading: false, error: patrolFailureMessage(error, 'Unable to load this right now.'), failure: classifyPatrolFailure(error) }));
    }
  }, []);

  React.useEffect(() => {
    current.current = key;
    if (!enabled) {
      setState({ key, data: null, loading: false, error: null, failure: null });
      return;
    }
    setState({ key, data: null, loading: true, error: null, failure: null });
    void reload();
  }, [key, enabled, reload]);

  usePatrolPolling(() => { void reload(true); }, Boolean(options.poll) && enabled, state.failure);

  const visible = state.key === key ? state : { key, data: null, loading: enabled, error: null, failure: null };
  return { data: visible.data, loading: visible.loading, error: visible.error, failure: visible.failure, reload };
}

// ─── presentation ─────────────────────────────────────────────────────────────────────────────────────────────────

export function PatrolPanel({ title, subtitle, right, children }: React.PropsWithChildren<{ title: string; subtitle?: string; right?: any; key?: string | number }>) {
  return (
    <View style={ui.panel}>
      <View style={ui.panelHead}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={ui.panelTitle} accessibilityRole="header">{title}</Text>
          {subtitle ? <Text style={ui.panelSubtitle}>{subtitle}</Text> : null}
        </View>
        {right ?? null}
      </View>
      <View style={ui.panelBody}>{children}</View>
    </View>
  );
}

export function Badge({ label, tone }: { label: string; tone: PatrolTone; key?: string | number }) {
  return <StatusBadge label={label} tone={tone} size="small" />;
}

export function BadgeRow({ badges }: { badges: Array<{ label: string; tone: PatrolTone }> }) {
  if (!badges.length) return null;
  return <View style={ui.badgeRow}>{badges.map((b) => <Badge key={b.label} label={b.label} tone={b.tone} />)}</View>;
}

/** Loading / refused / error / empty, the same way everywhere on the page. Returns null when there is content. */
export function ResourceState({ resource, empty, emptyMessage, what }: { resource: Pick<PatrolResource<unknown>, 'loading' | 'error' | 'failure' | 'reload' | 'data'>; empty: boolean; emptyMessage: string; what: string }) {
  if (resource.loading && resource.data == null) return <StatePanel title={`Loading ${what}…`} loading tone="info" />;
  if (resource.error && resource.data == null) {
    if (resource.failure === 'forbidden') return <StatePanel title="Not available to your role" message={resource.error} tone="empty" />;
    if (resource.failure === 'not_enabled') return <StatePanel title="Patrol Management is not enabled" message="Patrol Management is not enabled for this company." tone="empty" />;
    return <StatePanel title={`Could not load ${what}`} message={resource.error} tone="error" actionLabel="Retry" onAction={() => { void resource.reload(); }} />;
  }
  if (empty) return <StatePanel title={`No ${what}`} message={emptyMessage} tone="empty" />;
  return null;
}

export function Notice({ tone, message }: { tone: 'success' | 'error' | 'info'; message: string }) {
  const palette = tone === 'success'
    ? { bg: colors.successSurface, border: colors.successBorder, fg: colors.success }
    : tone === 'error'
      ? { bg: colors.dangerSurface, border: colors.dangerBorder, fg: colors.danger }
      : { bg: colors.infoSurface, border: colors.infoBorder, fg: colors.info };
  return (
    <View accessibilityRole="alert" style={[ui.notice, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <Text style={[ui.noticeText, { color: palette.fg }]}>{message}</Text>
    </View>
  );
}

export function ChipSelect<T extends string | number>({ label, options, value, onChange, scroll }: {
  label?: string;
  options: Array<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
  scroll?: boolean;
}) {
  const chips = options.map((option) => {
    const active = option.value === value;
    return (
      <Pressable
        key={String(option.value)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={label ? `${label}: ${option.label}` : option.label}
        onPress={() => onChange(option.value)}
        style={[ui.chip, active ? ui.chipActive : null, WEB_PTR]}
      >
        <Text style={[ui.chipText, active ? ui.chipTextActive : null]}>{option.label}</Text>
      </Pressable>
    );
  });
  return (
    <View style={{ gap: spacing.xs }}>
      {label ? <Text style={ui.fieldLabel}>{label}</Text> : null}
      {scroll ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ui.chipRow}>{chips}</ScrollView> : <View style={ui.chipRowWrap}>{chips}</View>}
    </View>
  );
}

export function TextField({ label, value, onChangeText, placeholder, helper, multiline, editable = true }: {
  label: string; value: string; onChangeText: (v: string) => void; placeholder?: string; helper?: string; multiline?: boolean; editable?: boolean; key?: string | number;
}) {
  return (
    <FormField label={label} helperText={helper}>
      <FieldInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        multiline={multiline}
        editable={editable}
        readOnly={!editable}
      />
    </FormField>
  );
}

export function Toggle({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; key?: string | number }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={[ui.toggle, disabled ? { opacity: 0.6 } : null, WEB_PTR]}
    >
      <View style={[ui.toggleBox, value ? ui.toggleBoxOn : null]}><Text style={ui.toggleMark}>{value ? '✓' : ''}</Text></View>
      <Text style={ui.toggleLabel}>{label}</Text>
    </Pressable>
  );
}

export function KeyValue({ label, value }: { label: string; value: string; key?: string | number }) {
  return (
    <View style={ui.kv}>
      <Text style={ui.kvLabel}>{label}</Text>
      <Text style={ui.kvValue}>{value}</Text>
    </View>
  );
}

export function RowCard({ children, onPress, accessibilityLabel }: React.PropsWithChildren<{ onPress?: () => void; accessibilityLabel?: string; key?: string | number }>) {
  if (!onPress) return <View style={ui.row}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={({ pressed }: any) => [ui.row, pressed ? ui.rowPressed : null, WEB_PTR]}>
      {children}
    </Pressable>
  );
}

export const ui = StyleSheet.create({
  panel: { backgroundColor: colors.card, borderRadius: radii.card, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.md },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  panelTitle: { ...typography.sectionTitle, color: colors.primaryNavy },
  panelSubtitle: { ...typography.caption, color: colors.textSecondary },
  panelBody: { gap: spacing.md },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  notice: { borderWidth: 1, borderRadius: radii.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  noticeText: { ...typography.caption, fontWeight: '600' },
  fieldLabel: { ...typography.label, color: colors.textPrimary },
  chipRow: { flexDirection: 'row', gap: spacing.xs, paddingVertical: 2 },
  chipRowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingHorizontal: spacing.md, paddingVertical: 6, backgroundColor: colors.card },
  chipActive: { backgroundColor: colors.primaryNavy, borderColor: colors.primaryNavy },
  chipText: { ...typography.caption, color: colors.textPrimary, fontWeight: '600' },
  chipTextActive: { color: colors.textOnBrand },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 36 },
  toggleBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: colors.fieldBorder, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  toggleBoxOn: { backgroundColor: colors.accentTealStrong, borderColor: colors.accentTealStrong },
  toggleMark: { color: colors.textOnBrand, fontSize: 13, fontWeight: '700' },
  toggleLabel: { ...typography.caption, color: colors.textPrimary, flexShrink: 1 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 2, flexWrap: 'wrap' },
  kvLabel: { ...typography.caption, color: colors.textSecondary },
  kvValue: { ...typography.caption, color: colors.textPrimary, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  row: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, padding: spacing.md, gap: spacing.xs, backgroundColor: colors.card },
  rowPressed: { backgroundColor: colors.surfaceSubtle },
  rowTitle: { ...typography.panelHeading, color: colors.textPrimary },
  rowMeta: { ...typography.caption, color: colors.textSecondary },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  muted: { ...typography.caption, color: colors.textMuted },
});
