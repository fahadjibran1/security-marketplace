import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import { formatApiErrorMessage, submitTimesheet, updateTimesheet } from '../services/api';
import { AttendanceEvent, Timesheet } from '../types/models';

export interface GuardTimesheetsScreenProps {
  timesheets: Timesheet[];
  attendance: AttendanceEvent[];
  onReload: () => Promise<void>;
  onNotify?: (tone: 'success' | 'error' | 'info', title: string, message: string) => void;
  onTimesheetSubmitted?: (shiftId: number) => void;
}

function showAlert(title: string, message: string) {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

function getLiteralDateTimeParts(value?: string | null) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  return {
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4] || null,
    minute: match[5] || null,
  };
}

function formatDateLabel(value?: string | null) {
  if (!value) return '—';
  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts) {
    return new Date(
      Number(literalParts.year),
      Number(literalParts.month) - 1,
      Number(literalParts.day),
    ).toLocaleDateString(undefined, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }
  return new Date(value).toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatTimeLabel(value?: string | null) {
  if (!value) return '—';
  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts?.hour && literalParts?.minute) {
    return `${literalParts.hour}:${literalParts.minute}`;
  }
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTimeLabel(value?: string | null) {
  if (!value) return '—';
  return `${formatDateLabel(value)} · ${formatTimeLabel(value)}`;
}

function normalizeTimesheetStatus(status?: string | null) {
  return (status || '').trim().toLowerCase();
}

function formatStatusLabel(status?: string | null) {
  const s = normalizeTimesheetStatus(status);
  if (s === 'draft') return 'DRAFT';
  if (s === 'submitted') return 'SUBMITTED';
  if (s === 'approved') return 'APPROVED';
  if (s === 'rejected') return 'REJECTED';
  return (status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase();
}

function statusBadgeStyle(status: string) {
  switch (status) {
    case 'draft':
      return { bg: '#F3F4F6', text: '#374151' };
    case 'submitted':
      return { bg: '#DBEAFE', text: '#1D4ED8' };
    case 'approved':
      return { bg: '#DCFCE7', text: '#15803D' };
    case 'rejected':
      return { bg: '#FEE2E2', text: '#991B1B' };
    default:
      return { bg: '#E5E7EB', text: '#4B5563' };
  }
}

function parseClaimedHours(text: string): number {
  const normalized = text.trim().replace(',', '.');
  if (normalized === '') return 0;
  return Number.parseFloat(normalized);
}

function getSubmissionState(
  timesheet: Timesheet,
  attendanceSlice: { checkInAt?: string; checkOutAt?: string } | undefined,
  claimedHours: number,
) {
  const hasValidHours = Number.isFinite(claimedHours) && claimedHours > 0;
  const hasCheckedOut = Boolean(attendanceSlice?.checkOutAt || timesheet.actualCheckOutAt);

  if (!hasCheckedOut) {
    return { canSubmit: false, reason: 'Submit after you have checked out of the shift.' };
  }

  if (!hasValidHours) {
    return { canSubmit: false, reason: 'Enter the hours you are claiming before submitting.' };
  }

  return { canSubmit: true, reason: '' };
}

function TimesheetCard({
  timesheet,
  attendanceSlice,
  onReload,
  onNotify,
  onTimesheetSubmitted,
}: {
  timesheet: Timesheet;
  attendanceSlice?: { checkInAt?: string; checkOutAt?: string };
  onReload: () => Promise<void>;
  onNotify?: (tone: 'success' | 'error' | 'info', title: string, message: string) => void;
  onTimesheetSubmitted?: (shiftId: number) => void;
}) {
  const [hoursText, setHoursText] = useState(String(timesheet.hoursWorked ?? ''));
  const [noteText, setNoteText] = useState(timesheet.guardNote ?? '');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const statusKey = normalizeTimesheetStatus(timesheet.approvalStatus);
  const isDraft = statusKey === 'draft';
  const palette = statusBadgeStyle(statusKey);

  useEffect(() => {
    setHoursText(String(timesheet.hoursWorked ?? ''));
    setNoteText(timesheet.guardNote ?? '');
  }, [timesheet.id, timesheet.hoursWorked, timesheet.guardNote, timesheet.updatedAt, timesheet.approvalStatus]);

  const schedStart = timesheet.scheduledStartAt ?? timesheet.shift?.start ?? null;
  const schedEnd = timesheet.scheduledEndAt ?? timesheet.shift?.end ?? null;

  const recordCheckIn = timesheet.actualCheckInAt ?? attendanceSlice?.checkInAt ?? null;
  const recordCheckOut = timesheet.actualCheckOutAt ?? attendanceSlice?.checkOutAt ?? null;

  const claimedHours = parseClaimedHours(hoursText);
  const hoursValid = Number.isFinite(claimedHours) && claimedHours >= 0;
  const serverHours = Number(timesheet.hoursWorked);
  const serverNote = (timesheet.guardNote ?? '').trim();
  const localNote = noteText.trim();
  const hoursChanged =
    hoursText.trim() === ''
      ? serverHours !== 0
      : !hoursValid || Math.abs(claimedHours - serverHours) > 0.01;
  const noteDirty = localNote !== serverNote;
  const dirty = hoursChanged || noteDirty;

  const submission = getSubmissionState(timesheet, attendanceSlice, claimedHours);

  async function handleSaveDraft() {
    if (!isDraft || !hoursValid) return;
    try {
      setSaving(true);
      await updateTimesheet(timesheet.id, {
        hoursWorked: claimedHours,
        guardNote: localNote || null,
      });
      await onReload();
      onNotify?.('success', 'Draft saved', 'Your timesheet draft was updated.');
      showAlert('Draft saved', 'Your timesheet draft was updated.');
    } catch (err) {
      const message = formatApiErrorMessage(err, 'Unable to save this timesheet.');
      onNotify?.('error', 'Save failed', message);
      showAlert('Save failed', message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    if (!isDraft || !submission.canSubmit || !hoursValid) return;
    try {
      setSubmitting(true);
      await submitTimesheet(timesheet.id, {
        hoursWorked: claimedHours,
        guardNote: localNote || null,
      });
      if (timesheet.shiftId) {
        onTimesheetSubmitted?.(timesheet.shiftId);
      }
      await onReload();
      onNotify?.('success', 'Timesheet submitted', 'Your hours were sent for company review.');
      showAlert('Timesheet submitted', 'Your hours were sent for company review.');
    } catch (err) {
      const message = formatApiErrorMessage(err, 'Unable to submit this timesheet.');
      onNotify?.('error', 'Submit failed', message);
      showAlert('Submit failed', message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardHeaderRow}>
        <View style={styles.flexGrow}>
          <Text style={styles.siteTitle}>{timesheet.shift?.siteName || `Shift #${timesheet.shiftId}`}</Text>
          <Text style={styles.metaMuted}>Timesheet #{timesheet.id}</Text>
        </View>
        <View style={[styles.statusPill, { backgroundColor: palette.bg }]}>
          <Text style={[styles.statusPillText, { color: palette.text }]}>{formatStatusLabel(timesheet.approvalStatus)}</Text>
        </View>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockLabel}>Scheduled</Text>
        <Text style={styles.blockValue}>
          {formatDateLabel(schedStart)} · {formatTimeLabel(schedStart)} – {formatTimeLabel(schedEnd)}
        </Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockLabel}>Attendance (check-in / out)</Text>
        <Text style={styles.blockValue}>In: {formatDateTimeLabel(recordCheckIn)}</Text>
        <Text style={styles.blockValue}>Out: {formatDateTimeLabel(recordCheckOut)}</Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockLabel}>{isDraft ? 'Hours you are claiming' : 'Claimed hours'}</Text>
        {isDraft ? (
          <TextInput
            style={styles.input}
            value={hoursText}
            onChangeText={setHoursText}
            keyboardType="decimal-pad"
            placeholder="e.g. 8 or 7.5"
            editable={!saving && !submitting}
          />
        ) : (
          <Text style={styles.readonlyValue}>{Number(timesheet.hoursWorked) || 0} h</Text>
        )}
        {typeof timesheet.workedMinutes === 'number' && timesheet.workedMinutes > 0 ? (
          <Text style={styles.metaMuted}>Recorded minutes (system): {timesheet.workedMinutes}</Text>
        ) : null}
      </View>

      <View style={styles.block}>
        <Text style={styles.blockLabel}>Note (overtime, corrections)</Text>
        {isDraft ? (
          <TextInput
            style={[styles.input, styles.noteInput]}
            value={noteText}
            onChangeText={setNoteText}
            placeholder="Optional note for payroll / reviewer"
            multiline
            editable={!saving && !submitting}
            textAlignVertical="top"
          />
        ) : (
          <Text style={styles.readonlyValue}>{timesheet.guardNote?.trim() ? timesheet.guardNote : '—'}</Text>
        )}
      </View>

      {statusKey === 'rejected' && timesheet.rejectionReason ? (
        <View style={styles.rejectionBox}>
          <Text style={styles.rejectionLabel}>Company note</Text>
          <Text style={styles.rejectionText}>{timesheet.rejectionReason}</Text>
        </View>
      ) : null}

      {!isDraft && timesheet.submittedAt ? (
        <Text style={styles.metaMuted}>Submitted {formatDateTimeLabel(timesheet.submittedAt)}</Text>
      ) : null}

      {isDraft ? (
        <>
          <View style={styles.actionsRow}>
            <Pressable
              style={[styles.secondaryBtn, (saving || !dirty || !hoursValid) && styles.btnDisabled]}
              onPress={handleSaveDraft}
              disabled={saving || !dirty || !hoursValid}
            >
              <Text style={styles.secondaryBtnText}>{saving ? 'Saving…' : 'Save draft'}</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryBtn, (!submission.canSubmit || submitting || !hoursValid) && styles.btnDisabled]}
              onPress={handleSubmit}
              disabled={!submission.canSubmit || submitting || !hoursValid}
            >
              <Text style={styles.primaryBtnText}>{submitting ? 'Submitting…' : 'Submit'}</Text>
            </Pressable>
          </View>
          {!submission.canSubmit ? <Text style={styles.hint}>{submission.reason}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

export function GuardTimesheetsScreen({
  timesheets,
  attendance,
  onReload,
  onNotify,
  onTimesheetSubmitted,
}: GuardTimesheetsScreenProps) {
  const attendanceByShiftId = useMemo(() => {
    const map: Record<number, { checkInAt?: string; checkOutAt?: string }> = {};
    attendance.forEach((event) => {
      const shiftId = event.shift?.id;
      if (!shiftId) return;
      const current = map[shiftId] || {};
      if (event.type === 'check-in') current.checkInAt = event.occurredAt;
      if (event.type === 'check-out') current.checkOutAt = event.occurredAt;
      map[shiftId] = current;
    });
    return map;
  }, [attendance]);

  const sorted = useMemo(
    () =>
      [...timesheets].sort((a, b) => {
        const da = new Date(a.scheduledStartAt || a.shift?.start || a.createdAt).getTime();
        const db = new Date(b.scheduledStartAt || b.shift?.start || b.createdAt).getTime();
        return db - da;
      }),
    [timesheets],
  );

  return (
    <FeatureCard title="Timesheets" subtitle={sorted.length ? `${sorted.length} on your record` : 'No timesheets yet'}>
      {sorted.length === 0 ? (
        <Text style={styles.emptyText}>Timesheets will appear here once shifts are completed.</Text>
      ) : (
        sorted.map((ts) => (
          <View key={ts.id}>
            <TimesheetCard
              timesheet={ts}
              attendanceSlice={attendanceByShiftId[ts.shiftId]}
              onReload={onReload}
              onNotify={onNotify}
              onTimesheetSubmitted={onTimesheetSubmitted}
            />
          </View>
        ))
      )}
    </FeatureCard>
  );
}

const styles = StyleSheet.create({
  flexGrow: { flex: 1 },
  emptyText: { color: '#4B5563', lineHeight: 20 },
  card: {
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    paddingTop: 14,
    marginTop: 4,
    gap: 10,
  },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  siteTitle: { color: '#111827', fontWeight: '700', fontSize: 16 },
  metaMuted: { color: '#6B7280', fontSize: 12, lineHeight: 18 },
  statusPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, alignSelf: 'flex-start' },
  statusPillText: { fontWeight: '800', fontSize: 11, letterSpacing: 0.4 },
  block: { gap: 4 },
  blockLabel: { color: '#6B7280', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
  blockValue: { color: '#111827', fontSize: 14, lineHeight: 20, fontWeight: '600' },
  readonlyValue: { color: '#111827', fontSize: 15, lineHeight: 22, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    color: '#111827',
    fontSize: 16,
  },
  noteInput: { minHeight: 88, paddingTop: 10 },
  rejectionBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 12,
    padding: 10,
    gap: 4,
  },
  rejectionLabel: { color: '#991B1B', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  rejectionText: { color: '#7F1D1D', fontSize: 14, lineHeight: 20 },
  actionsRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  secondaryBtn: {
    flex: 1,
    backgroundColor: '#E5E7EB',
    borderRadius: 14,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: { color: '#111827', fontWeight: '700', fontSize: 15 },
  primaryBtn: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 14,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  btnDisabled: { opacity: 0.55 },
  hint: { color: '#6B7280', fontSize: 12, lineHeight: 18 },
});
