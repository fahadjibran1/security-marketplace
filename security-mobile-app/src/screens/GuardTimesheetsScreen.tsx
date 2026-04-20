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
  if (s === 'draft') return 'Draft';
  if (s === 'submitted') return 'Submitted';
  if (s === 'approved') return 'Approved';
  if (s === 'rejected') return 'Rejected';
  if (s === 'returned') return 'Returned';
  return (status || 'Unknown').replace(/_/g, ' ');
}

/** Plain-language line for guards (presentation only). */
function getTimesheetStatusMeaning(statusKey: string): string {
  switch (statusKey) {
    case 'draft':
      return 'Not sent yet — add your hours, then submit when they are correct.';
    case 'returned':
      return 'Your company sent this back — update the details below, then submit again.';
    case 'rejected':
      return 'This submission was not accepted — read the note and speak with your supervisor if you need help.';
    case 'submitted':
      return 'Waiting on the company — you are done unless they return it for changes.';
    case 'approved':
      return 'Accepted — these hours are on record for payroll.';
    default:
      return 'Check the details below or with your office if this status is unclear.';
  }
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
    case 'returned':
      return { bg: '#FEF3C7', text: '#B45309' };
    default:
      return { bg: '#E5E7EB', text: '#4B5563' };
  }
}

function parseClaimedHours(text: string): number {
  const normalized = text.trim().replace(',', '.');
  if (normalized === '') return 0;
  return Number.parseFloat(normalized);
}

function getApprovedHoursValue(timesheet: Timesheet) {
  if (timesheet.approvedHours !== undefined && timesheet.approvedHours !== null && Number.isFinite(Number(timesheet.approvedHours))) {
    return Number(timesheet.approvedHours);
  }

  if (normalizeTimesheetStatus(timesheet.approvalStatus) === 'approved') {
    return Number(timesheet.hoursWorked) || 0;
  }

  return null;
}

function getSubmissionState(
  timesheet: Timesheet,
  attendanceSlice: { checkInAt?: string; checkOutAt?: string } | undefined,
  claimedHours: number,
) {
  const hasValidHours = Number.isFinite(claimedHours) && claimedHours > 0;

  if (!hasValidHours) {
    return { canSubmit: false, reason: 'Enter the hours you are claiming before submitting.' };
  }

  const hasCheckedOut = Boolean(attendanceSlice?.checkOutAt || timesheet.actualCheckOutAt);
  if (!hasCheckedOut) {
    return {
      canSubmit: true,
      reason:
        'No checkout was recorded for this shift. You can still submit now, and the company can review your note if needed.',
    };
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
  const isEditable = statusKey === 'draft' || statusKey === 'returned';
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
  const approvedHoursValue = getApprovedHoursValue(timesheet);
  const approvedHoursAdjusted =
    approvedHoursValue !== null && Math.abs(approvedHoursValue - Number(timesheet.hoursWorked || 0)) > 0.009;
  const companyReviewNote = timesheet.companyNote?.trim() || null;

  async function handleSaveDraft() {
    if (!isEditable || !hoursValid) return;
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
    if (!isEditable || !submission.canSubmit || !hoursValid) return;
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
      <View style={styles.cardHeaderBlock}>
        <Text style={styles.siteTitle}>{timesheet.shift?.siteName || `Shift #${timesheet.shiftId}`}</Text>
        <Text style={styles.headerSchedule}>
          {formatDateLabel(schedStart)} · {formatTimeLabel(schedStart)} – {formatTimeLabel(schedEnd)}
        </Text>
        <View style={styles.statusBlock}>
          <View style={[styles.statusPill, { backgroundColor: palette.bg }]}>
            <Text style={[styles.statusPillText, { color: palette.text }]}>
              {formatStatusLabel(timesheet.approvalStatus)}
            </Text>
          </View>
          <Text style={styles.statusMeaning}>{getTimesheetStatusMeaning(statusKey)}</Text>
        </View>
        <Text style={styles.headerRef}>Reference #{timesheet.id}</Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockLabel}>Attendance (check-in / out)</Text>
        <Text style={styles.blockValue}>In: {formatDateTimeLabel(recordCheckIn)}</Text>
        <Text style={styles.blockValue}>Out: {formatDateTimeLabel(recordCheckOut)}</Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockLabel}>{isEditable ? 'Hours you are claiming' : 'Claimed hours'}</Text>
        {isEditable ? (
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
          <Text style={styles.metaMuted}>
            System recorded {timesheet.workedMinutes} minutes on shift (for reference — your claim is what you enter
            above).
          </Text>
        ) : null}
      </View>

      <View style={styles.block}>
        <Text style={styles.blockLabel}>Note (overtime, corrections)</Text>
        {isEditable ? (
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

      {(statusKey === 'returned' || statusKey === 'rejected') && timesheet.rejectionReason ? (
        <View style={statusKey === 'returned' ? styles.returnedNoteBox : styles.rejectionBox}>
          <Text style={statusKey === 'returned' ? styles.returnedNoteLabel : styles.rejectionLabel}>
            {statusKey === 'returned' ? 'Returned for correction' : 'Company note'}
          </Text>
          <Text style={statusKey === 'returned' ? styles.returnedNoteText : styles.rejectionText}>
            {timesheet.rejectionReason}
          </Text>
        </View>
      ) : null}

      {(statusKey === 'approved' || statusKey === 'returned') && approvedHoursValue !== null ? (
        <View style={styles.reviewContextBox}>
          <Text style={styles.reviewContextLabel}>
            {approvedHoursAdjusted ? 'Company adjusted approved hours' : 'Approved hours'}
          </Text>
          <Text style={styles.reviewContextText}>
            Approved: {approvedHoursValue.toFixed(2)} h
            {approvedHoursAdjusted ? ` | Claimed: ${Number(timesheet.hoursWorked || 0).toFixed(2)} h` : ''}
          </Text>
        </View>
      ) : null}

      {(statusKey === 'approved' || statusKey === 'returned') && companyReviewNote ? (
        <View style={styles.reviewContextBox}>
          <Text style={styles.reviewContextLabel}>Company review note</Text>
          <Text style={styles.reviewContextText}>{companyReviewNote}</Text>
        </View>
      ) : null}

      {!isEditable && timesheet.submittedAt ? (
        <Text style={styles.metaMuted}>Submitted {formatDateTimeLabel(timesheet.submittedAt)}</Text>
      ) : null}

      {isEditable ? (
        <>
          {submission.reason ? (
            <View
              style={[
                styles.submitNoticeBox,
                !submission.canSubmit ? styles.submitNoticeBoxBlocking : styles.submitNoticeBoxInfo,
              ]}
            >
              <Text style={styles.submitNoticeTitle}>
                {!submission.canSubmit ? 'Before you can submit' : 'Heads up'}
              </Text>
              <Text style={styles.submitNoticeBody}>{submission.reason}</Text>
            </View>
          ) : null}
          <View style={styles.actionsColumn}>
            <Pressable
              style={[
                styles.primaryBtn,
                styles.primaryBtnProminent,
                (!submission.canSubmit || submitting || !hoursValid) && styles.btnDisabled,
              ]}
              onPress={handleSubmit}
              disabled={!submission.canSubmit || submitting || !hoursValid}
            >
              <Text style={styles.primaryBtnText}>{submitting ? 'Submitting…' : 'Submit timesheet'}</Text>
            </Pressable>
            <Pressable
              style={[styles.secondaryBtn, styles.secondaryBtnDraft, (saving || !dirty || !hoursValid) && styles.btnDisabled]}
              onPress={handleSaveDraft}
              disabled={saving || !dirty || !hoursValid}
            >
              <Text style={styles.secondaryBtnText}>{saving ? 'Saving…' : 'Save draft'}</Text>
            </Pressable>
          </View>
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
    <View style={styles.guardTimesheetsRoot}>
      <FeatureCard
        title="Timesheets"
        subtitle={sorted.length ? `${sorted.length} on your record` : 'No timesheets yet'}
        style={styles.guardTimesheetsCard}
      >
        {sorted.length === 0 ? (
          <View style={styles.timesheetsEmptyState}>
            <Text style={styles.timesheetsEmptyTitle}>Nothing here yet</Text>
            <Text style={styles.timesheetsEmptyBody}>
              Timesheets will appear here once shifts are completed.
            </Text>
          </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  guardTimesheetsRoot: { width: '100%' },
  guardTimesheetsCard: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    padding: 16,
    marginBottom: 0,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
    gap: 12,
  },
  timesheetsEmptyState: { gap: 8, paddingVertical: 10, paddingHorizontal: 2 },
  timesheetsEmptyTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A', letterSpacing: -0.2 },
  timesheetsEmptyBody: { fontSize: 14, lineHeight: 22, color: '#475569', fontWeight: '500' },
  card: {
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    paddingTop: 16,
    marginTop: 8,
    gap: 12,
  },
  cardHeaderBlock: { gap: 8, marginBottom: 2 },
  siteTitle: { color: '#0F172A', fontWeight: '800', fontSize: 18, lineHeight: 24, letterSpacing: -0.2 },
  headerSchedule: { color: '#334155', fontSize: 15, fontWeight: '600', lineHeight: 22 },
  statusBlock: { gap: 6, marginTop: 2 },
  statusMeaning: { color: '#475569', fontSize: 14, lineHeight: 21, fontWeight: '500' },
  headerRef: { color: '#94A3B8', fontSize: 11, fontWeight: '600', letterSpacing: 0.2 },
  metaMuted: { color: '#6B7280', fontSize: 12, lineHeight: 18 },
  statusPill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, alignSelf: 'flex-start' },
  statusPillText: { fontWeight: '800', fontSize: 12, letterSpacing: 0.2 },
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
    padding: 12,
    gap: 6,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  rejectionLabel: { color: '#991B1B', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  rejectionText: { color: '#7F1D1D', fontSize: 14, lineHeight: 21, fontWeight: '500' },
  returnedNoteBox: {
    backgroundColor: '#FFFBEB',
    borderRadius: 12,
    padding: 12,
    gap: 6,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  returnedNoteLabel: { color: '#B45309', fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  returnedNoteText: { color: '#92400E', fontSize: 14, lineHeight: 21, fontWeight: '500' },
  submitNoticeBox: {
    borderRadius: 14,
    padding: 14,
    gap: 6,
    borderWidth: 1,
  },
  submitNoticeBoxBlocking: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  submitNoticeBoxInfo: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FDE68A',
  },
  submitNoticeTitle: { fontSize: 12, fontWeight: '800', color: '#0F172A', letterSpacing: 0.3, textTransform: 'uppercase' },
  submitNoticeBody: { fontSize: 14, lineHeight: 22, color: '#334155', fontWeight: '600' },
  reviewContextBox: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    padding: 10,
    gap: 4,
  },
  reviewContextLabel: { color: '#1D4ED8', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  reviewContextText: { color: '#1E3A8A', fontSize: 14, lineHeight: 20 },
  actionsColumn: { gap: 10, marginTop: 4 },
  secondaryBtn: {
    alignSelf: 'stretch',
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  secondaryBtnDraft: {
    minHeight: 44,
  },
  secondaryBtnText: { color: '#475569', fontWeight: '700', fontSize: 14 },
  primaryBtn: {
    alignSelf: 'stretch',
    backgroundColor: '#111827',
    borderRadius: 14,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnProminent: {
    minHeight: 52,
    borderRadius: 16,
    shadowColor: '#0F172A',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16, letterSpacing: 0.2 },
  btnDisabled: { opacity: 0.55 },
});
