import { useEffect, useMemo, useState } from 'react';
import { Fragment } from 'react/jsx-runtime';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import { StatePanel } from '../components/StatePanel';
import { StatusBadge } from '../components/StatusBadge';
import { formatApiErrorMessage, getTimesheetHistory, submitTimesheet, updateTimesheet } from '../services/api';
import { AttendanceEvent, Timesheet } from '../types/models';
import { formatInstantDate, formatInstantDateTime, formatInstantTime } from '../services/siteTime';
import { colors, control, radii, spacing, typography } from '../theme';
import { verifiedAttendanceView } from '../components/company/timesheetAttendance';
import { formatHoursHM, hoursToMinutes, minutesToDecimalHours, parseHoursMinutes, splitMinutes } from '../services/timesheetHours';
import { guardDecisionBanner, historyLines, TimesheetHistoryItem } from '../services/timesheetReview';

export interface GuardTimesheetsScreenProps {
  timesheets: Timesheet[];
  attendance: AttendanceEvent[];
  onReload: () => Promise<void>;
  onNotify?: (tone: 'success' | 'error' | 'info', title: string, message: string) => void;
  onTimesheetSubmitted?: (shiftId: number) => void;
}

function showAlert(title: string, message: string) {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') { window.alert(`${title}\n\n${message}`); return; }
  Alert.alert(title, message);
}
// Scheduled and booked times are TRUE INSTANTS, not digits to be read out of the ISO string — see
// src/services/siteTime.ts. Rendered in the shift's site zone where known, otherwise this device's.
function formatDateLabel(value?: string | null, timeZone?: string | null) {
  return formatInstantDate(value, timeZone);
}
function formatTimeLabel(value?: string | null, timeZone?: string | null) {
  return formatInstantTime(value, timeZone);
}
function formatDateTimeLabel(value?: string | null, timeZone?: string | null) {
  return formatInstantDateTime(value, timeZone);
}
function normalizeStatus(status?: string | null) { return (status || '').trim().toLowerCase(); }
function statusLabel(status?: string | null) { const s = normalizeStatus(status); return ({draft:'Draft',submitted:'Submitted',approved:'Approved',rejected:'Rejected',returned:'Returned'} as Record<string,string>)[s] || (status || 'Unknown').replace(/_/g,' '); }
function statusMeaning(status: string) {
  return ({
    draft: 'Add or check your hours, then submit when they are correct.',
    returned: 'Your company sent this back for a correction. Read the reason above, update it and submit again.',
    rejected: 'This submission was not accepted. Read the reason above before taking further action.',
    submitted: 'Waiting for company review. You do not need to act unless it is returned.',
    approved: 'Accepted and recorded for payroll.',
  } as Record<string,string>)[status] || 'Check the details below or contact your office if the status is unclear.';
}
function approvedHours(timesheet: Timesheet) {
  if (timesheet.approvedMinutes !== undefined && timesheet.approvedMinutes !== null && Number.isFinite(Number(timesheet.approvedMinutes))) return Number(timesheet.approvedMinutes) / 60;
  if (timesheet.approvedHours !== undefined && timesheet.approvedHours !== null && Number.isFinite(Number(timesheet.approvedHours))) return Number(timesheet.approvedHours);
  if (normalizeStatus(timesheet.approvalStatus) === 'approved') return Number(timesheet.hoursWorked) || 0;
  return null;
}

function TimesheetCard({ timesheet, attendanceSlice, onReload, onNotify, onTimesheetSubmitted }: {
  timesheet: Timesheet;
  attendanceSlice?: { checkInAt?: string; checkOutAt?: string };
  onReload: () => Promise<void>;
  onNotify?: GuardTimesheetsScreenProps['onNotify'];
  onTimesheetSubmitted?: GuardTimesheetsScreenProps['onTimesheetSubmitted'];
}) {
  // The claim is entered as whole Hours and Minutes (never a decimal that can be read two ways) and stored as the
  // existing decimal hoursWorked; the server derives workedMinutes = round(hours × 60), which equals the minutes typed.
  const initial = splitMinutes(hoursToMinutes(timesheet.hoursWorked));
  const [hoursText, setHoursText] = useState(initial.hours);
  const [minutesText, setMinutesText] = useState(initial.minutes);
  const [noteText, setNoteText] = useState(timesheet.guardNote ?? '');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<TimesheetHistoryItem[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const status = normalizeStatus(timesheet.approvalStatus);
  const editable = status === 'draft' || status === 'returned';
  const decided = status === 'returned' || status === 'rejected';

  useEffect(() => { const s = splitMinutes(hoursToMinutes(timesheet.hoursWorked)); setHoursText(s.hours); setMinutesText(s.minutes); setNoteText(timesheet.guardNote ?? ''); }, [timesheet.id, timesheet.hoursWorked, timesheet.guardNote, timesheet.updatedAt, timesheet.approvalStatus]);
  // The review history (with every return reason) is read for a returned / rejected card straight away — its reviewer
  // and time head the card — and for any other card when the Guard opens it. An older server: no history, no error.
  useEffect(() => {
    if (!decided && !historyOpen) return;
    let live = true;
    getTimesheetHistory(timesheet.id)
      .then((answer) => { if (live) setHistory(Array.isArray(answer?.items) ? answer.items : []); })
      .catch(() => { if (live) setHistory([]); });
    return () => { live = false; };
  }, [timesheet.id, timesheet.updatedAt, timesheet.approvalStatus, decided, historyOpen]);

  const schedStart = timesheet.scheduledStartAt ?? timesheet.shift?.start ?? null;
  const schedEnd = timesheet.scheduledEndAt ?? timesheet.shift?.end ?? null;
  // A shift is read on the clock of the site it is at, not the clock of wherever the phone happens to be.
  const siteZone = timesheet.shift?.site?.timezone ?? null;
  // The verified Book On / Book Off (the server's effective attendance) when the server sends it; otherwise the
  // timesheet's times and this device's attendance list, as before. Where the timesheet differs, it is flagged below.
  const verified = verifiedAttendanceView(timesheet, (value) => formatDateTimeLabel(value, siteZone), 'guard');
  const checkIn = (verified.supported ? timesheet.verifiedCheckInAt : null) ?? timesheet.actualCheckInAt ?? attendanceSlice?.checkInAt ?? null;
  const checkOut = (verified.supported ? timesheet.verifiedCheckOutAt : null) ?? timesheet.actualCheckOutAt ?? attendanceSlice?.checkOutAt ?? null;
  const parsed = parseHoursMinutes(hoursText, minutesText);
  const empty = !hoursText.trim() && !minutesText.trim();
  // Saving a draft accepts empty inputs (a note-only change); submitting needs a valid time worked.
  const valid = parsed.ok || empty;
  const claimedMinutes = parsed.ok ? parsed.minutes : null;
  const storedMinutes = hoursToMinutes(timesheet.hoursWorked) ?? 0;
  const dirty = (claimedMinutes !== null && claimedMinutes !== storedMinutes) || noteText.trim() !== (timesheet.guardNote ?? '').trim();
  const canSubmit = parsed.ok;
  const missingCheckout = canSubmit && !Boolean(checkOut || timesheet.actualCheckOutAt);
  const approved = approvedHours(timesheet);
  const companyNote = timesheet.companyNote?.trim() || null;
  const formatWhen = (value: string) => formatDateTimeLabel(value, siteZone);
  const banner = guardDecisionBanner(timesheet, history, formatWhen);
  const lines = historyLines(history, 'guard', formatWhen);
  const claimPayload = () => ({
    ...(claimedMinutes !== null ? { hoursWorked: minutesToDecimalHours(claimedMinutes) } : {}),
    guardNote: noteText.trim() || null,
  });

  async function saveDraft() {
    if (!editable || !valid) return;
    try { setSaving(true); await updateTimesheet(timesheet.id, claimPayload()); await onReload(); onNotify?.('success', 'Draft saved', 'Your timesheet draft was updated.'); showAlert('Draft saved', 'Your timesheet draft was updated.'); }
    catch (err) { const message = formatApiErrorMessage(err, 'Unable to save this timesheet.'); onNotify?.('error', 'Save failed', message); showAlert('Save failed', message); }
    finally { setSaving(false); }
  }
  async function submit() {
    if (!editable || !canSubmit) return;
    try { setSubmitting(true); await submitTimesheet(timesheet.id, claimPayload()); if (timesheet.shiftId) onTimesheetSubmitted?.(timesheet.shiftId); await onReload(); onNotify?.('success', 'Timesheet submitted', 'Your hours were sent for company review.'); showAlert('Timesheet submitted', 'Your hours were sent for company review.'); }
    catch (err) { const message = formatApiErrorMessage(err, 'Unable to submit this timesheet.'); onNotify?.('error', 'Submit failed', message); showAlert('Submit failed', message); }
    finally { setSubmitting(false); }
  }

  return <View style={styles.card}>
    <View style={styles.headerRow}><View style={styles.flex}><Text style={styles.siteTitle}>{timesheet.shift?.siteName || `Shift #${timesheet.shiftId}`}</Text><Text style={styles.schedule}>{formatDateLabel(schedStart, siteZone)} · {formatTimeLabel(schedStart, siteZone)}–{formatTimeLabel(schedEnd, siteZone)}</Text></View><StatusBadge label={statusLabel(timesheet.approvalStatus)} /></View>
    {banner ? <View style={banner.tone === 'danger' ? styles.dangerBox : styles.warningBox}><Text style={styles.noteTitle}>{banner.title}</Text><Text style={styles.reasonText}>{banner.reason}</Text><Text style={styles.noteBody}>{banner.whatToDo}</Text></View> : null}
    <Text style={styles.meaning}>{statusMeaning(status)}</Text>

    <View style={styles.infoGrid}><Info label="Booked on" value={formatDateTimeLabel(checkIn, siteZone)} /><Info label="Booked off" value={formatDateTimeLabel(checkOut, siteZone)} /></View>
    {verified.flagged ? <View style={styles.warningBox}><Text style={styles.noteTitle}>{verified.flagTitle}</Text>{verified.flagLines.map((line) => <Text key={line} style={styles.noteBody}>{line}</Text>)}<Text style={styles.noteBody}>{verified.toleranceNote}</Text></View> : null}

    <View style={styles.field}><Text style={styles.label}>{editable ? 'Time you are claiming' : 'Claimed hours'}</Text>{editable ? <>
      <View style={styles.hmRow}>
        <View style={styles.hmField}><Text style={styles.hmLabel}>Hours</Text><TextInput style={styles.input} value={hoursText} onChangeText={setHoursText} keyboardType="number-pad" placeholder="e.g. 9" placeholderTextColor={colors.fieldPlaceholder} editable={!saving && !submitting} accessibilityLabel="Hours worked" maxLength={2} /></View>
        <View style={styles.hmField}><Text style={styles.hmLabel}>Minutes (0–59)</Text><TextInput style={styles.input} value={minutesText} onChangeText={setMinutesText} keyboardType="number-pad" placeholder="e.g. 30" placeholderTextColor={colors.fieldPlaceholder} editable={!saving && !submitting} accessibilityLabel="Minutes worked" maxLength={2} /></View>
      </View>
      {parsed.ok ? <Text style={styles.parsedText}>= {parsed.label}</Text> : !empty ? <Text style={styles.errorText}>{parsed.error}</Text> : null}
    </> : <Text style={styles.readonly}>{formatHoursHM(timesheet.hoursWorked, { withDecimal: true })}</Text>}</View>
    <View style={styles.field}><Text style={styles.label}>Note</Text>{editable ? <TextInput style={[styles.input, styles.noteInput]} value={noteText} onChangeText={setNoteText} placeholder="Optional note for payroll or reviewer" placeholderTextColor={colors.fieldPlaceholder} multiline textAlignVertical="top" editable={!saving && !submitting} /> : <Text style={styles.readonly}>{timesheet.guardNote?.trim() || '—'}</Text>}</View>

    {companyNote ? <View style={styles.noteBox}><Text style={styles.noteTitle}>Company note</Text><Text style={styles.noteBody}>{companyNote}</Text></View> : null}
    {approved !== null ? <View style={styles.approvedBox}><Text style={styles.label}>Approved hours</Text><Text style={styles.readonly}>{formatHoursHM(approved, { withDecimal: true })}</Text>{timesheet.overrideReason?.trim() ? <Text style={styles.noteBody}>Reason: {timesheet.overrideReason.trim()}</Text> : null}</View> : null}
    {missingCheckout ? <View style={styles.warningBox}><Text style={styles.noteTitle}>No Book Off recorded</Text><Text style={styles.noteBody}>You can still submit. Add a note if the company needs context.</Text></View> : null}
    {editable && !canSubmit ? <View style={styles.dangerBox}><Text style={styles.noteTitle}>Hours required</Text><Text style={styles.noteBody}>Enter the hours and minutes you are claiming before submitting.</Text></View> : null}

    {editable ? <View style={styles.actions}><Pressable onPress={submit} disabled={!canSubmit || submitting} style={({ pressed }: { pressed: boolean }) => [styles.primary, pressed && styles.pressed, (!canSubmit || submitting) && styles.disabled]}><Text style={styles.primaryText}>{submitting ? 'Submitting…' : 'Submit timesheet'}</Text></Pressable><Pressable onPress={saveDraft} disabled={saving || !dirty || !valid} style={({ pressed }: { pressed: boolean }) => [styles.secondary, pressed && styles.pressed, (saving || !dirty || !valid) && styles.disabled]}><Text style={styles.secondaryText}>{saving ? 'Saving…' : 'Save draft'}</Text></Pressable></View> : null}
    {decided || historyOpen ? <View style={styles.historyBox}>
      <Text style={styles.noteTitle}>History</Text>
      {history === null ? <Text style={styles.noteBody}>Loading…</Text> : lines.length === 0 ? <Text style={styles.noteBody}>No history recorded yet.</Text> : lines.map((line) => <View key={line.key} style={styles.historyItem}><Text style={styles.historyTitle}>{line.title}</Text><Text style={styles.historyWhen}>{line.when}</Text>{line.details.map((d) => <Text key={d} style={styles.noteBody}>{d}</Text>)}</View>)}
    </View> : <Pressable onPress={() => setHistoryOpen(true)} style={({ pressed }: { pressed: boolean }) => [styles.linkButton, pressed && styles.pressed]}><Text style={styles.linkText}>Show history</Text></Pressable>}
    <Text style={styles.reference}>Reference #{timesheet.id}</Text>
  </View>;
}

function Info({ label, value }: { label: string; value: string }) { return <View style={styles.info}><Text style={styles.label}>{label}</Text><Text style={styles.infoValue}>{value}</Text></View>; }

export function GuardTimesheetsScreen({ timesheets, attendance, onReload, onNotify, onTimesheetSubmitted }: GuardTimesheetsScreenProps) {
  const attendanceByShiftId = useMemo(() => { const map: Record<number, { checkInAt?: string; checkOutAt?: string }> = {}; attendance.forEach((event) => { const id = event.shift?.id; if (!id) return; const current = map[id] || {}; if (event.type === 'check-in') current.checkInAt = event.occurredAt; if (event.type === 'check-out') current.checkOutAt = event.occurredAt; map[id] = current; }); return map; }, [attendance]);
  const sorted = useMemo(() => [...timesheets].sort((a, b) => new Date(b.scheduledStartAt || b.shift?.start || b.createdAt).getTime() - new Date(a.scheduledStartAt || a.shift?.start || a.createdAt).getTime()), [timesheets]);
  return <FeatureCard title="Timesheets" subtitle={sorted.length ? `${sorted.length} on your record` : 'Claims and payroll decisions will appear here.'}>{sorted.length === 0 ? <StatePanel title="No timesheets yet" message="Timesheets will appear after completed shifts when a payroll record is available." /> : <View style={styles.list}>{sorted.map((ts) => <Fragment key={ts.id}><TimesheetCard timesheet={ts} attendanceSlice={attendanceByShiftId[ts.shiftId]} onReload={onReload} onNotify={onNotify} onTimesheetSubmitted={onTimesheetSubmitted} /></Fragment>)}</View>}</FeatureCard>;
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, backgroundColor: colors.card, padding: spacing.lg, gap: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  flex: { flex: 1 },
  siteTitle: { color: colors.textPrimary, ...typography.heading },
  schedule: { color: colors.textSecondary, ...typography.caption, marginTop: spacing.xs },
  meaning: { color: colors.textSecondary, ...typography.caption },
  infoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  info: { minWidth: 150, flexGrow: 1, borderRadius: radii.md, backgroundColor: colors.surfaceSubtle, padding: spacing.md, gap: spacing.xs },
  infoValue: { color: colors.textPrimary, ...typography.caption, fontWeight: '600' },
  field: { gap: 6 },
  label: { color: colors.textSecondary, ...typography.caption, fontWeight: '700' },
  input: { minHeight: control.inputHeight, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.md, backgroundColor: colors.card, paddingHorizontal: spacing.md, color: colors.textPrimary, ...typography.body },
  noteInput: { minHeight: 92, paddingTop: spacing.md },
  readonly: { color: colors.textPrimary, ...typography.bodyStrong },
  warningBox: { backgroundColor: colors.warningSurface, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs },
  dangerBox: { backgroundColor: colors.dangerSurface, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs },
  approvedBox: { backgroundColor: colors.successSurface, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs },
  noteBox: { backgroundColor: colors.surfaceSubtle, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs },
  historyBox: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  historyItem: { gap: 2, borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: spacing.sm },
  historyTitle: { color: colors.textPrimary, ...typography.caption, fontWeight: '700' },
  historyWhen: { color: colors.textMuted, ...typography.caption },
  reasonText: { color: colors.textPrimary, ...typography.bodyStrong },
  hmRow: { flexDirection: 'row', gap: spacing.sm },
  hmField: { flex: 1, gap: 4 },
  hmLabel: { color: colors.textSecondary, ...typography.caption },
  parsedText: { color: colors.textPrimary, ...typography.caption, fontWeight: '700' },
  errorText: { color: colors.danger, ...typography.caption },
  linkButton: { minHeight: control.minTouchTarget, justifyContent: 'center' },
  linkText: { color: colors.primaryNavy, ...typography.label },
  noteTitle: { color: colors.textPrimary, ...typography.label },
  noteBody: { color: colors.textSecondary, ...typography.caption },
  actions: { gap: spacing.sm },
  primary: { minHeight: control.buttonHeight, borderRadius: radii.md, backgroundColor: colors.accentTealStrong, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: colors.textOnBrand, ...typography.bodyStrong },
  secondary: { minHeight: control.minTouchTarget, borderRadius: radii.md, borderWidth: 1, borderColor: colors.primaryNavy, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: colors.primaryNavy, ...typography.label },
  reference: { color: colors.textMuted, ...typography.caption },
  pressed: { opacity: 0.84 },
  disabled: { opacity: 0.5 },
});
