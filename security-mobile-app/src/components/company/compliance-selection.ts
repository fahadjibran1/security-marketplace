// Pure helpers for CompanyComplianceWorkspace (no React / React Native imports so they can be unit-tested).
//
// INVARIANT (2D3.1): every document panel and document action is bound to ONE explicit Guard identity.
// The Guard shown in the panel, the Guard whose documents were fetched and the Guard a Verify/Unverify
// action applies to must all be the same Guard. The panel must never show one Guard over another
// Guard's evidence.

export type SelectableSummary = { guardId: number };

/**
 * The Guard the document panel is bound to. `requestedGuardId` is what the manager last picked.
 * If that Guard is not in the currently visible (filtered) summaries, fall back to the first visible
 * Guard; with nothing visible there is no active Guard ('') and the panel is cleared.
 */
export function resolveActiveGuardId(summaries: SelectableSummary[], requestedGuardId: string): string {
  if (requestedGuardId && summaries.some((summary) => String(summary.guardId) === requestedGuardId)) {
    return requestedGuardId;
  }
  return summaries.length ? String(summaries[0].guardId) : '';
}

/** Strict lookup — deliberately NO fallback to another Guard. */
export function findActiveSummary<T extends SelectableSummary>(summaries: T[], activeGuardId: string): T | null {
  if (!activeGuardId) return null;
  return summaries.find((summary) => String(summary.guardId) === activeGuardId) ?? null;
}

export type DocumentsState<T> = { guardId: number | null; items: T[] };

/** Documents are only ever shown for the Guard they were fetched for. */
export function documentsForGuard<T>(state: DocumentsState<T>, activeGuardId: string): T[] {
  if (!activeGuardId || state.guardId === null || String(state.guardId) !== activeGuardId) return [];
  return state.items;
}

/**
 * Stale-response guard for asynchronous document loading. `next()` starts a request and returns its
 * token; a response may only be applied while `isCurrent(token)` is still true, so a late response for
 * Guard A can never overwrite the panel after Guard B was selected.
 */
export function createRequestGate() {
  let latest = 0;
  return {
    next: () => {
      latest += 1;
      return latest;
    },
    invalidate: () => {
      latest += 1;
    },
    isCurrent: (token: number) => token === latest,
  };
}

export type DocumentLike = {
  id: number;
  type: string;
  guard?: { id?: number; fullName?: string } | null;
  originalFileName?: string | null;
  uploadCompletedAt?: string | Date | null;
  expiryDate?: string | null;
  verified: boolean;
};

/** Whether a document row belongs to the Guard an action is being taken for. */
export function documentBelongsToGuard(document: DocumentLike, guardId: number): boolean {
  return document.guard?.id === guardId;
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  sia_licence: 'SIA licence',
  right_to_work: 'Right to work',
  id_proof: 'ID proof',
  training: 'Training',
  driving_licence: 'Driving licence',
};

export function documentTypeLabel(type?: string | null): string {
  if (!type) return 'Document';
  return DOCUMENT_TYPE_LABELS[type] ?? String(type).replace(/_/g, ' ');
}

/** Date-only comparison, matching the backend rule: a document is expired once its expiry date is before today. */
export function isDocumentExpired(expiryDate?: string | null, now: Date = new Date()): boolean {
  if (!expiryDate) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiryDate);
  if (!match) return false;
  const expiry = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(expiry.getTime())) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return expiry.getTime() < today.getTime();
}

export type DocumentPresentation = {
  uploadComplete: boolean;
  statusLabel: 'Upload incomplete' | 'Verified' | 'Pending';
  expired: boolean;
  /** Evidence file can be opened (needs compliance.manage AND a completed upload). */
  canView: boolean;
  /** Verify / Mark unverified is offered (needs compliance.manage AND a completed upload). */
  canToggleVerification: boolean;
  /** Caller may see status but not the evidence file. */
  evidenceRestricted: boolean;
};

export function getDocumentPresentation(
  document: DocumentLike,
  canManageCompliance: boolean,
  now: Date = new Date(),
): DocumentPresentation {
  const uploadComplete = Boolean(document.uploadCompletedAt);
  return {
    uploadComplete,
    statusLabel: !uploadComplete ? 'Upload incomplete' : document.verified ? 'Verified' : 'Pending',
    expired: isDocumentExpired(document.expiryDate, now),
    canView: canManageCompliance && uploadComplete,
    canToggleVerification: canManageCompliance && uploadComplete,
    evidenceRestricted: !canManageCompliance && uploadComplete,
  };
}

export type VerificationDialog = {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'standard' | 'danger';
};

/** Confirmation copy naming the Guard, the document type and the file, so verification is never blind. */
export function buildVerificationDialog(input: {
  guardName: string;
  document: DocumentLike;
  verified: boolean;
  now?: Date;
}): VerificationDialog {
  const { guardName, document, verified } = input;
  const typeLabel = documentTypeLabel(document.type);
  const fileName = document.originalFileName || 'Private evidence';
  if (!verified) {
    return {
      title: `Mark ${typeLabel} for ${guardName} as unverified?`,
      message: `File: ${fileName}\n\nThis document will stop counting towards ${guardName}'s eligibility and may block new assignments.`,
      confirmLabel: 'Mark unverified',
      variant: 'danger',
    };
  }
  const expiredWarning = isDocumentExpired(document.expiryDate, input.now)
    ? `\n\nWarning: this document has expired (${document.expiryDate}). Verifying it will not make ${guardName} eligible.`
    : '';
  return {
    title: `Verify ${typeLabel} for ${guardName}?`,
    message:
      `File: ${fileName}\n\nConfirm that you have reviewed this document and it matches the Guard's record. ` +
      `Use "View document" first if you have not reviewed it.${expiredWarning}`,
    confirmLabel: 'Verify',
    variant: 'standard',
  };
}
