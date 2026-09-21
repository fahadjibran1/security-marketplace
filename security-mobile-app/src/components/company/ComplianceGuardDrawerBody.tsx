import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ComplianceRecord, ComplianceRecordPayload, GuardDocument } from '../../types/models';
import { colors, radii, spacing } from '../../theme';
import { StatusBadge } from '../StatusBadge';
import { Button } from '../ui/Button';
import { FieldInput, FormField } from '../ui/FormField';
import {
  BlockerAction,
  buildBlockers,
  ComplianceRow,
  formatDate,
  isIsoDate,
  RECORD_TYPES,
  rightToWorkIndicator,
  ScreeningOutcome,
  screeningIndicator,
  siaIndicator,
  STATUS_LABELS,
  STATUS_TONES,
  UPLOAD_DOCUMENT_TYPES,
  describeVerification,
  validateUpload,
} from './compliance-model';
import { documentTypeLabel, getDocumentPresentation } from './compliance-selection';
import type { PickedDocument } from './complianceDataSource';

const IS_WEB = typeof document !== 'undefined';
const REQUIRED_TYPES: Array<'sia_licence' | 'right_to_work'> = ['sia_licence', 'right_to_work'];

type RecordType = (typeof RECORD_TYPES)[number]['value'];

export type ComplianceGuardDrawerBodyProps = {
  row: ComplianceRow;
  canManage: boolean;
  canViewScreening: boolean;
  /** undefined = screening statuses not loaded for this session (no permission, or the request failed). */
  screening: ScreeningOutcome | null | undefined;
  screeningUnavailable: boolean;
  /** Compliance records for THIS Guard (managers only). null = not loaded. */
  records: ComplianceRecord[] | null;
  currentUserId?: number | null;
  viewingId: number | null;
  verifyingId: number | null;
  onView: (document: GuardDocument) => void;
  onRequestVerification: (document: GuardDocument, verified: boolean) => void;
  onPickDocument: () => Promise<PickedDocument | null>;
  /** Resolves to an error message, or null on success. */
  onUploadDocument: (input: { type: string; file: PickedDocument; expiryDate: string }) => Promise<string | null>;
  onSaveRecord: (payload: Omit<ComplianceRecordPayload, 'guardId'>) => Promise<string | null>;
  onReview: () => void;
};

function Section({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValue}>{children}</View>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function ComplianceGuardDrawerBody(props: ComplianceGuardDrawerBodyProps) {
  const { row, canManage, canViewScreening, screening, screeningUnavailable, records, currentUserId } = props;
  const summary = row.summary;
  const blockers = React.useMemo(() => buildBlockers(summary, canManage), [summary, canManage]);
  const documents = summary?.documents ?? [];
  const now = React.useMemo(() => new Date(), [summary]);

  // ── Upload panel (local UI state; the parent keys this component by Guard so it resets per Guard) ──
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [uploadType, setUploadType] = React.useState<string>('sia_licence');
  const [uploadFile, setUploadFile] = React.useState<PickedDocument | null>(null);
  const [uploadExpiry, setUploadExpiry] = React.useState('');
  const [uploadBusy, setUploadBusy] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  const openUpload = (type: string) => {
    setUploadType(type);
    setUploadFile(null);
    setUploadExpiry('');
    setUploadError(null);
    setUploadOpen(true);
  };

  const chooseFile = async () => {
    setUploadError(null);
    try {
      const file = await props.onPickDocument();
      if (file) setUploadFile(file);
    } catch {
      setUploadError('Unable to open the file picker. Try again.');
    }
  };

  const submitUpload = async () => {
    const problem = validateUpload({ name: uploadFile?.name, mimeType: uploadFile?.mimeType, size: uploadFile?.size ?? 1, expiryDate: uploadExpiry });
    if (problem || !uploadFile) {
      setUploadError(problem ?? 'Choose a document to upload.');
      return;
    }
    setUploadBusy(true);
    setUploadError(null);
    const error = await props.onUploadDocument({ type: uploadType, file: uploadFile, expiryDate: uploadExpiry.trim() });
    setUploadBusy(false);
    if (error) setUploadError(error);
    else setUploadOpen(false);
  };

  // ── Compliance record form ──
  const [recordOpen, setRecordOpen] = React.useState(false);
  const [recordType, setRecordType] = React.useState<RecordType>('SIA');
  const [recordName, setRecordName] = React.useState('');
  const [recordNumber, setRecordNumber] = React.useState('');
  const [recordIssue, setRecordIssue] = React.useState('');
  const [recordExpiry, setRecordExpiry] = React.useState('');
  const [recordBusy, setRecordBusy] = React.useState(false);
  const [recordError, setRecordError] = React.useState<string | null>(null);

  const existingOfType = (type: string) => (records ?? []).find((record) => record.type === type) ?? null;

  const openRecord = (type: RecordType) => {
    const existing = existingOfType(type);
    setRecordType(type);
    setRecordName(existing?.documentName ?? '');
    setRecordNumber(existing?.documentNumber ?? '');
    setRecordIssue(existing?.issueDate ?? '');
    setRecordExpiry(existing?.expiryDate ?? '');
    setRecordError(null);
    setRecordOpen(true);
  };

  const submitRecord = async () => {
    if (!recordName.trim()) return setRecordError('Enter a document name.');
    if (!isIsoDate(recordExpiry.trim())) return setRecordError('Enter the expiry date as YYYY-MM-DD.');
    if (recordIssue.trim() && !isIsoDate(recordIssue.trim())) return setRecordError('Enter the issue date as YYYY-MM-DD, or leave it blank.');
    setRecordBusy(true);
    setRecordError(null);
    const error = await props.onSaveRecord({
      type: recordType,
      documentName: recordName.trim(),
      documentNumber: recordNumber.trim() || null,
      issueDate: recordIssue.trim() || null,
      expiryDate: recordExpiry.trim(),
    });
    setRecordBusy(false);
    if (error) setRecordError(error);
    else setRecordOpen(false);
  };

  const runAction = (action: BlockerAction | null) => {
    if (!action) return;
    if (action.kind === 'add_document') openUpload(action.documentType);
    else openRecord(action.recordType);
  };

  const sia = siaIndicator(summary, now);
  const rtw = rightToWorkIndicator(summary, now);
  const screeningBadge = screeningIndicator(screening);
  const missingTypes = REQUIRED_TYPES.filter(
    (type) => !documents.some((document) => document.type === type && document.uploadCompletedAt),
  );
  const editingExisting = Boolean(existingOfType(recordType));

  return (
    <View style={styles.body}>
      {/* ── Compliance ───────────────────────────────────────────────── */}
      <Section title="Compliance">
        <Row label="Status">
          <StatusBadge label={STATUS_LABELS[row.status]} tone={STATUS_TONES[row.status]} size="small" />
        </Row>
        {summary ? (
          <Text style={styles.hint}>
            Licence and document compliance only. It does not cover your relationship with this Guard, availability or shift clashes.
          </Text>
        ) : (
          <>
            <Text style={styles.hint}>No compliance summary is available for this Guard, so their status is Unknown.</Text>
            <View style={styles.actions}>
              <Button label="Review compliance" variant="secondary" size="sm" onPress={props.onReview} />
            </View>
          </>
        )}
      </Section>

      {summary ? (
        <>
          {/* ── SIA ───────────────────────────────────────────────────── */}
          <Section title="SIA licence">
            <Row label="Number"><Text style={styles.value}>{summary.siaLicenceNumber || '—'}</Text></Row>
            <Row label="Expiry"><Text style={styles.value}>{formatDate(summary.siaExpiryDate)}</Text></Row>
            <Row label="Assessment"><StatusBadge label={sia.label} tone={sia.tone} size="small" /></Row>
          </Section>

          {/* ── Right to work ─────────────────────────────────────────── */}
          <Section title="Right to work">
            <Row label="Status"><Text style={styles.value}>{summary.rightToWorkStatus || '—'}</Text></Row>
            <Row label="Expiry"><Text style={styles.value}>{formatDate(summary.rightToWorkExpiryDate)}</Text></Row>
            <Row label="Assessment"><StatusBadge label={rtw.label} tone={rtw.tone} size="small" /></Row>
          </Section>
        </>
      ) : null}

      {/* ── Screening: status only ───────────────────────────────────── */}
      <Section title="Screening">
        {!canViewScreening ? (
          <Text style={styles.hint}>Screening status is not available for your role.</Text>
        ) : screeningUnavailable || screening === undefined ? (
          <Text style={styles.hint}>Screening status could not be loaded. Refresh to try again.</Text>
        ) : (
          <>
            <Row label="Status"><StatusBadge label={screeningBadge.label} tone={screeningBadge.tone} size="small" /></Row>
            <Text style={styles.hint}>Screening is reviewed by S4 platform administrators. You can see the status only.</Text>
          </>
        )}
      </Section>

      {/* ── Blockers ─────────────────────────────────────────────────── */}
      {summary ? (
        <Section title={`Blockers${blockers.length ? ` (${blockers.length})` : ''}`}>
          {blockers.length === 0 ? (
            <Text style={styles.hint}>No blockers or expiring items recorded.</Text>
          ) : (
            blockers.map((blocker) => (
              <View key={blocker.key} style={styles.blocker}>
                <View style={styles.blockerHead}>
                  <StatusBadge
                    label={blocker.severity === 'blocking' ? 'Blocking' : 'Expiring soon'}
                    tone={blocker.severity === 'blocking' ? 'danger' : 'warning'}
                    size="small"
                  />
                  <Text style={styles.blockerText}>{blocker.text}</Text>
                </View>
                {blocker.nextStep ? <Text style={styles.nextStep}>Next step: {blocker.nextStep}</Text> : null}
                {blocker.action ? (
                  <View style={styles.actions}>
                    <Button
                      label={blocker.action.kind === 'add_document' ? 'Add document' : 'Update record'}
                      variant="secondary"
                      size="sm"
                      onPress={() => runAction(blocker.action)}
                    />
                  </View>
                ) : null}
              </View>
            ))
          )}
        </Section>
      ) : null}

      {/* ── Documents ────────────────────────────────────────────────── */}
      {summary ? (
        <Section title="Documents">
          {missingTypes.map((type) => (
            <View key={`missing-${type}`} style={styles.doc}>
              <View style={styles.docHead}>
                <Text style={styles.docTitle}>{documentTypeLabel(type)}</Text>
                <StatusBadge label="Missing" tone="danger" size="small" />
              </View>
              <Text style={styles.meta}>Required evidence has not been uploaded.</Text>
              {canManage ? (
                <View style={styles.actions}>
                  <Button label="Add document" variant="secondary" size="sm" onPress={() => openUpload(type)} />
                </View>
              ) : null}
            </View>
          ))}

          {documents.map((document) => {
            const view = getDocumentPresentation(document, canManage, now);
            const verification = describeVerification(document, currentUserId);
            return (
              <View key={document.id} style={styles.doc}>
                <View style={styles.docHead}>
                  <Text style={styles.docTitle}>{documentTypeLabel(String(document.type))}</Text>
                  <View style={styles.badges}>
                    <StatusBadge
                      label={view.statusLabel}
                      tone={!view.uploadComplete ? 'warning' : document.verified ? 'success' : 'pending'}
                      size="small"
                    />
                    {view.expired ? <StatusBadge label="Expired" tone="danger" size="small" /> : null}
                  </View>
                </View>
                <Text style={styles.docFile} numberOfLines={1}>{document.originalFileName || 'Private evidence'}</Text>
                <Text style={styles.meta}>
                  Uploaded {formatDate(document.uploadedAt)} · Expiry {formatDate(document.expiryDate)}
                </Text>
                {verification ? <Text style={styles.meta}>{verification}</Text> : null}
                {!view.uploadComplete ? (
                  <Text style={styles.meta}>The upload was not completed, so this evidence cannot be viewed or verified.</Text>
                ) : null}
                {view.evidenceRestricted ? <Text style={styles.meta}>Evidence file access is restricted to compliance managers.</Text> : null}
                {view.canView || view.canToggleVerification ? (
                  <View style={styles.actions}>
                    {view.canView ? (
                      <Button
                        label={props.viewingId === document.id ? 'Opening…' : 'View document'}
                        variant="secondary"
                        size="sm"
                        disabled={props.viewingId === document.id}
                        onPress={() => props.onView(document)}
                        accessibilityLabel={`View ${documentTypeLabel(String(document.type))} document`}
                      />
                    ) : null}
                    {view.canToggleVerification ? (
                      <Button
                        label={props.verifyingId === document.id ? 'Saving…' : document.verified ? 'Mark unverified' : 'Verify'}
                        variant={document.verified ? 'tertiary' : 'primary'}
                        size="sm"
                        disabled={props.verifyingId === document.id}
                        onPress={() => props.onRequestVerification(document, !document.verified)}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}

          {documents.length === 0 && missingTypes.length === 0 ? <Text style={styles.hint}>No documents uploaded yet.</Text> : null}

          {canManage && !uploadOpen ? (
            <View style={styles.actions}>
              <Button label="Add document" variant="secondary" size="sm" onPress={() => openUpload(missingTypes[0] ?? 'sia_licence')} />
            </View>
          ) : null}

          {canManage && uploadOpen ? (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Add document</Text>
              <FormField label="Document type">
                <View style={styles.chips}>
                  {UPLOAD_DOCUMENT_TYPES.map((option) => (
                    <Fragment key={option.value}>
                      <Chip label={option.label} active={uploadType === option.value} onPress={() => setUploadType(option.value)} />
                    </Fragment>
                  ))}
                </View>
              </FormField>
              <FormField label="File" helperText="PDF, JPEG or PNG, up to 10 MB.">
                <View style={styles.fileRow}>
                  <Button label={uploadFile ? 'Change file' : 'Choose file'} variant="secondary" size="sm" onPress={chooseFile} disabled={uploadBusy} />
                  <Text style={styles.fileName} numberOfLines={1}>{uploadFile?.name ?? 'No file selected'}</Text>
                </View>
              </FormField>
              <FormField label="Expiry date (optional)">
                <FieldInput value={uploadExpiry} onChangeText={setUploadExpiry} placeholder="YYYY-MM-DD" autoCapitalize="none" />
              </FormField>
              {uploadError ? <Text style={styles.error} accessibilityLiveRegion="polite">{uploadError}</Text> : null}
              <Text style={styles.hint}>The document is stored privately and starts as Pending until someone verifies it.</Text>
              <View style={styles.actions}>
                <Button label="Upload" onPress={submitUpload} loading={uploadBusy} size="sm" />
                <Button label="Cancel" variant="tertiary" size="sm" onPress={() => setUploadOpen(false)} disabled={uploadBusy} />
              </View>
            </View>
          ) : null}
        </Section>
      ) : null}

      {/* ── Compliance records (managers) ────────────────────────────── */}
      {canManage && summary ? (
        <Section title="Compliance records">
          <Text style={styles.hint}>
            A compliance record tracks an expiry date your team maintains for a licence or check. It is separate from the
            Guard's own SIA and right-to-work details and does not change them.
          </Text>
          {records === null ? (
            <Text style={styles.hint}>Compliance records could not be loaded. Refresh to try again.</Text>
          ) : records.length === 0 ? (
            <Text style={styles.hint}>Compliance not yet recorded.</Text>
          ) : (
            records.map((record) => (
              <View key={record.id} style={styles.doc}>
                <View style={styles.docHead}>
                  <Text style={styles.docTitle}>{RECORD_TYPES.find((type) => type.value === record.type)?.label ?? String(record.type)}</Text>
                  <StatusBadge
                    label={record.status === 'expired' ? 'Expired' : record.status === 'expiring' ? 'Expiring' : 'Valid'}
                    tone={record.status === 'expired' ? 'danger' : record.status === 'expiring' ? 'warning' : 'success'}
                    size="small"
                  />
                </View>
                <Text style={styles.docFile} numberOfLines={1}>{record.documentName}{record.documentNumber ? ` · ${record.documentNumber}` : ''}</Text>
                <Text style={styles.meta}>Expiry {formatDate(record.expiryDate)}</Text>
                <View style={styles.actions}>
                  <Button label="Update record" variant="secondary" size="sm" onPress={() => openRecord(record.type as RecordType)} />
                </View>
              </View>
            ))
          )}
          {!recordOpen ? (
            <View style={styles.actions}>
              <Button label="Add record" variant="secondary" size="sm" onPress={() => openRecord('SIA')} />
            </View>
          ) : (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>{editingExisting ? 'Update record' : 'Add record'}</Text>
              <FormField label="Record type">
                <View style={styles.chips}>
                  {RECORD_TYPES.map((option) => (
                    <Fragment key={option.value}>
                      <Chip label={option.label} active={recordType === option.value} onPress={() => openRecord(option.value)} />
                    </Fragment>
                  ))}
                </View>
              </FormField>
              <FormField label="Document name" required>
                <FieldInput value={recordName} onChangeText={setRecordName} placeholder="e.g. SIA front-line licence" />
              </FormField>
              <FormField label="Document number (optional)">
                <FieldInput value={recordNumber} onChangeText={setRecordNumber} />
              </FormField>
              <FormField label="Issue date (optional)">
                <FieldInput value={recordIssue} onChangeText={setRecordIssue} placeholder="YYYY-MM-DD" autoCapitalize="none" />
              </FormField>
              <FormField label="Expiry date" required>
                <FieldInput value={recordExpiry} onChangeText={setRecordExpiry} placeholder="YYYY-MM-DD" autoCapitalize="none" />
              </FormField>
              {editingExisting ? <Text style={styles.hint}>Saving replaces the existing {recordType.replace('_', ' ').toLowerCase()} record for this Guard.</Text> : null}
              {recordError ? <Text style={styles.error} accessibilityLiveRegion="polite">{recordError}</Text> : null}
              <View style={styles.actions}>
                <Button label="Save record" onPress={submitRecord} loading={recordBusy} size="sm" />
                <Button label="Cancel" variant="tertiary" size="sm" onPress={() => setRecordOpen(false)} disabled={recordBusy} />
              </View>
            </View>
          )}
        </Section>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The compact Drawer supplies no body padding, so the body pads itself to line up with the drawer header.
  body: { gap: spacing.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.xl },
  section: {
    gap: spacing.xs,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, gap: spacing.md },
  rowLabel: { fontSize: 13, color: colors.textSecondary },
  rowValue: { flexShrink: 1, alignItems: 'flex-end' },
  value: { fontSize: 13, color: colors.textPrimary, fontWeight: '500', textAlign: 'right' },
  hint: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  meta: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  error: { fontSize: 13, color: colors.danger, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },

  blocker: {
    gap: 4,
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSubtle,
  },
  blockerHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, flexWrap: 'wrap' },
  blockerText: { flex: 1, minWidth: 140, fontSize: 13, color: colors.textPrimary, fontWeight: '600', lineHeight: 18 },
  nextStep: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },

  doc: {
    gap: 3,
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  docHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  docTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  docFile: { fontSize: 12, color: colors.info },
  badges: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' },

  panel: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.accentTeal,
    backgroundColor: colors.card,
    marginTop: spacing.xs,
  },
  panelTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    ...(IS_WEB ? ({ cursor: 'pointer' } as any) : {}),
  },
  chipActive: { backgroundColor: colors.primaryNavy, borderColor: colors.primaryNavy },
  chipText: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: '#FFFFFF' },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  fileName: { flex: 1, fontSize: 13, color: colors.textSecondary },
});
