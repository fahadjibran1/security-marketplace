import { useEffect, useMemo, useState } from 'react';
import { Fragment } from 'react/jsx-runtime';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import { StatePanel } from '../components/StatePanel';
import { StatusBadge } from '../components/StatusBadge';
import { formatApiErrorMessage, submitTimesheet, updateTimesheet } from '../services/api';
import { AttendanceEvent, Timesheet } from '../types/models';
import { colors, control, radii, spacing, typography } from '../theme';

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
function getLiteralDateTimeParts(value?: string | null) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  return { year: match[1], month: match[2], day: match[3], hour: match[4] || null, minute: match[5] || null };
}
function formatDateLabel(value?: string | null) {
  if (!value) return '—';
  const p = getLiteralDateTimeParts(value);
  const date = p ? new Date(Number(p.year), Number(p.month) - 1, Number(p.day)) : new Date(value);
  return date.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
function formatTimeLabel(value?: string | null) {
  if (!value) return '—';
  const p = getLiteralDateTimeParts(value);
  return p?.hour && p?.minute ? `${p.hour}:${p.minute}` : new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDateTimeLabel(value?: string | null) { return value ? `${formatDateLabel(value)} · ${formatTimeLabel(value)}` : '—'; }
function normalizeStatus(status?: string | null) { return (status || '').trim().toLowerCase(); }
function statusLabel(status?: string | null) { const s = normalizeStatus(status); return ({draft:'Draft',submitted:'Submitted',approved:'Approved',rejected:'Rejected',returned:'Returned'} as Record<string,string>)[s] || (status || 'Unknown').replace(/_/g,' '); }
function statusMeaning(status: string) {
  return ({
    draft: 'Add or check your hours, then submit when they are correct.',
    returned: 'Your company sent this back for a correction. Update it and submit again.',
    rejected: 'This submission was not accepted. Read the company note before taking further action.',
    submitted: 'Waiting for company review. You do not need to act unless it is returned.',
    approved: 'Accepted and recorded for payroll.',
  } as Record<string,string>)[status] || 'Check the details below or contact your office if the status is unclear.';
}
function parseHours(text: string) { const value = text.trim().replace(',', '.'); return value === '' ? 0 : Number.parseFloat(value); }
function approvedHours(timesheet: Timesheet) {
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
  const [hoursText, setHoursText] = useState(String(timesheet.hoursWorked ?? ''));
  const [noteText, setNoteText] = useState(timesheet.guardNote ?? '');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const status = normalizeStatus(timesheet.approvalStatus);
  const editable = status === 'draft' || status === 'returned';

  useEffect(() => { setHoursText(String(timesheet.hoursWorked ?? '')); setNoteText(timesheet.guardNote ?? ''); }, [timesheet.id, timesheet.hoursWorked, timesheet.guardNote, timesheet.updatedAt, timesheet.approvalStatus]);

  const schedStart = timesheet.scheduledStartAt ?? timesheet.shift?.start ?? null;
  const schedEnd = timesheet.scheduledEndAt ?? timesheet.shift?.end ?? null;
  const checkIn = timesheet.actualCheckInAt ?? attendanceSlice?.checkInAt ?? null;
  const checkOut = timesheet.actualCheckOutAt ?? attendanceSlice?.checkOutAt ?? null;
  const claimed = parseHours(hoursText);
  const valid = Number.isFinite(claimed) && claimed >= 0;
  const dirty = !valid || Math.abs(claimed - Number(timesheet.hoursWorked || 0)) > 0.01 || noteText.trim() !== (timesheet.guardNote ?? '').trim();
  const canSubmit = Number.isFinite(claimed) && claimed > 0;
  const missingCheckout = canSubmit && !Boolean(checkOut || timesheet.actualCheckOutAt);
  const approved = approvedHours(timesheet);
  const companyNote = timesheet.companyNote?.trim() || timesheet.rejectionReason?.trim() || null;

  async function saveDraft() {
    if (!editable || !valid) return;
    try { setSaving(true); await updateTimesheet(timesheet.id, { hoursWorked: claimed, guardNote: noteText.trim() || null }); await onReload(); onNotify?.('success', 'Draft saved', 'Your timesheet draft was updated.'); showAlert('Draft saved', 'Your timesheet draft was updated.'); }
    catch (err) { const message = formatApiErrorMessage(err, 'Unable to save this timesheet.'); onNotify?.('error', 'Save failed', message); showAlert('Save failed', message); }
    finally { setSaving(false); }
  }
  async function submit() {
    if (!editable || !canSubmit || !valid) return;
    try { setSubmitting(true); await submitTimesheet(timesheet.id, { hoursWorked: claimed, guardNote: noteText.trim() || null }); if (timesheet.shiftId) onTimesheetSubmitted?.(timesheet.shiftId); await onReload(); onNotify?.('success', 'Timesheet submitted', 'Your hours were sent for company review.'); showAlert('Timesheet submitted', 'Your hours were sent for company review.'); }
    catch (err) { const message = formatApiErrorMessage(err, 'Unable to submit this timesheet.'); onNotify?.('error', 'Submit failed', message); showAlert('Submit failed', message); }
    finally { setSubmitting(false); }
  }

  return <View style={styles.card}>
    <View style={styles.headerRow}><View style={styles.flex}><Text style={styles.siteTitle}>{timesheet.shift?.siteName || `Shift #${timesheet.shiftId}`}</Text><Text style={styles.schedule}>{formatDateLabel(schedStart)} · {formatTimeLabel(schedStart)}–{formatTimeLabel(schedEnd)}</Text></View><StatusBadge label={statusLabel(timesheet.approvalStatus)} /></View>
    <Text style={styles.meaning}>{statusMeaning(status)}</Text>

    <View style={styles.infoGrid}><Info label="Booked on" value={formatDateTimeLabel(checkIn)} /><Info label="Booked off" value={formatDateTimeLabel(checkOut)} /></View>

    <View style={styles.field}><Text style={styles.label}>{editable ? 'Hours you are claiming' : 'Claimed hours'}</Text>{editable ? <TextInput style={styles.input} value={hoursText} onChangeText={setHoursText} keyboardType="decimal-pad" placeholder="e.g. 8 or 7.5" placeholderTextColor={colors.fieldPlaceholder} editable={!saving && !submitting} /> : <Text style={styles.readonly}>{Number(timesheet.hoursWorked) || 0} h</Text>}</View>
    <View style={styles.field}><Text style={styles.label}>Note</Text>{editable ? <TextInput style={[styles.input, styles.noteInput]} value={noteText} onChangeText={setNoteText} placeholder="Optional note for payroll or reviewer" placeholderTextColor={colors.fieldPlaceholder} multiline textAlignVertical="top" editable={!saving && !submitting} /> : <Text style={styles.readonly}>{timesheet.guardNote?.trim() || '—'}</Text>}</View>

    {companyNote ? <View style={status === 'rejected' ? styles.dangerBox : styles.warningBox}><Text style={styles.noteTitle}>{status === 'returned' ? 'Returned for correction' : 'Company note'}</Text><Text style={styles.noteBody}>{companyNote}</Text></View> : null}
    {approved !== null ? <View style={styles.approvedBox}><Text style={styles.label}>Approved hours</Text><Text style={styles.readonly}>{approved.toFixed(2)} h</Text></View> : null}
    {missingCheckout ? <View style={styles.warningBox}><Text style={styles.noteTitle}>No checkout recorded</Text><Text style={styles.noteBody}>You can still submit. Add a note if the company needs context.</Text></View> : null}
    {editable && !canSubmit ? <View style={styles.dangerBox}><Text style={styles.noteTitle}>Hours required</Text><Text style={styles.noteBody}>Enter the hours you are claiming before submitting.</Text></View> : null}

    {editable ? <View style={styles.actions}><Pressable onPress={submit} disabled={!canSubmit || submitting || !valid} style={({ pressed }: { pressed: boolean }) => [styles.primary, pressed && styles.pressed, (!canSubmit || submitting || !valid) && styles.disabled]}><Text style={styles.primaryText}>{submitting ? 'Submitting…' : 'Submit timesheet'}</Text></Pressable><Pressable onPress={saveDraft} disabled={saving || !dirty || !valid} style={({ pressed }: { pressed: boolean }) => [styles.secondary, pressed && styles.pressed, (saving || !dirty || !valid) && styles.disabled]}><Text style={styles.secondaryText}>{saving ? 'Saving…' : 'Save draft'}</Text></Pressable></View> : null}
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
