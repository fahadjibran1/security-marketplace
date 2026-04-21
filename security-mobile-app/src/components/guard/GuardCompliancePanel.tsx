import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  formatApiErrorMessage,
  getMyGuard,
  getMyGuardComplianceStatus,
  listMyGuardDocuments,
  updateMyGuard,
  uploadMyGuardDocument,
} from '../../services/api';
import { GuardComplianceSummary, GuardDocument, GuardDocumentType, GuardProfile } from '../../types/models';
import { FeatureCard } from '../FeatureCard';
import { colors } from '../../theme';

const DOCUMENT_TYPES: Array<{ value: GuardDocumentType; label: string }> = [
  { value: 'sia_licence', label: 'SIA licence' },
  { value: 'right_to_work', label: 'Right to work' },
  { value: 'id_proof', label: 'ID proof' },
  { value: 'training', label: 'Training' },
];

type ProfileFormState = {
  siaLicenseNumber: string;
  siaExpiryDate: string;
  rightToWorkStatus: string;
  rightToWorkExpiryDate: string;
};

type DocumentFormState = {
  type: GuardDocumentType;
  fileUrl: string;
  expiryDate: string;
};

const EMPTY_PROFILE: ProfileFormState = {
  siaLicenseNumber: '',
  siaExpiryDate: '',
  rightToWorkStatus: '',
  rightToWorkExpiryDate: '',
};

const EMPTY_DOCUMENT: DocumentFormState = {
  type: 'sia_licence',
  fileUrl: '',
  expiryDate: '',
};

function formatDate(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB');
}

function getStatusPalette(status?: string | null) {
  if (status === 'invalid') return { backgroundColor: '#FEE2E2', color: '#B91C1C' };
  if (status === 'expired') return { backgroundColor: '#FEE2E2', color: '#991B1B' };
  if (status === 'expiring') return { backgroundColor: '#FEF3C7', color: '#B45309' };
  return { backgroundColor: '#DCFCE7', color: '#166534' };
}

function formatDocumentType(value?: string | null) {
  return String(value || 'document').replace(/_/g, ' ');
}

export function GuardCompliancePanel() {
  const [guard, setGuard] = React.useState<GuardProfile | null>(null);
  const [summary, setSummary] = React.useState<GuardComplianceSummary | null>(null);
  const [documents, setDocuments] = React.useState<GuardDocument[]>([]);
  const [profileForm, setProfileForm] = React.useState<ProfileFormState>(EMPTY_PROFILE);
  const [documentForm, setDocumentForm] = React.useState<DocumentFormState>(EMPTY_DOCUMENT);
  const [loading, setLoading] = React.useState(false);
  const [savingProfile, setSavingProfile] = React.useState(false);
  const [uploadingDocument, setUploadingDocument] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextGuard, nextSummary, nextDocuments] = await Promise.all([
        getMyGuard(),
        getMyGuardComplianceStatus(),
        listMyGuardDocuments(),
      ]);
      setGuard(nextGuard);
      setSummary(nextSummary);
      setDocuments(nextDocuments);
      setProfileForm({
        siaLicenseNumber: nextGuard.siaLicenseNumber || nextGuard.siaLicenceNumber || '',
        siaExpiryDate: nextGuard.siaExpiryDate || '',
        rightToWorkStatus: nextGuard.rightToWorkStatus || '',
        rightToWorkExpiryDate: nextGuard.rightToWorkExpiryDate || '',
      });
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load guard compliance details.') });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const saveProfile = React.useCallback(async () => {
    setSavingProfile(true);
    try {
      await updateMyGuard({
        siaLicenseNumber: profileForm.siaLicenseNumber.trim() || undefined,
        siaExpiryDate: profileForm.siaExpiryDate.trim() || null,
        rightToWorkStatus: profileForm.rightToWorkStatus.trim() || null,
        rightToWorkExpiryDate: profileForm.rightToWorkExpiryDate.trim() || null,
      });
      setFeedback({ tone: 'success', message: 'Compliance profile updated.' });
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save compliance profile.') });
    } finally {
      setSavingProfile(false);
    }
  }, [loadData, profileForm]);

  const uploadDocument = React.useCallback(async () => {
    if (!documentForm.fileUrl.trim()) {
      setFeedback({ tone: 'error', message: 'Add a document URL before uploading.' });
      return;
    }
    setUploadingDocument(true);
    try {
      await uploadMyGuardDocument({
        type: documentForm.type,
        fileUrl: documentForm.fileUrl.trim(),
        expiryDate: documentForm.expiryDate.trim() || null,
      });
      setDocumentForm(EMPTY_DOCUMENT);
      setFeedback({ tone: 'success', message: 'Document uploaded for company review.' });
      await loadData();
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to upload document.') });
    } finally {
      setUploadingDocument(false);
    }
  }, [documentForm, loadData]);

  const badgePalette = getStatusPalette(summary?.complianceStatus);

  return (
    <FeatureCard title="Compliance & licence control" subtitle="Keep your legal work documents current so you can be assigned safely.">
      {feedback ? (
        <View style={[styles.feedbackCard, feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess]}>
          <Text style={styles.feedbackText}>{feedback.message}</Text>
        </View>
      ) : null}

      <View style={styles.summaryRow}>
        <View style={styles.summaryBlock}>
          <Text style={styles.summaryLabel}>Current status</Text>
          <View style={[styles.badge, { backgroundColor: badgePalette.backgroundColor }]}>
            <Text style={[styles.badgeText, { color: badgePalette.color }]}>{summary?.complianceStatus || 'unknown'}</Text>
          </View>
        </View>
        <View style={styles.summaryBlock}>
          <Text style={styles.summaryLabel}>Guard</Text>
          <Text style={styles.summaryValue}>{guard?.fullName || 'Guard profile'}</Text>
        </View>
      </View>

      {(summary?.blockingReasons?.length || summary?.expiringReasons?.length) ? (
        <View style={styles.reasonList}>
          {summary?.blockingReasons?.map((reason) => (
            <Text key={`block-${reason}`} style={styles.blockingText}>{reason}</Text>
          ))}
          {summary?.expiringReasons?.map((reason) => (
            <Text key={`warn-${reason}`} style={styles.expiringText}>{reason}</Text>
          ))}
        </View>
      ) : (
        <Text style={styles.helperText}>{loading ? 'Loading compliance status...' : 'No compliance blockers are currently recorded.'}</Text>
      )}

      <Text style={styles.sectionTitle}>Licence profile</Text>
      <View style={styles.formGrid}>
        <TextInput
          style={styles.input}
          value={profileForm.siaLicenseNumber}
          onChangeText={(value: string) => setProfileForm((current) => ({ ...current, siaLicenseNumber: value }))}
          placeholder="SIA licence number"
        />
        <TextInput
          style={styles.input}
          value={profileForm.siaExpiryDate}
          onChangeText={(value: string) => setProfileForm((current) => ({ ...current, siaExpiryDate: value }))}
          placeholder="SIA expiry YYYY-MM-DD"
        />
        <TextInput
          style={styles.input}
          value={profileForm.rightToWorkStatus}
          onChangeText={(value: string) => setProfileForm((current) => ({ ...current, rightToWorkStatus: value }))}
          placeholder="Right-to-work status"
        />
        <TextInput
          style={styles.input}
          value={profileForm.rightToWorkExpiryDate}
          onChangeText={(value: string) => setProfileForm((current) => ({ ...current, rightToWorkExpiryDate: value }))}
          placeholder="Right-to-work expiry YYYY-MM-DD"
        />
      </View>
      <Pressable style={styles.primaryButton} onPress={saveProfile} disabled={savingProfile}>
        <Text style={styles.primaryButtonText}>{savingProfile ? 'Saving...' : 'Save licence profile'}</Text>
      </Pressable>

      <Text style={styles.sectionTitle}>Upload document</Text>
      <View style={styles.formGrid}>
        <View style={styles.selectWrap}>
          <Text style={styles.selectLabel}>Type</Text>
          <View style={styles.selectRow}>
            {DOCUMENT_TYPES.map((item) => (
              <Pressable
                key={item.value}
                style={[styles.selectPill, documentForm.type === item.value && styles.selectPillActive]}
                onPress={() => setDocumentForm((current) => ({ ...current, type: item.value }))}
              >
                <Text style={[styles.selectPillText, documentForm.type === item.value && styles.selectPillTextActive]}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <TextInput
          style={styles.input}
          value={documentForm.fileUrl}
          onChangeText={(value: string) => setDocumentForm((current) => ({ ...current, fileUrl: value }))}
          placeholder="Document file URL"
        />
        <TextInput
          style={styles.input}
          value={documentForm.expiryDate}
          onChangeText={(value: string) => setDocumentForm((current) => ({ ...current, expiryDate: value }))}
          placeholder="Document expiry YYYY-MM-DD optional"
        />
      </View>
      <Pressable style={styles.secondaryButton} onPress={uploadDocument} disabled={uploadingDocument}>
        <Text style={styles.secondaryButtonText}>{uploadingDocument ? 'Uploading...' : 'Upload document'}</Text>
      </Pressable>

      <Text style={styles.sectionTitle}>Document list</Text>
      {documents.length === 0 ? (
        <Text style={styles.helperText}>No documents uploaded yet.</Text>
      ) : (
        documents.map((document) => (
          <View key={document.id} style={styles.documentRow}>
            <View style={styles.flexGrow}>
              <Text style={styles.documentTitle}>{formatDocumentType(document.type)}</Text>
              <Text style={styles.helperText}>Expiry: {formatDate(document.expiryDate)} | Uploaded: {formatDate(document.uploadedAt)}</Text>
              <Text style={styles.documentUrl}>{document.fileUrl}</Text>
            </View>
            <View style={[styles.badge, document.verified ? styles.badgeValid : styles.badgeInvalid]}>
              <Text style={[styles.badgeText, document.verified ? styles.badgeValidText : styles.badgeInvalidText]}>
                {document.verified ? 'Verified' : 'Pending'}
              </Text>
            </View>
          </View>
        ))
      )}
    </FeatureCard>
  );
}

const styles = StyleSheet.create({
  summaryRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  summaryBlock: { flex: 1, minWidth: 160, gap: 6 },
  summaryLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  summaryValue: { color: colors.textPrimary, fontSize: 16, fontWeight: '800' },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  badgeText: { fontWeight: '800', textTransform: 'capitalize' },
  badgeValid: { backgroundColor: '#DCFCE7' },
  badgeValidText: { color: '#166534' },
  badgeInvalid: { backgroundColor: '#FEE2E2' },
  badgeInvalidText: { color: '#B91C1C' },
  reasonList: { gap: 6 },
  blockingText: { color: '#B91C1C', fontWeight: '700' },
  expiringText: { color: '#B45309', fontWeight: '700' },
  helperText: { color: colors.textSecondary, lineHeight: 20 },
  sectionTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '800', marginTop: 12, marginBottom: 8 },
  formGrid: { gap: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: colors.card,
    color: colors.textPrimary,
  },
  primaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primaryNavy,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800' },
  secondaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryButtonText: { color: colors.textPrimary, fontWeight: '800' },
  selectWrap: { gap: 8 },
  selectLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  selectRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  selectPill: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.card,
  },
  selectPillActive: { borderColor: colors.primaryNavy, backgroundColor: colors.primaryNavy },
  selectPillText: { color: colors.textPrimary, fontWeight: '700' },
  selectPillTextActive: { color: '#FFFFFF' },
  documentRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  documentTitle: { color: colors.textPrimary, fontWeight: '800', textTransform: 'capitalize' },
  documentUrl: { color: colors.supportBlue, fontSize: 12, marginTop: 4 },
  flexGrow: { flex: 1 },
  feedbackCard: { borderRadius: 12, padding: 10, marginBottom: 10 },
  feedbackSuccess: { backgroundColor: '#DCFCE7' },
  feedbackError: { backgroundColor: '#FEE2E2' },
  feedbackText: { color: colors.textPrimary, fontWeight: '700' },
});
