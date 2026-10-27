import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Drawer } from '../ui/Drawer';
import {
  MANUAL_ATTENDANCE_TEXT_MAX,
  VERIFICATION_METHOD_OPTIONS,
  confirmationLines,
  initialFormDateTime,
  limitsOf,
  manualAttendanceTitle,
  validateManualAttendance,
  type ManualAttendanceKind,
} from './manualAttendance';
import { formatUkDateTime, formatUkRange } from '../../services/siteTime';
import type { AttendanceVerificationMethod, ManualAttendanceCapabilities } from '../../types/models';
import { colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

export type ManualAttendanceTarget = {
  kind: ManualAttendanceKind;
  shiftId: number;
  siteName: string;
  guardName: string;
  timeZone: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  /** Effective Book On / Book Off when the form opened, for ordering checks. */
  bookOnAt: string | null;
  bookOffAt: string | null;
  /** Book On for a Missed shift: a late arrival. */
  lateArrival?: boolean;
  /** A correction: the chain tip being corrected. */
  eventId?: number;
  eventType?: 'check-in' | 'check-out';
  currentOccurredAt?: string | null;
};

export type ManualAttendanceSubmission = {
  occurredAt: string;
  reason: string;
  verificationMethod: AttendanceVerificationMethod;
  verificationNote: string;
};

/**
 * Manual Book On / Book Off on a Guard's behalf, and corrections of either (S4 Part B).
 *
 * Opens on the FACTS — site, Guard, schedule, what is already recorded — then the actual time (site-local), the reason,
 * and how Control verified it. Submitting asks for confirmation in place, saying exactly what will be recorded and how
 * it will be shown, before anything is sent. Only a person can do this; nothing calls it automatically.
 */
export function CompanyManualAttendanceDrawer({
  target,
  capabilities,
  submitting,
  error,
  onCancel,
  onSubmit,
}: {
  target: ManualAttendanceTarget | null;
  capabilities: ManualAttendanceCapabilities | null;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: ManualAttendanceSubmission) => void;
}) {
  const [date, setDate] = React.useState('');
  const [time, setTime] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [method, setMethod] = React.useState<AttendanceVerificationMethod | null>(null);
  const [note, setNote] = React.useState('');
  const [attempted, setAttempted] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [confirmedAt, setConfirmedAt] = React.useState<string | null>(null);

  const targetKey = target ? `${target.kind}-${target.shiftId}-${target.eventId ?? ''}` : '';
  // A fresh form per shift and action: nothing typed for the last one is ever pre-filled on the next.
  React.useEffect(() => {
    if (!target) return;
    const initial = initialFormDateTime(target.timeZone, Date.now(), target.kind === 'correct' ? target.currentOccurredAt : null);
    setDate(initial.date);
    setTime(initial.time);
    setReason('');
    setMethod(null);
    setNote('');
    setAttempted(false);
    setConfirming(false);
    setConfirmedAt(null);
  }, [targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) return null;

  const title = manualAttendanceTitle(target.kind, target.eventType, !!target.lateArrival);
  const limits = limitsOf(capabilities);
  const verdict = validateManualAttendance({
    kind: target.kind,
    eventType: target.eventType,
    date,
    time,
    timeZone: target.timeZone,
    reason,
    method,
    note,
    scheduledStart: target.scheduledStart,
    scheduledEnd: target.scheduledEnd,
    // A correction of the Book On is checked against the Book Off and vice versa; never against itself.
    bookOnAt: target.kind === 'correct' && target.eventType === 'check-in' ? null : target.bookOnAt,
    bookOffAt: target.kind === 'correct' && target.eventType === 'check-out' ? null : target.bookOffAt,
    currentOccurredAt: target.currentOccurredAt ?? null,
    nowMs: Date.now(),
    capabilities,
  });

  const review = () => {
    setAttempted(true);
    if (verdict.ok) {
      setConfirmedAt(verdict.occurredAt);
      setConfirming(true);
    }
  };
  const confirm = () => {
    if (!confirmedAt || !method) return;
    onSubmit({ occurredAt: confirmedAt, reason: reason.trim(), verificationMethod: method, verificationNote: note.trim() });
  };

  const facts: Array<[string, string]> = [
    ['Site', target.siteName],
    ['Guard', target.guardName],
    ['Scheduled', formatUkRange(target.scheduledStart, target.scheduledEnd, target.timeZone)],
    ['Book On', target.bookOnAt ? formatUkDateTime(target.bookOnAt, target.timeZone) : 'None recorded'],
    ['Book Off', target.bookOffAt ? formatUkDateTime(target.bookOffAt, target.timeZone) : 'None recorded'],
  ];
  if (target.kind === 'correct' && target.currentOccurredAt) {
    facts.push(['Correcting', `${target.eventType === 'check-out' ? 'Book Off' : 'Book On'} entry #${target.eventId} · ${formatUkDateTime(target.currentOccurredAt, target.timeZone)}`]);
  }

  return (
    <Drawer
      visible
      onClose={onCancel}
      title={title}
      subtitle={`Shift #${target.shiftId}`}
      width={580}
      footer={
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={confirming ? 'Back' : 'Cancel'}
            style={[styles.secondaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={confirming ? () => setConfirming(false) : onCancel}
            disabled={submitting}
          >
            <Text style={styles.secondaryBtnText}>{confirming ? 'Back' : 'Cancel'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={confirming ? `Confirm — ${title}` : 'Review'}
            accessibilityState={{ disabled: submitting }}
            style={[styles.primaryBtn, confirming ? styles.primaryBtnConfirm : null, submitting ? styles.primaryBtnBusy : null, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={confirming ? confirm : review}
            disabled={submitting}
          >
            <Text style={styles.primaryBtnText}>
              {submitting ? 'Recording…' : confirming ? `Confirm — ${title}` : 'Review'}
            </Text>
          </Pressable>
        </View>
      }
    >
      <View style={styles.facts}>
        {facts.map(([label, value]) => (
          <View key={label} style={styles.factRow}>
            <Text style={styles.factLabel}>{label}</Text>
            <Text style={styles.factValue} numberOfLines={2}>{value}</Text>
          </View>
        ))}
      </View>

      {confirming && confirmedAt && method ? (
        <View style={styles.confirmPanel} {...({ accessibilityRole: 'alert' } as any)}>
          <Text style={styles.confirmTitle}>{title}?</Text>
          {confirmationLines({
            kind: target.kind,
            eventType: target.eventType,
            occurredAt: confirmedAt,
            timeZone: target.timeZone,
            guardName: target.guardName,
            method,
            note,
            reason,
            currentOccurredAt: target.currentOccurredAt ?? null,
          }).map((line, index) => (
            <Text key={index} style={styles.confirmText}>{line}</Text>
          ))}
          <Text style={styles.confirmText}>This is recorded in the audit log under your name.</Text>
        </View>
      ) : (
        <>
          <Text style={styles.sectionLabel}>Actual time (site time)</Text>
          <View style={styles.timeRow}>
            <TextInput
              style={[styles.input, styles.dateInput]}
              value={date}
              onChangeText={setDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Actual date"
            />
            <TextInput
              style={[styles.input, styles.timeInput]}
              value={time}
              onChangeText={setTime}
              placeholder="HH:MM"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Actual time"
            />
          </View>
          <Text style={styles.help}>
            When the Guard actually {(target.kind === 'book_off' || target.eventType === 'check-out') ? 'left' : 'started'} — not now, unless it is now.
            Never in the future; between {limits.windowBeforeStartHours} hours before the scheduled start and {limits.windowAfterEndHours} hours after the scheduled end.
            {capabilities && !capabilities.canRecordOlderThan24h
              ? ` Times more than ${limits.ownerAdminOnlyOlderThanHours} hours ago need an Owner or Admin.`
              : ''}
          </Text>

          <Text style={styles.sectionLabel}>How Control verified it</Text>
          <View style={styles.methodList}>
            {VERIFICATION_METHOD_OPTIONS.map((option) => {
              const selected = method === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={option.label}
                  style={[styles.method, selected ? styles.methodSelected : null, IS_WEB ? (WEB_PTR as any) : null]}
                  onPress={() => setMethod(option.value)}
                >
                  <Text style={[styles.methodMark, selected ? styles.methodMarkSelected : null]}>{selected ? '◉' : '○'}</Text>
                  <Text style={[styles.methodText, selected ? styles.methodTextSelected : null]}>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.sectionLabel}>Verification note{method === 'other' ? '' : ' (optional)'}</Text>
          <TextInput
            style={styles.input}
            value={note}
            onChangeText={setNote}
            maxLength={MANUAL_ATTENDANCE_TEXT_MAX}
            placeholder={method === 'other' ? 'How was the time verified?' : 'e.g. who confirmed it'}
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Verification note"
          />

          <Text style={styles.sectionLabel}>Reason</Text>
          <TextInput
            style={styles.noteInput}
            multiline
            value={reason}
            onChangeText={setReason}
            maxLength={MANUAL_ATTENDANCE_TEXT_MAX}
            placeholder="Why is Control recording this instead of the Guard?"
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Reason"
          />
          {attempted && !verdict.ok ? <Text style={styles.problem}>{verdict.message}</Text> : null}
        </>
      )}

      {error ? <Text style={styles.problem}>{error}</Text> : null}
    </Drawer>
  );
}

const styles = StyleSheet.create({
  facts: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 4,
  },
  factRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  factLabel: { width: 84, fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  factValue: { flex: 1, fontSize: 12, color: colors.textPrimary, fontWeight: '600' },
  sectionLabel: {
    fontSize: 10, fontWeight: '800', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: spacing.sm,
  },
  timeRow: { flexDirection: 'row', gap: spacing.sm },
  input: {
    borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 8,
    fontSize: 13, color: colors.textPrimary, backgroundColor: colors.card,
  },
  dateInput: { flex: 2 },
  timeInput: { flex: 1 },
  help: { fontSize: 11, color: colors.textSecondary, lineHeight: 16 },
  methodList: { gap: 2 },
  method: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 7, paddingHorizontal: spacing.sm,
    borderRadius: radii.sm, borderWidth: 1, borderColor: 'transparent',
  },
  methodSelected: { borderColor: colors.accentTeal, backgroundColor: colors.surfaceSubtle },
  methodMark: { fontSize: 13, color: colors.textMuted },
  methodMarkSelected: { color: colors.accentTeal },
  methodText: { fontSize: 13, color: colors.textPrimary },
  methodTextSelected: { fontWeight: '700' },
  noteInput: {
    minHeight: 80, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, padding: spacing.sm,
    fontSize: 13, color: colors.textPrimary, backgroundColor: colors.card, textAlignVertical: 'top',
  },
  confirmPanel: {
    marginTop: spacing.sm, padding: spacing.md, gap: spacing.xs, borderRadius: radii.sm, borderWidth: 1,
    borderColor: colors.warning, backgroundColor: colors.warningSurface,
  },
  confirmTitle: { fontSize: 14, fontWeight: '800', color: colors.primaryNavyStrong },
  confirmText: { fontSize: 12, color: colors.textPrimary, lineHeight: 18 },
  problem: { fontSize: 12, color: colors.danger, fontWeight: '700' },
  footer: { flexDirection: 'row', gap: spacing.sm },
  secondaryBtn: { paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.fieldBorder },
  secondaryBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  primaryBtn: { paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: radii.sm, backgroundColor: colors.primaryNavy },
  primaryBtnConfirm: { backgroundColor: colors.warning },
  primaryBtnBusy: { opacity: 0.7 },
  primaryBtnText: { fontSize: 13, fontWeight: '800', color: colors.textOnBrand },
});
