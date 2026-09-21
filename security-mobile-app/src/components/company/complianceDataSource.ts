// The only place the Company Compliance workspace talks to the network / file system.
//
// The workspace receives a `ComplianceDataSource`; production uses `liveComplianceDataSource` (the existing API
// functions and the existing document-picker + signed-PUT upload pattern used by Guard screening evidence).
// The visual-QA preview injects fixtures here so the REAL workspace can be rendered with zero API calls.

import * as DocumentPicker from 'expo-document-picker';

import {
  accessGuardDocument,
  completeGuardDocumentUpload,
  listCompanyGuardComplianceStatuses,
  listCompanyGuards,
  listCompanyScreeningOutcomes,
  listComplianceRecords,
  saveComplianceRecord,
  uploadGuardDocument,
  verifyGuardDocument,
} from '../../services/api';
import type {
  CompanyGuard,
  CompanyScreeningOutcome,
  ComplianceRecord,
  ComplianceRecordPayload,
  GuardComplianceSummary,
  GuardDocument,
  GuardDocumentAccess,
} from '../../types/models';
import { normalizeEvidenceMimeType, validateUpload } from './compliance-model';

export type PickedDocument = { name: string; mimeType?: string; size?: number | null; uri: string };

export type ComplianceDataSource = {
  /** All Guard compliance summaries for the Company (authoritative backend status; includes each Guard's documents). */
  listStatuses(): Promise<GuardComplianceSummary[]>;
  listGuards(): Promise<CompanyGuard[]>;
  listRecords(): Promise<ComplianceRecord[]>;
  /** Batch screening STATUS for the Company's Guards — one request, never per Guard. */
  listScreeningOutcomes(): Promise<CompanyScreeningOutcome[]>;
  /** Short-lived signed URL; the permanent storage location is never exposed. */
  accessDocument(documentId: number): Promise<GuardDocumentAccess>;
  verifyDocument(documentId: number, verified: boolean): Promise<GuardDocument>;
  saveRecord(payload: ComplianceRecordPayload): Promise<ComplianceRecord>;
  pickDocument(): Promise<PickedDocument | null>;
  /** create upload → PUT to the signed URL → complete. Throws with a user-safe message on failure. */
  uploadDocument(input: { guardId: number; type: string; file: PickedDocument; expiryDate?: string | null }): Promise<void>;
};

export const liveComplianceDataSource: ComplianceDataSource = {
  listStatuses: () => listCompanyGuardComplianceStatuses(),
  listGuards: () => listCompanyGuards(),
  listRecords: () => listComplianceRecords(),
  listScreeningOutcomes: () => listCompanyScreeningOutcomes(),
  accessDocument: (documentId) => accessGuardDocument(documentId),
  verifyDocument: (documentId, verified) => verifyGuardDocument(documentId, verified),
  saveRecord: (payload) => saveComplianceRecord(payload),

  async pickDocument() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/jpeg', 'image/png'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled || !result.assets?.[0]) return null;
    const asset = result.assets[0];
    return { name: asset.name, mimeType: asset.mimeType, size: asset.size, uri: asset.uri };
  },

  async uploadDocument({ guardId, type, file, expiryDate }) {
    const source = await fetch(file.uri);
    if (!source.ok) throw new Error('Unable to read the selected document.');
    const blob = await source.blob();
    const mimeType = normalizeEvidenceMimeType(file.mimeType || blob.type, file.name);
    const sizeBytes = file.size || blob.size;
    const problem = validateUpload({ name: file.name, mimeType: mimeType ?? undefined, size: sizeBytes, expiryDate: expiryDate ?? '' });
    if (problem || !mimeType) throw new Error(problem ?? 'Choose a PDF, JPEG/JPG or PNG document.');

    const created = await uploadGuardDocument({
      guardId,
      type,
      originalFileName: file.name,
      mimeType,
      sizeBytes,
      expiryDate: expiryDate || null,
    });
    const uploaded = await fetch(created.upload.url, {
      method: created.upload.method,
      headers: created.upload.headers,
      body: blob,
    });
    if (!uploaded.ok) {
      throw new Error('The document upload did not finish. It is listed as "Upload incomplete" — choose Add document to try again.');
    }
    await completeGuardDocumentUpload(created.id);
  },
};
