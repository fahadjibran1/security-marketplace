import React, { PropsWithChildren } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import {
  acceptMyScreeningConsent,
  addMyScreeningAddress,
  addMyScreeningHistory,
  addMyScreeningReference,
  completeMyScreeningEvidence,
  createMyScreeningEvidence,
  deleteMyScreeningAddress,
  deleteMyScreeningHistory,
  getMyGuard,
  getMyScreening,
  startMyScreening,
  submitMyScreening,
  updateMyScreeningCompliance,
  updateMyScreeningAddress,
  updateMyScreeningHistory,
  updateMyScreeningProfile,
  withdrawMyScreeningConsent,
} from "../../services/api";
import { GuardProfile, GuardScreening, ScreeningStatus } from "../../types/models";
import { colors, radii, spacing } from "../../theme";
import { formatScreeningDate, normalizeScreeningPostcode, screeningDateToIso } from "./screening-format";

type Step =
  | "personal"
  | "identity"
  | "addresses"
  | "history"
  | "references"
  | "checks"
  | "evidence"
  | "consent"
  | "review";
const STEPS: Array<{ key: Step; label: string }> = [
  { key: "personal", label: "Personal Details" },
  { key: "identity", label: "Identity" },
  { key: "addresses", label: "Address History" },
  { key: "history", label: "Activity History" },
  { key: "references", label: "References" },
  { key: "checks", label: "SIA & Right to Work" },
  { key: "evidence", label: "Supporting Evidence" },
  { key: "consent", label: "Consent & Declaration" },
  { key: "review", label: "Review & Submit" },
];
const STATUS: Record<ScreeningStatus, string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  READY_FOR_REVIEW: "Ready for review",
  UNDER_REVIEW: "Under review",
  VETTED: "Vetted",
  REQUIRES_ATTENTION: "Requires attention",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
};
const editable = (status?: ScreeningStatus) =>
  !status ||
  ["NOT_STARTED", "IN_PROGRESS", "REQUIRES_ATTENTION"].includes(status);
const pretty = (value?: string) =>
  value
    ? value
        .toLowerCase()
        .replaceAll("_", " ")
        .replace(/^./, (x) => x.toUpperCase())
    : "Not supplied";
const dateLabel = formatScreeningDate;
/**
 * Candidate-facing wording for the backend HistoryType enum. The enum values are the contract and
 * are never changed here — only how they read to a Guard, who is accounting for their life rather
 * than filling in an employment record. Screening requires continuous *explainable activity*, not
 * continuous employment.
 */
const HISTORY_TYPES = [
  ["EMPLOYMENT", "Employed"],
  ["SELF_EMPLOYMENT", "Self-employed"],
  ["EDUCATION", "Education / training"],
  ["UNEMPLOYMENT", "Unemployed / looking for work"],
  ["CAREER_BREAK", "Career break / caring responsibilities"],
  ["OVERSEAS", "Overseas"],
  ["OTHER_EXPLAINED_PERIOD", "Other explained period"],
] as const;
const historyTypeLabel = (type?: string | null) =>
  HISTORY_TYPES.find(([value]) => value === type)?.[1] || pretty(type || "");
const activityOrganisationLabel = (type: string) =>
  ({
    EMPLOYMENT: "Employer / organisation",
    SELF_EMPLOYMENT: "Business / trading name",
    EDUCATION: "School / college / university",
    UNEMPLOYMENT: "Explanation",
    CAREER_BREAK: "Explanation",
    OVERSEAS: "Organisation / explanation",
    OTHER_EXPLAINED_PERIOD: "Organisation / explanation",
  })[type] || "Organisation / explanation";
const profileFromScreening = (d?: GuardScreening | null) => ({
  legalFullName: d?.legalFullName || "",
  previousNames: d?.previousNames || "",
  dateOfBirth: d?.dateOfBirth ? formatScreeningDate(d.dateOfBirth) : "",
  nationality: d?.nationality || "",
  siaLicenceType: d?.siaLicenceType || "",
});
const emptyAddressForm = () => ({ addressLine1: "", addressLine2: "", townCity: "", postcode: "", startDate: "", endDate: "", isCurrent: false });
const emptyActivityForm = () => ({ type: "", startDate: "", endDate: "", organisation: "", description: "", isCurrent: false });
const emptyReferenceForm = () => ({ historyId: "", organisation: "", contactPerson: "", relationship: "", businessEmail: "", phone: "" });
const confirmDelete = (label:string) => Platform.OS === 'web'
  ? Promise.resolve(globalThis.confirm(`Delete this ${label}? The server will recalculate screening coverage.`))
  : new Promise<boolean>((resolve) => Alert.alert(`Delete ${label}?`,'The server will recalculate screening coverage.',[
      {text:'Cancel',style:'cancel',onPress:()=>resolve(false)},
      {text:'Delete',style:'destructive',onPress:()=>resolve(true)},
    ],{cancelable:true,onDismiss:()=>resolve(false)}));

export function GuardScreeningPanel({
  onContinue,
}: {
  onContinue?: () => void;
}) {
  const [data, setData] = React.useState<GuardScreening | null>(null),
    [error, setError] = React.useState("");
  React.useEffect(() => {
    getMyScreening()
      .then(setData)
      .catch((e) => setError(e.message || "Unable to load screening."));
  }, []);
  // Completion comes from the server's own per-section statuses so this summary can never
  // disagree with the journey. A section counts as done once it is COMPLETE or VERIFIED.
  const done = (stepKey: string) => {
    const items = (data?.requirements?.remediation || []).filter((item) => item.step === stepKey);
    return items.length > 0 && items.every((item) => item.status === "COMPLETE" || item.status === "VERIFIED");
  };
  const checks: Array<[string, boolean]> = [
    ["Personal details", done("personal")],
    ["Identity", done("identity")],
    ["Address history", done("addresses")],
    [`${data?.screeningPeriodYears || 5}-year activity history`, done("history")],
    ["References", done("references")],
    ["SIA & Right to Work", done("checks")],
    ["Supporting evidence", !!data?.evidence?.some((x) => x.uploadCompleted)],
    ["Consent & declaration", done("consent")],
  ];
  return (
    <View
      style={s.card}
      accessibilityLabel="Your vetting and screening summary"
    >
      <Text style={s.eyebrow}>YOUR VETTING & SCREENING</Text>
      <View style={s.summaryRow}>
        <View>
          <Text style={s.label}>Screening status</Text>
          <Text style={s.title}>{STATUS[data?.status || "NOT_STARTED"]}</Text>
        </View>
        <Text style={s.progress}>{data?.progress || 0}%</Text>
      </View>
      <View style={s.track}>
        <View
          style={[
            s.trackFill,
            { width: `${Math.max(0, Math.min(100, data?.progress || 0))}%` },
          ]}
        />
      </View>
      <Text style={s.note}>
        Complete your screening to become eligible for operational security
        work.
      </Text>
      <View style={s.checkGrid}>
        {checks.map(([label, done]) => (
          <Text key={label} style={done ? s.done : s.pending}>
            {done ? "✓" : "○"} {label}
          </Text>
        ))}
      </View>
      <View style={s.accessBox}>
        <Text style={s.accessGood}>Marketplace access: Available</Text>
        <Text style={data?.status === "VETTED" ? s.accessGood : s.accessWarn}>
          Work eligibility:{" "}
          {data?.status === "VETTED"
            ? "Screening complete — compliance checks still apply"
            : "Not yet eligible"}
        </Text>
      </View>
      <Text style={s.note}>
        You can browse and apply for jobs while completing your screening.
      </Text>
      <Pressable
        accessibilityRole="button"
        style={s.button}
        onPress={onContinue}
      >
        <Text style={s.buttonText}>
          {data?.id ? "Continue screening" : "Start screening"}
        </Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function GuardScreeningJourney({ onBack, scrollViewRef }: { onBack: () => void; scrollViewRef?: { readonly current: { scrollTo(config: { y: number; animated: boolean }): void } | null } }) {
  const [data, setData] = React.useState<GuardScreening | null>(null),
    [step, setStep] = React.useState<Step>("personal");
  const [guard, setGuard] = React.useState<GuardProfile | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stageRef = React.useRef<any>(null);
  const [error, setError] = React.useState(""),
    [feedback, setFeedback] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  const [profile, setProfile] = React.useState({
    legalFullName: "",
    previousNames: "",
    dateOfBirth: "",
    nationality: "",
    siaLicenceType: "",
  });
  const [history, setHistory] = React.useState(emptyActivityForm());
  const [address, setAddress] = React.useState(emptyAddressForm());
  const [editingAddressId, setEditingAddressId] = React.useState<number | null>(null);
  const [editingHistoryId, setEditingHistoryId] = React.useState<number | null>(null);
  const [compliance, setCompliance] = React.useState({siaLicenseNumber:"",siaExpiryDate:"",rightToWorkStatus:"",rightToWorkExpiryDate:""});
  const [editingPersonal, setEditingPersonal] = React.useState(false);
  const [replacingIdentity, setReplacingIdentity] = React.useState(false);
  const [editingAddresses, setEditingAddresses] = React.useState(false);
  const [editingActivity, setEditingActivity] = React.useState(false);
  const [editingReferences, setEditingReferences] = React.useState(false);
  const [editingChecks, setEditingChecks] = React.useState(false);
  const [showAddressForm, setShowAddressForm] = React.useState(false);
  const [showHistoryForm, setShowHistoryForm] = React.useState(false);
  const [reference, setReference] = React.useState(emptyReferenceForm());
  const [refErrors, setRefErrors] = React.useState<string[]>([]);
  const load = React.useCallback(async () => {
    try {
      const [next,nextGuard] = await Promise.all([getMyScreening(),getMyGuard()]);
      setData(next);
      setGuard(nextGuard);
      setCompliance({siaLicenseNumber:nextGuard.siaLicenseNumber||nextGuard.siaLicenceNumber||"",siaExpiryDate:nextGuard.siaExpiryDate?dateLabel(nextGuard.siaExpiryDate):"",rightToWorkStatus:nextGuard.rightToWorkStatus||"",rightToWorkExpiryDate:nextGuard.rightToWorkExpiryDate?dateLabel(nextGuard.rightToWorkExpiryDate):""});
      setProfile((p) => ({
        ...p,
        legalFullName: next.legalFullName || p.legalFullName,
        dateOfBirth: next.dateOfBirth
          ? formatScreeningDate(next.dateOfBirth)
          : p.dateOfBirth,
        nationality: next.nationality || p.nationality,
        previousNames: next.previousNames || p.previousNames,
        siaLicenceType: next.siaLicenceType || p.siaLicenceType,
      }));
    } catch (e) {
      setError((e as Error).message || "Unable to load screening.");
    }
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);
  const act = async (fn: () => Promise<unknown>, message: string, onSuccess?: () => void) => {
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await fn();
      await load();
      onSuccess?.();
      setFeedback(message);
      return true;
    } catch (e) {
      setError((e as Error).message || "The action could not be completed.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const uploadEvidence = async (
    category: string,
    asset: DocumentPicker.DocumentPickerAsset,
  ) => {
    let raw: Blob;
    try {
      const source = await fetch(asset.uri);
      if (!source.ok) throw new Error("read failed");
      raw = await source.blob();
    } catch {
      throw new Error("Unable to read the selected file. Choose the document again.");
    }
    const mimeType = normalizeEvidenceMimeType(asset.mimeType || raw.type, asset.name);
    if (!mimeType) throw new Error("Choose a PDF, JPEG/JPG or PNG document.");
    const sizeBytes = raw.size || asset.size || 0;
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1)
      throw new Error("The selected document is empty or its size is unavailable.");
    if (sizeBytes > 10 * 1024 * 1024)
      throw new Error("The selected document exceeds the 10 MB size limit.");
    // The signed URL commits us to an exact Content-Type. On Android the native networking layer
    // ignores the Content-Type header when the body is a Blob and sends the Blob's own type
    // instead, which breaks the SigV4 signature. Re-wrap the bytes so the Blob carries exactly the
    // type we asked the server to sign. On web this is a no-op.
    const body = raw.type === mimeType ? raw : new Blob([raw], { type: mimeType });
    const created = await createMyScreeningEvidence({
      category,
      originalFileName: asset.name,
      mimeType,
      sizeBytes,
    });
    let uploaded: Response;
    try {
      uploaded = await fetch(created.upload.url, {
        method: created.upload.method,
        headers: created.upload.headers,
        body,
      });
    } catch {
      throw new Error("Network unavailable. Check your connection and try the upload again.");
    }
    if (!uploaded.ok)
      throw new Error("Upload failed. Please try again.");
    try {
      await completeMyScreeningEvidence(created.id);
    } catch (e) {
      throw new Error(
        `Upload verification failed. ${(e as Error).message || "Please choose the document again."}`,
      );
    }
  };
  const categorizeUploadError = (message: string): string => {
    if (/not configured|service unavailable/i.test(message))
      return "Document storage is temporarily unavailable. Please try again later.";
    if (/session|unauthorized|unauthenticated/i.test(message))
      return "Your session has expired. Please sign in again and retry the upload.";
    if (/network|fetch failed|connection/i.test(message))
      return "Unable to reach the upload service. Check your connection and try again.";
    return message;
  };
  const uploadAct = async (fn: () => Promise<unknown>): Promise<string | null> => {
    setFeedback("");
    setError("");
    try {
      await fn();
      await load();
      return null;
    } catch (e) {
      return categorizeUploadError((e as Error).message || "The document could not be uploaded.");
    }
  };
  const canEdit = editable(data?.status),
    canCorrectRecords = canEdit || data?.status === "READY_FOR_REVIEW",
    activeIndex = STEPS.findIndex((x) => x.key === step);
  const actionRequired = (key:string) => data?.requirements?.remediation?.some((item)=>item.key===key&&item.status==="ACTION_REQUIRED")===true;
  // Single source of truth for "is this section done": the authoritative per-section statuses the
  // server already returns. No second completion model is kept on the client.
  type SectionStatus = "ACTION_REQUIRED" | "AWAITING_VERIFICATION" | "COMPLETE" | "VERIFIED";
  const sectionStatus = (stepKey: string): SectionStatus | null => {
    const items = (data?.requirements?.remediation || []).filter((item) => item.step === stepKey);
    if (!items.length) return null;
    if (items.some((item) => item.status === "ACTION_REQUIRED")) return "ACTION_REQUIRED";
    if (items.some((item) => item.status === "AWAITING_VERIFICATION")) return "AWAITING_VERIFICATION";
    if (items.every((item) => item.status === "VERIFIED")) return "VERIFIED";
    return "COMPLETE";
  };
  const sectionDone = (stepKey: string) => {
    const status = sectionStatus(stepKey);
    return status === "COMPLETE" || status === "VERIFIED";
  };
  const requirementStatus = (key: string): SectionStatus | null =>
    ((data?.requirements?.remediation || []).find((item) => item.key === key)?.status as SectionStatus) || null;
  const requirementMessage = (key: string): string =>
    (data?.requirements?.remediation || []).find((item) => item.key === key)?.message || "";
  // The backend requires exactly one completed upload per evidence category; reviewer verification
  // is a separate step that does not block submission. Once something is uploaded the section is
  // informational, so the upload control stops being the primary action.
  /** Most recent completed upload in a category — what the summary describes. */
  const latestEvidence = (category: string) =>
    [...(data?.evidence || [])].filter((e) => e.category === category && e.uploadCompleted).slice(-1)[0];
  const evidenceSummaryRows = (category: string): Array<[string, string | null | undefined]> => {
    const e = latestEvidence(category);
    if (!e) return [];
    return [
      ["Document", e.originalFileName || pretty(e.mimeType)],
      ["Size", e.sizeBytes ? `${Math.ceil(e.sizeBytes / 1024)} KB` : null],
      ["Reviewer", verificationLabel(e.verificationState)],
    ];
  };
  const evidenceSettled = (category: string) => {
    const status = requirementStatus(`${category}_evidence`);
    return status === "AWAITING_VERIFICATION" || status === "VERIFIED";
  };
  const canCorrectCompliance = canEdit || (data?.status === "READY_FOR_REVIEW" && (actionRequired("sia_expiry") || actionRequired("sia_check") || actionRequired("rtw_status") || actionRequired("rtw_check")));
  const canUploadEvidence = (category:string) => canEdit || (data?.status === "READY_FOR_REVIEW" && (category==="reference" || actionRequired(`${category}_evidence`)));
  const navigateToStep = (next: Step) => {
    setError("");
    setFeedback("");
    setRefErrors([]);
    setStep(next);
  };
  const navigateToRemediation = (next: Step) => {
    navigateToStep(next);
    if(next==="addresses"){setEditingAddressId(null);setAddress(emptyAddressForm());setShowAddressForm(true);}
    if(next==="history"){setEditingHistoryId(null);setHistory(emptyActivityForm());setShowHistoryForm(true);}
    if (scrollViewRef?.current && stageRef.current) {
      const sv = scrollViewRef.current;
      const stage = stageRef.current;
      setTimeout(() => {
        // Measuring is a convenience only. A ScrollView ref is not a host node on native, so
        // never let a failed measurement escape this timer — an uncaught throw here terminates
        // the app in a release build. Fail silently and leave the scroll position alone.
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const target: any = typeof (sv as any).getInnerViewNode === "function" ? (sv as any).getInnerViewNode() : sv;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (stage as any).measureLayout(target, (_x: number, y: number) => { try { sv.scrollTo({ y, animated: true }); } catch {} }, () => {});
        } catch {}
      }, 50);
    }
  };
  if (!data?.id)
    return (
      <View style={s.journey}>
        <Pressable onPress={onBack}>
          <Text style={s.back}>‹ Back to Profile</Text>
        </Pressable>
        <View style={s.hero}>
          <Text style={s.eyebrow}>GUARD SCREENING</Text>
          <Text style={s.heroTitle}>Complete screening at your own pace</Text>
          <Text style={s.note}>
            Your account is active. You can browse and apply for jobs now.
            Operational hiring and assignment require completed screening and
            compliance checks.
          </Text>
          <Action
            disabled={busy}
            label={busy ? "Starting…" : "Start screening"}
            onPress={() =>
              act(() => startMyScreening(), "Your screening file is ready.")
            }
          />
        </View>
      </View>
    );
  return (
    <View style={s.journey}>
      <Pressable accessibilityRole="button" onPress={onBack}>
        <Text style={s.back}>‹ Back to Profile</Text>
      </Pressable>
      <View style={s.hero}>
        <Text style={s.eyebrow}>GUARD SCREENING</Text>
        <View style={s.summaryRow}>
          <View style={s.flex}>
            <Text style={s.heroTitle}>{STATUS[data.status]}</Text>
            <Text style={s.note}>
              Step {activeIndex + 1} of {STEPS.length} · {data.progress}%
              complete
            </Text>
          </View>
          <Text style={s.progress}>{data.progress}%</Text>
        </View>
        <View style={s.track}>
          <View style={[s.trackFill, { width: `${data.progress}%` }]} />
        </View>
        <Text style={s.accessGood}>Marketplace access: Available</Text>
        <Text style={data.status === "VETTED" ? s.accessGood : s.accessWarn}>
          Work eligibility:{" "}
          {data.status === "VETTED"
            ? "Screening complete — operational compliance still applies"
            : "Not yet eligible"}
        </Text>
        {data.status === "VETTED" ? (
          <View style={s.vettedMeta}>
            <Text style={s.meta}>
              Screening completed:{" "}
              {data.vettedAt
                ? formatScreeningDate(data.vettedAt)
                : "Recorded by reviewer"}
            </Text>
            <Text style={s.meta}>
              SIA: {pretty(data.siaRegisterVerification)} · Right to Work:{" "}
              {pretty(data.rightToWorkVerification)}
            </Text>
            {data.retentionReviewAt ? (
              <Text style={s.meta}>
                Next review:{" "}
                {formatScreeningDate(data.retentionReviewAt)}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={s.actionSummary} accessibilityLabel="What you still need to do">
        <Text style={s.stageTitle}>What you still need to do</Text>
        {(data.requirements?.remediation || []).filter((item) => item.status === "ACTION_REQUIRED").length ? (
          (data.requirements?.remediation || []).filter((item) => item.status === "ACTION_REQUIRED").map((item) => (
            <View key={item.key} style={s.remediationRow}>
              <View style={s.flex}><Text style={s.actionRequired}>Action required · {item.label}</Text><Text style={s.note}>{item.message}</Text></View>
              <Pressable accessibilityRole="button" style={s.fixButton} onPress={() => navigateToRemediation(item.step as Step)}><Text style={s.fixButtonText}>Fix this</Text></Pressable>
            </View>
          ))
        ) : <Text style={s.accessGood}>No candidate corrections are currently required.</Text>}
        {(data.requirements?.remediation || []).filter((item) => item.status === "AWAITING_VERIFICATION").map((item) => (
          <View key={item.key} style={s.remediationRow}><View style={s.flex}><Text style={s.awaiting}>Awaiting verification · {item.label}</Text><Text style={s.note}>{item.message}</Text></View></View>
        ))}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.stepNav}
      >
        {STEPS.map((x, i) => {
          const status = sectionStatus(x.key);
          const done = status === "COMPLETE" || status === "VERIFIED";
          const awaiting = status === "AWAITING_VERIFICATION";
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: x.key === step }}
              accessibilityLabel={`${x.label}${done ? " — completed" : awaiting ? " — awaiting verification" : status === "ACTION_REQUIRED" ? " — action required" : ""}`}
              key={x.key}
              onPress={() => navigateToStep(x.key)}
              style={[s.step, x.key === step && s.stepActive, done && x.key !== step && s.stepDone]}
            >
              <Text
                style={[
                  s.stepNumber,
                  x.key === step && s.stepTextActive,
                  done && x.key !== step && s.stepNumberDone,
                ]}
              >
                {done ? "✓" : i + 1}
              </Text>
              <Text style={[s.stepText, x.key === step && s.stepTextActive]}>
                {x.label}
              </Text>
              {awaiting && x.key !== step ? (
                <Text style={s.stepPending}>Awaiting check</Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
      {feedback ? (
        <Text accessibilityRole="alert" style={s.success}>
          {feedback}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={s.errorBox}>
          {error}
        </Text>
      ) : null}
      <View ref={stageRef} style={s.stage}>
        <Text style={s.stageTitle}>{STEPS[activeIndex].label}</Text>
        <Text style={s.note}>
          {stageHelp(step, data.screeningPeriodYears || 5)}
        </Text>
        {step === "personal" ? (
          <SectionSummary
            status={requirementStatus("personal")}
            title="Personal details"
            rows={[
              ["Name", data.legalFullName],
              ["Date of birth", data.dateOfBirth ? dateLabel(data.dateOfBirth) : null],
              ["Nationality", data.nationality],
              ["SIA licence type", data.siaLicenceType],
            ]}
            editLabel="Edit details"
            editing={editingPersonal}
            onEdit={() => setEditingPersonal(true)}
          >
            <Field
              label="Legal full name"
              value={profile.legalFullName}
              set={(v) => setProfile({ ...profile, legalFullName: v })}
            />
            <Field
              label="Previous names (optional)"
              value={profile.previousNames}
              set={(v) => setProfile({ ...profile, previousNames: v })}
            />
            <Field
              label="Date of birth (DD/MM/YYYY)"
              value={profile.dateOfBirth}
              set={(v) => setProfile({ ...profile, dateOfBirth: v })}
            />
            <Field
              label="Nationality"
              value={profile.nationality}
              set={(v) => setProfile({ ...profile, nationality: v })}
            />
            <Field
              label="SIA licence type (optional)"
              value={profile.siaLicenceType}
              set={(v) => setProfile({ ...profile, siaLicenceType: v })}
            />
            <Action
              disabled={!canEdit || busy}
              label="Save personal details"
              onPress={() =>
                act(
                  () =>
                    updateMyScreeningProfile({
                      ...profile,
                      dateOfBirth: screeningDateToIso(profile.dateOfBirth),
                    }),
                  "Personal details saved.",
                  () => setEditingPersonal(false),
                )
              }
            />
            {requirementStatus("personal") === "COMPLETE" ? (
              <Action
                disabled={busy}
                variant="secondary"
                label="Cancel"
                // Cancel is presentation only — nothing persisted has been touched.
                onPress={() => { setProfile(profileFromScreening(data)); setEditingPersonal(false); }}
              />
            ) : null}
          </SectionSummary>
        ) : null}
        {step === "identity" ? (
          <SectionSummary
            status={requirementStatus("identity_evidence")}
            title="Identity evidence"
            rows={evidenceSummaryRows("identity")}
            note="One identity document is all that is required."
            editLabel="Replace document"
            editing={replacingIdentity}
            onEdit={() => setReplacingIdentity(true)}
          >
            <StatusCards
              items={[
                [
                  "Candidate details",
                  data.legalFullName ? "Candidate supplied" : "Not supplied",
                ],
                ["Identity evidence", evidenceState(data, "identity")],
                [
                  "Reviewer verification",
                  verificationLabel(data.identityVerification),
                ],
              ]}
            />
            <SectionState
              status={requirementStatus("identity_evidence")}
              complete="Identity evidence verified"
              awaiting="Identity evidence uploaded — awaiting verification"
              action="Identity evidence required"
              detail={
                evidenceSettled("identity")
                  ? "One identity document is all that is required. A reviewer will check it."
                  : requirementMessage("identity_evidence") ||
                    "Upload one identity document, for example a passport or driving licence."
              }
            />
            <EvidencePicker
              label="Choose identity evidence"
              uploadLabel={evidenceSettled("identity") ? "Add another identity document" : undefined}
              variant={evidenceSettled("identity") ? "secondary" : "primary"}
              category="identity"
              successMessage="Identity evidence uploaded. It is awaiting reviewer verification."
              disabled={!canUploadEvidence("identity") || busy}
              onUpload={(asset) =>
                uploadAct(
                  () => uploadEvidence("identity", asset).then(() => setReplacingIdentity(false)),
                )
              }
            />
          </SectionSummary>
        ) : null}
        {step === "addresses" ? (
          <SectionSummary
            status={requirementStatus("address_history")}
            title="Address history"
            rows={[]}
            note={`Your current address and the required ${data.screeningPeriodYears || 5}-year period are covered.`}
            editLabel="Edit history"
            editing={editingAddresses}
            onEdit={() => setEditingAddresses(true)}
            summaryBody={
              <View style={s.list}>
                {[...(data.addresses || [])]
                  .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
                  .map((a) => (
                    <View key={a.id} style={s.item}>
                      <Text style={s.itemTitle}>{a.isCurrent ? "Current address" : "Previous address"}</Text>
                      <Text>{[a.addressLine1 || a.address, a.townCity, a.postcode].filter(Boolean).join(", ")}</Text>
                      <Text style={s.meta}>{dateLabel(a.startDate)} – {a.isCurrent ? "Present" : dateLabel(a.endDate)}</Text>
                    </View>
                  ))}
                {/* Evidence sits with the chronology it proves, not in a separate block. */}
                {evidenceSummaryRows("address").length ? (
                  <View style={s.item}>
                    <Text style={s.itemTitle}>Address evidence</Text>
                    <Text style={s.meta}>
                      {latestEvidence("address")?.originalFileName || "Document uploaded"} ·{" "}
                      {verificationLabel(latestEvidence("address")?.verificationState)}
                    </Text>
                  </View>
                ) : null}
              </View>
            }
          >
            <PeriodGuidance
              text={`Please provide your complete address history for the last ${data.screeningPeriodYears || 5} years. There must be no unexplained gaps between addresses.`}
              start={data.requirements?.addressChronology?.periodStart}
              end={data.requirements?.addressChronology?.periodEnd}
            />
            {requirementStatus("address_history") === "COMPLETE" ? (
              <View style={s.completeBanner}>
                <Text style={s.completeTitle}>✓ Address history complete</Text>
                <Text style={s.note}>
                  Your current address and the required {data.screeningPeriodYears || 5}-year period
                  are covered. You do not need to add your current address again — edit an entry
                  below only if something has changed.
                </Text>
              </View>
            ) : null}
            <View style={s.list}>
              {[...(data.addresses || [])]
                .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))
                .map((a) => (
                  <View key={a.id} style={s.item}>
                    <Text style={s.itemTitle}>
                      {a.isCurrent ? "Current address" : "Previous address"}
                    </Text>
                    {a.addressLine1 ? (
                      <>
                        <Text>{a.addressLine1}</Text>
                        {a.addressLine2 ? <Text>{a.addressLine2}</Text> : null}
                        <Text>{a.townCity}</Text>
                        <Text style={s.itemTitle}>{a.postcode}</Text>
                      </>
                    ) : <Text>{a.address}</Text>}
                    <Text style={s.meta}>
                      {dateLabel(a.startDate)} – {dateLabel(a.endDate)}
                    </Text>
                    <Text style={s.meta}>Verification: {verificationLabel(a.verificationState)}</Text>
                    {canCorrectRecords ? <View style={s.inlineActions}>
                      <Pressable accessibilityRole="button" style={s.smallButton} onPress={() => { setEditingAddressId(a.id); setAddress({addressLine1:a.addressLine1||a.address||"",addressLine2:a.addressLine2||"",townCity:a.townCity||"",postcode:a.postcode||"",startDate:dateLabel(a.startDate),endDate:a.endDate?dateLabel(a.endDate):"",isCurrent:a.isCurrent}); setShowAddressForm(true); }}><Text style={s.smallButtonText}>Edit</Text></Pressable>
                      <Pressable accessibilityRole="button" style={s.deleteButton} onPress={async () => {if(await confirmDelete('address'))await act(() => deleteMyScreeningAddress(a.id),"Address deleted. The authoritative coverage check has been refreshed.",() => { if(editingAddressId===a.id){setEditingAddressId(null);setShowAddressForm(false);setAddress(emptyAddressForm());} });}}><Text style={s.deleteButtonText}>Delete</Text></Pressable>
                    </View> : null}
                  </View>
                ))}
            </View>
            {data.requirements?.addressChronology?.gaps.map((g) => (
              <Gap
                key={`${g.from}-${g.to}`}
                title="ADDRESS HISTORY INCOMPLETE — MISSING PERIOD"
                from={g.from}
                to={g.to}
                message="Add the address where you lived during this exact period before submitting."
              />
            ))}
            {data.requirements?.addressChronology?.overlaps.map((o) => (
              <Overlap
                key={`${o.from}-${o.to}`}
                from={o.from}
                to={o.to}
                message="Check whether these address periods should overlap."
              />
            ))}
            <Action
              disabled={!canCorrectRecords || busy}
              variant={requirementStatus("address_history") === "COMPLETE" ? "secondary" : "primary"}
              label={requirementStatus("address_history") === "COMPLETE" ? "Add another address" : "+ Add another address"}
              onPress={() => { setEditingAddressId(null); setAddress(emptyAddressForm()); setShowAddressForm(true); }}
            />
            {showAddressForm ? <View style={s.entryForm}>
              <Text style={s.formMode}>{editingAddressId ? "EDIT ADDRESS" : "ADD ADDRESS"}</Text>
              <Field label="Address line 1 *" value={address.addressLine1} set={(v) => setAddress({ ...address, addressLine1: v })} />
              <Field label="Address line 2 (optional)" value={address.addressLine2} set={(v) => setAddress({ ...address, addressLine2: v })} />
              <Field label="Town / City *" value={address.townCity} set={(v) => setAddress({ ...address, townCity: v })} />
              <Field label="Postcode *" value={address.postcode} set={(v) => setAddress({ ...address, postcode: v.toUpperCase() })} />
              <Field label="Start date (DD/MM/YYYY) *" value={address.startDate} set={(v) => setAddress({ ...address, startDate: v })} />
              {!address.isCurrent ? <Field label="End date (DD/MM/YYYY) *" value={address.endDate} set={(v) => setAddress({ ...address, endDate: v })} /> : null}
              <Pressable accessibilityRole="checkbox" accessibilityState={{checked:address.isCurrent}} style={s.checkboxRow} onPress={() => setAddress({...address,isCurrent:!address.isCurrent,endDate:""})}>
                <Text style={s.checkbox}>{address.isCurrent ? "☑" : "☐"}</Text><Text>I currently live at this address</Text>
              </Pressable>
              <Action disabled={!canCorrectRecords || busy} label={editingAddressId?"Save address changes":"Save address"} onPress={() => act(() => {const payload={addressLine1:address.addressLine1,addressLine2:address.addressLine2||undefined,townCity:address.townCity,postcode:normalizeScreeningPostcode(address.postcode),startDate:screeningDateToIso(address.startDate),isCurrent:address.isCurrent,endDate:address.isCurrent?undefined:screeningDateToIso(address.endDate)};return editingAddressId?updateMyScreeningAddress(editingAddressId,payload):addMyScreeningAddress(payload);}, "Address history updated. The authoritative coverage check has been refreshed.", () => { setEditingAddressId(null); setAddress(emptyAddressForm()); setShowAddressForm(false); })} />
              <Action disabled={busy} label="Cancel" onPress={() => { setEditingAddressId(null); setAddress(emptyAddressForm()); setShowAddressForm(false); }} />
            </View> : null}
            <EvidencePicker
              label="Choose address evidence"
              category="address"
              successMessage="Address evidence uploaded. It is awaiting reviewer verification."
              disabled={!canUploadEvidence("address") || busy}
              onUpload={(asset) =>
                uploadAct(
                  () => uploadEvidence("address", asset),
                )
              }
            />
            <Text style={s.safety}>
              Only an authorised reviewer can verify an address. Incomplete
              five-year coverage blocks submission.
            </Text>
            {editingAddresses ? (
              <Action disabled={busy} variant="secondary" label="Done editing" onPress={() => setEditingAddresses(false)} />
            ) : null}
          </SectionSummary>
        ) : null}
        {step === "history" ? (
          <SectionSummary
            status={requirementStatus("activity_history")}
            title="Activity history"
            rows={[]}
            note={`The required ${data.screeningPeriodYears || 5}-year period is covered with no unexplained gaps.`}
            editLabel="Edit history"
            editing={editingActivity}
            onEdit={() => setEditingActivity(true)}
            summaryBody={
              <View style={s.list}>
                {[...(data.history || [])]
                  .sort((a, b) => a.startDate.localeCompare(b.startDate))
                  .map((h) => (
                    <View key={h.id} style={s.item}>
                      <Text style={s.itemTitle}>{historyTypeLabel(h.type)}</Text>
                      {h.organisation ? <Text>{h.organisation}</Text> : null}
                      <Text style={s.meta}>{dateLabel(h.startDate)} – {h.isCurrent ? "Present" : dateLabel(h.endDate)}</Text>
                    </View>
                  ))}
              </View>
            }
          >
            <PeriodGuidance
              text={`Please account for your complete employment, education and activity history for the last ${data.screeningPeriodYears || 5} years. There must be no unexplained gaps.`}
              start={data.requirements?.chronology.periodStart}
              end={data.requirements?.chronology.periodEnd}
            />
            {requirementStatus("activity_history") === "COMPLETE" ? (
              <View style={s.completeBanner}>
                <Text style={s.completeTitle}>✓ Activity history complete</Text>
                <Text style={s.note}>
                  The required {data.screeningPeriodYears || 5}-year period is covered with no
                  unexplained gaps. Add or edit an entry below only if something has changed.
                </Text>
              </View>
            ) : null}
            <View style={s.timeline}>
              {(data.history || []).map((h) => (
                <View key={h.id} style={s.timelineItem}>
                  <View style={s.dot} />
                  <View style={s.flex}>
                    <Text style={s.itemTitle}>{historyTypeLabel(h.type)}</Text>
                    <Text>{h.organisation || "Explanation provided"}</Text>
                    <Text style={s.meta}>
                      {dateLabel(h.startDate)} – {dateLabel(h.endDate)}
                    </Text>
                    {canCorrectRecords ? <View style={s.inlineActions}>
                      <Pressable accessibilityRole="button" style={s.smallButton} onPress={() => {setEditingHistoryId(h.id);setHistory({type:h.type,startDate:dateLabel(h.startDate),endDate:h.endDate?dateLabel(h.endDate):"",organisation:h.organisation||"",description:h.description||"",isCurrent:!!h.isCurrent});setShowHistoryForm(true);}}><Text style={s.smallButtonText}>Edit</Text></Pressable>
                      <Pressable accessibilityRole="button" style={s.deleteButton} onPress={async () => {if(await confirmDelete('activity'))await act(() => deleteMyScreeningHistory(h.id),"Activity deleted. Authoritative gaps and overlaps have been refreshed.",() => {if(editingHistoryId===h.id){setEditingHistoryId(null);setShowHistoryForm(false);setHistory(emptyActivityForm());}});}}><Text style={s.deleteButtonText}>Delete</Text></Pressable>
                    </View> : null}
                  </View>
                </View>
              ))}
            </View>
            {data.requirements?.chronology.gaps.map((g) => (
              <Gap
                key={`${g.from}-${g.to}`}
                title="ACTIVITY HISTORY INCOMPLETE — MISSING PERIOD"
                from={g.from}
                to={g.to}
                message="Add an activity or explained period covering these exact dates before submitting. Use Add activity below to cover this period."
              />
            ))}
            {data.requirements?.chronology.overlaps.map((o) => (
              <Overlap
                key={`${o.from}-${o.to}`}
                from={o.from}
                to={o.to}
                message="Check these activity entries and correct the dates if the overlap is not intentional."
              />
            ))}
            <Action disabled={!canCorrectRecords || busy} variant={requirementStatus("activity_history") === "COMPLETE" ? "secondary" : "primary"} label={requirementStatus("activity_history") === "COMPLETE" ? "Add activity" : "+ Add another activity"} onPress={() => { setEditingHistoryId(null); setHistory(emptyActivityForm()); setShowHistoryForm(true); }} />
            {showHistoryForm ? <View style={s.entryForm}>
            <Text style={s.formMode}>{editingHistoryId ? "EDIT ACTIVITY" : "ADD ACTIVITY"}</Text>
            <Text style={s.fieldLabel}>Activity type</Text>
            <View style={s.choiceGrid}>
              {HISTORY_TYPES.map(([value, label]) => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: history.type === value }}
                  key={value}
                  onPress={() => setHistory({ ...history, type: value })}
                  style={[s.choice, history.type === value && s.choiceActive]}
                >
                  <Text
                    style={
                      history.type === value ? s.choiceTextActive : s.choiceText
                    }
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {history.type ? <>
            <Field
              label={activityOrganisationLabel(history.type)}
              value={history.organisation}
              set={(v) => setHistory({ ...history, organisation: v })}
            />
            <Field
              label="Start date (DD/MM/YYYY)"
              value={history.startDate}
              set={(v) => setHistory({ ...history, startDate: v })}
            />
            {/*
              An explicit ongoing control, matching "I currently live at this address". Without it
              the only way to say "still happening" was to leave the end date blank, so a Guard who
              sensibly typed today's date had a record that went stale overnight and reopened a
              one-day gap every morning. Ticking this stores the open-ended representation the
              backend already has (isCurrent + null endDate) — no fabricated future dates.
            */}
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: history.isCurrent }}
              style={s.checkboxRow}
              onPress={() => setHistory({ ...history, isCurrent: !history.isCurrent, endDate: "" })}
            >
              <Text style={s.checkbox}>{history.isCurrent ? "☑" : "☐"}</Text>
              <Text>I am still doing this</Text>
            </Pressable>
            {!history.isCurrent ? (
              <Field
                label="End date (DD/MM/YYYY)"
                value={history.endDate}
                set={(v) => setHistory({ ...history, endDate: v })}
              />
            ) : null}
            <Field
              label="Details"
              value={history.description}
              set={(v) => setHistory({ ...history, description: v })}
            />
            <Action
              disabled={!canCorrectRecords || busy}
              label={editingHistoryId?"Save activity changes":"Save activity"}
              onPress={() =>
                act(
                  () => {
                    const payload = {
                      ...history,
                      startDate: screeningDateToIso(history.startDate),
                      isCurrent: history.isCurrent,
                      endDate: history.isCurrent ? undefined : screeningDateToIso(history.endDate),
                    };
                    return editingHistoryId ? updateMyScreeningHistory(editingHistoryId,payload) : addMyScreeningHistory(payload);
                  },
                  "Activity history updated. Authoritative gaps and overlaps have been refreshed.",
                  () => { setEditingHistoryId(null); setHistory(emptyActivityForm()); setShowHistoryForm(false); },
                )
              }
            />
            <Action disabled={busy} label="Cancel" onPress={() => { setEditingHistoryId(null); setHistory(emptyActivityForm()); setShowHistoryForm(false); }} />
            </> : <Text style={s.meta}>Choose the activity type to continue.</Text>}
            </View> : null}
            {editingActivity ? (
              <Action disabled={busy} variant="secondary" label="Done editing" onPress={() => setEditingActivity(false)} />
            ) : null}
          </SectionSummary>
        ) : null}
        {step === "references" ? (
          <SectionSummary
            status={requirementStatus("reference")}
            title="References"
            rows={[]}
            note="At least one reference is required. It does not have to cover every activity period."
            editLabel="Edit references"
            editing={editingReferences}
            onEdit={() => setEditingReferences(true)}
            summaryBody={
              <View style={s.list}>
                {(data.references || []).map((r) => (
                  <View key={r.id} style={s.item}>
                    <Text style={s.itemTitle}>{r.contactPerson || "Referee"}</Text>
                    <Text>{r.organisation}{r.relationship ? ` · ${r.relationship}` : ""}</Text>
                    <Text style={s.meta}>
                      Covers: {historyTypeLabel(r.history?.type)}
                      {r.history?.startDate ? ` · ${dateLabel(r.history.startDate)} – ${r.history?.isCurrent ? "Present" : dateLabel(r.history?.endDate)}` : ""}
                    </Text>
                    <Text style={s.meta}>Status: {pretty(r.status)}</Text>
                  </View>
                ))}
              </View>
            }
          >
            <Text style={s.note}>Provide someone or an organisation that can confirm a period of your activity history. S4 or an authorised reviewer may contact them. Adding contact details does not verify the reference.</Text>
            <View style={s.list}>
              {(data.references || []).map((r) => (
                <View key={r.id} style={s.item}>
                  <Text style={s.itemTitle}>{r.organisation}</Text>
                  <Text style={s.meta}>
                    {referenceLabel(r.status)} · Source{" "}
                    {r.sourceVerified
                      ? "authenticated"
                      : "not yet authenticated"}
                  </Text>
                </View>
              ))}
            </View>
            {!data.history?.length ? (
              <>
                <View style={s.warning}>
                  <Text style={s.warningTitle}>Add your activity history before adding a referee</Text>
                  <Text style={s.note}>Each referee must be linked to an activity period in your history. Complete your activity history first, then return here to add referees.</Text>
                  <Pressable
                    accessibilityRole="button"
                    style={s.smallButton}
                    onPress={() => navigateToStep("history")}
                  >
                    <Text style={s.smallButtonText}>Go to Activity History</Text>
                  </Pressable>
                </View>
              </>
            ) : !canEdit ? (
              <View style={s.info}>
                <Text style={s.infoTitle}>REFEREE DETAILS LOCKED</Text>
                <Text style={s.note}>Your screening is {STATUS[data.status]}. Referee contact details cannot be added or changed in this state.{"\n"}If corrections are required, an authorised reviewer will request them.</Text>
              </View>
            ) : (
              <>
                <Text style={s.fieldLabel}>Which activity period can this referee confirm? *</Text>
                <View style={s.choiceGrid}>
                  {data.history.map((h) => {
                    const selected = reference.historyId === String(h.id);
                    return (
                      <Pressable
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        key={h.id}
                        onPress={() =>
                          setReference({ ...reference, historyId: String(h.id) })
                        }
                        style={[s.choice, selected && s.choiceActive]}
                      >
                        <Text
                          style={selected ? s.choiceTextActive : s.choiceText}
                        >
                          {historyTypeLabel(h.type)} ·{" "}
                          {h.organisation || "Explained period"} ·{" "}
                          {dateLabel(h.startDate)}–{dateLabel(h.endDate)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Field
                  label="Organisation *"
                  value={reference.organisation}
                  set={(v) => setReference({ ...reference, organisation: v })}
                />
                <Field
                  label="Referee name *"
                  value={reference.contactPerson}
                  set={(v) => setReference({ ...reference, contactPerson: v })}
                />
                <Field
                  label="Relationship *"
                  value={reference.relationship}
                  set={(v) => setReference({ ...reference, relationship: v })}
                />
                <Field
                  label="Business email *"
                  value={reference.businessEmail}
                  set={(v) => setReference({ ...reference, businessEmail: v })}
                />
                <Field
                  label="Phone (optional)"
                  value={reference.phone}
                  set={(v) => setReference({ ...reference, phone: v })}
                />
                <Text style={s.meta}>* Required field</Text>
                {refErrors.length > 0 ? (
                  <View style={s.warning} accessibilityRole="alert">
                    {refErrors.map((e, i) => (
                      <Text key={i} style={s.warningTitle}>{e}</Text>
                    ))}
                  </View>
                ) : null}
                <Action
                  disabled={busy}
                  label="Add referee"
                  onPress={() => {
                    const errs: string[] = [];
                    if (!reference.historyId) errs.push("Select the activity period this referee can confirm.");
                    if (!reference.organisation.trim()) errs.push("Organisation is required.");
                    if (!reference.contactPerson.trim()) errs.push("Referee name is required.");
                    if (!reference.relationship.trim()) errs.push("Relationship is required.");
                    const email = reference.businessEmail.trim();
                    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.push("A valid business email is required.");
                    if (errs.length) { setRefErrors(errs); return; }
                    setRefErrors([]);
                    act(
                      () =>
                        addMyScreeningReference({
                          historyId: Number(reference.historyId),
                          organisation: reference.organisation.trim(),
                          contactPerson: reference.contactPerson.trim(),
                          relationship: reference.relationship.trim(),
                          businessEmail: reference.businessEmail.trim(),
                          phone: reference.phone.trim() || undefined,
                        }),
                      "Your referee details have been submitted. An authorised reviewer will verify the reference. You do not need to wait on this page.",
                      () => { setReference(emptyReferenceForm()); setRefErrors([]); },
                    );
                  }}
                />
              </>
            )}
            <EvidencePicker
              label="Choose optional reference supporting document"
              uploadLabel="Upload supporting document"
              category="reference"
              successMessage="Supporting document uploaded privately. It may assist the reviewer but does not verify the reference."
              disabled={!canUploadEvidence("reference") || busy}
              onUpload={(asset) =>
                uploadAct(
                  () => uploadEvidence("reference", asset),
                )
              }
            />
            <Text style={s.safety}>
              The selector contains only activity records returned for your
              screening file. The backend ownership check remains authoritative.
            </Text>
            {editingReferences ? (
              <Action disabled={busy} variant="secondary" label="Done editing" onPress={() => setEditingReferences(false)} />
            ) : null}
          </SectionSummary>
        ) : null}
        {step === "checks" ? (
          <SectionSummary
            status={sectionStatus("checks")}
            title="SIA & Right to Work"
            rows={[
              ["SIA licence", guard?.siaLicenseNumber || guard?.siaLicenceNumber],
              ["SIA expiry", guard?.siaExpiryDate ? dateLabel(guard.siaExpiryDate) : null],
              ["SIA document", latestEvidence("sia")?.originalFileName || (evidenceSettled("sia") ? "Uploaded" : null)],
              ["SIA check", verificationLabel(data.siaRegisterVerification)],
              ["Right to Work", guard?.rightToWorkStatus],
              ["Right to Work expiry", guard?.rightToWorkExpiryDate ? dateLabel(guard.rightToWorkExpiryDate) : null],
              ["Right to Work document", latestEvidence("right_to_work")?.originalFileName || (evidenceSettled("right_to_work") ? "Uploaded" : null)],
              ["Right to Work check", verificationLabel(data.rightToWorkVerification)],
            ]}
            editLabel="Edit details"
            editing={editingChecks}
            onEdit={() => setEditingChecks(true)}
          >
            <Text style={s.sectionHeading}>Candidate compliance information</Text>
            <Text style={s.note}>This is the authoritative place to maintain your SIA and Right to Work information. Uploading evidence does not verify it.</Text>
            <Field label="SIA licence number (16 digits)" value={compliance.siaLicenseNumber} set={(v) => setCompliance({...compliance,siaLicenseNumber:v})} />
            <Field label="SIA licence expiry date (DD/MM/YYYY)" value={compliance.siaExpiryDate} set={(v) => setCompliance({...compliance,siaExpiryDate:v})} />
            <Field label="Right to Work status / type" value={compliance.rightToWorkStatus} set={(v) => setCompliance({...compliance,rightToWorkStatus:v})} />
            <Field label="Right to Work expiry date (DD/MM/YYYY, if applicable)" value={compliance.rightToWorkExpiryDate} set={(v) => setCompliance({...compliance,rightToWorkExpiryDate:v})} />
            <Action disabled={!canCorrectCompliance||busy} label="Save SIA & Right to Work information" onPress={() => act(() => updateMyScreeningCompliance({siaLicenseNumber:compliance.siaLicenseNumber.trim()||undefined,siaExpiryDate:compliance.siaExpiryDate?screeningDateToIso(compliance.siaExpiryDate):null,rightToWorkStatus:compliance.rightToWorkStatus.trim()||null,rightToWorkExpiryDate:compliance.rightToWorkExpiryDate?screeningDateToIso(compliance.rightToWorkExpiryDate):null}),"Compliance information saved. Authoritative remediation has been refreshed.")} />
            <StatusCards
              items={[
                ["SIA licence number",guard?.siaLicenseNumber||guard?.siaLicenceNumber?"Provided":"Not provided"],
                ["SIA licence expiry",guard?.siaExpiryDate?dateLabel(guard.siaExpiryDate):"Not provided"],
                ["SIA evidence", evidenceState(data, "sia")],
                [
                  "SIA register verification",
                  verificationLabel(data.siaRegisterVerification),
                ],
                [
                  "Right to Work information",
                  guard?.rightToWorkStatus||"Not provided",
                ],
                [
                  "Right to Work evidence",
                  evidenceState(data, "right_to_work"),
                ],
                [
                  "Right to Work verification",
                  verificationLabel(data.rightToWorkVerification),
                ],
              ]}
            />
            <Text style={s.sectionHeading}>SIA licence</Text>
            <SectionState
              status={requirementStatus("sia_expiry")}
              complete="SIA licence expiry date supplied"
              awaiting="SIA licence expiry date supplied"
              action="SIA licence expiry date required"
              detail={requirementMessage("sia_expiry")}
            />
            <SectionState
              status={requirementStatus("sia_evidence")}
              complete="SIA evidence verified"
              awaiting="SIA evidence uploaded — awaiting verification"
              action="SIA evidence required"
              detail={
                evidenceSettled("sia")
                  ? "One SIA document is all that is required. A reviewer will check the register."
                  : requirementMessage("sia_evidence") || "Upload a copy of your SIA licence."
              }
            />
            <EvidencePicker
              label="Choose SIA evidence"
              uploadLabel={evidenceSettled("sia") ? "Add another SIA document" : undefined}
              variant={evidenceSettled("sia") ? "secondary" : "primary"}
              category="sia"
              successMessage="SIA evidence uploaded. It is awaiting register verification."
              disabled={!canUploadEvidence("sia") || busy}
              onUpload={(asset) =>
                uploadAct(
                  () => uploadEvidence("sia", asset),
                )
              }
            />
            <Text style={s.sectionHeading}>Right to Work</Text>
            <SectionState
              status={requirementStatus("rtw_status")}
              complete="Right to Work information supplied"
              awaiting="Right to Work information supplied"
              action="Right to Work information required"
              detail={requirementMessage("rtw_status")}
            />
            <SectionState
              status={requirementStatus("right_to_work_evidence")}
              complete="Right to Work evidence verified"
              awaiting="Right to Work evidence uploaded — awaiting verification"
              action="Right to Work evidence required"
              detail={
                evidenceSettled("right_to_work")
                  ? "One Right to Work document is all that is required. A reviewer will check it."
                  : requirementMessage("right_to_work_evidence") ||
                    "Upload one document showing your right to work in the UK."
              }
            />
            <EvidencePicker
              label="Choose Right-to-Work evidence"
              uploadLabel={evidenceSettled("right_to_work") ? "Add another Right to Work document" : undefined}
              variant={evidenceSettled("right_to_work") ? "secondary" : "primary"}
              category="right_to_work"
              successMessage="Right-to-Work evidence uploaded. It is awaiting reviewer verification."
              disabled={!canUploadEvidence("right_to_work") || busy}
              onUpload={(asset) =>
                uploadAct(
                  () => uploadEvidence("right_to_work", asset),
                )
              }
            />
            {editingChecks ? (
              <Action disabled={busy} variant="secondary" label="Done editing" onPress={() => setEditingChecks(false)} />
            ) : null}
          </SectionSummary>
        ) : null}
        {step === "evidence" ? (
          <>
            {!(data.evidence || []).length ? (
              <Text style={s.note}>No additional evidence has been requested.</Text>
            ) : null}
            <View style={s.list}>
              {(data.evidence || []).map((e) => (
                <View key={e.id} style={s.item}>
                  <Text style={s.itemTitle}>{pretty(e.category)}</Text>
                  <Text style={s.meta}>
                    {documentStatus(e)} · {Math.ceil(e.sizeBytes / 1024)} KB
                  </Text>
                </View>
              ))}
            </View>
            <View style={s.awaitingBanner}>
              <Text style={s.awaitingTitle}>Optional supporting evidence</Text>
              <Text style={s.note}>
                Nothing here is required to submit your screening. The documents listed above are
                the ones your screening asked for. Add anything extra only if you have been asked
                for it.
              </Text>
            </View>
            <EvidencePicker
              label="Choose additional supporting evidence"
              uploadLabel="Add optional document"
              variant="secondary"
              category="other"
              successMessage="Supporting evidence uploaded. It is awaiting reviewer verification."
              disabled={!canEdit || busy}
              onUpload={(asset) =>
                uploadAct(
                  () => uploadEvidence("other", asset),
                )
              }
            />
            <Text style={s.safety}>
              Files remain private. Upload never means verified. Storage keys
              and permanent URLs are never displayed.
            </Text>
          </>
        ) : null}
        {step === "consent" ? (
          <>
            <Text style={s.declaration}>
              By accepting, you consent to S4 processing the screening
              information you provide and contacting supplied referees.
              Submission sends your information to an authorised Platform Admin
              for review.
            </Text>
            {(() => {
              const current = (data.consents || []).filter((x) => !x.withdrawnAt).slice(-1)[0];
              if (current)
                return (
                  <>
                    <View style={s.completeBanner}>
                      <Text style={s.completeTitle}>✓ Accepted</Text>
                      <Text style={s.note}>
                        You accepted this declaration
                        {current.acceptedAt ? ` on ${dateLabel(String(current.acceptedAt).slice(0, 10))}` : ""}
                        {current.consentVersion ? ` · Version ${current.consentVersion}` : ""}.
                        You do not need to accept it again.
                      </Text>
                    </View>
                    <Pressable
                      disabled={busy}
                      style={s.secondary}
                      onPress={() =>
                        act(
                          () => withdrawMyScreeningConsent(),
                          "Consent withdrawn. Your screening may require attention.",
                        )
                      }
                    >
                      <Text style={s.secondaryText}>Withdraw consent</Text>
                    </Pressable>
                  </>
                );
              return (
                <>
                  <Text style={s.meta}>Current consent: Not accepted or withdrawn</Text>
                  <Action
                    disabled={!canEdit || busy}
                    label="Accept consent & declaration"
                    onPress={() =>
                      act(
                        () => acceptMyScreeningConsent(),
                        "Consent accepted and server timestamp recorded.",
                      )
                    }
                  />
                </>
              );
            })()}
          </>
        ) : null}
        {step === "review" ? (
          <>
            <Review data={data} onFix={(target) => navigateToRemediation(target as Step)} />
            {data.requirements?.missing.map((x) => (
              <Text key={x} style={s.missing}>
                • {x}
              </Text>
            ))}
            <Action
              disabled={!canEdit || busy || !!data.requirements?.missing.length}
              label="Submit for authorised review"
              onPress={() =>
                act(
                  () => submitMyScreening(),
                  "Screening submitted for review.",
                )
              }
            />
            <Text style={s.safety}>
              The frontend cannot set Vetted. Only the authoritative reviewer
              workflow can change the decision.
            </Text>
          </>
        ) : null}
        <View style={s.stageNav}>
          <Pressable
            disabled={activeIndex === 0}
            onPress={() => navigateToStep(STEPS[activeIndex - 1].key)}
          >
            <Text style={s.back}>Previous</Text>
          </Pressable>
          <Pressable
            disabled={activeIndex === STEPS.length - 1}
            onPress={() => navigateToStep(STEPS[activeIndex + 1].key)}
          >
            <Text style={s.back}>Next</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function Field({
  label,
  value,
  set,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
}) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={s.input}
        value={value}
        onChangeText={set}
      />
    </View>
  );
}
export function normalizeEvidenceMimeType(value: string | undefined, name: string) {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "application/pdf") return normalized;
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/png") return normalized;
  const extension = name.toLowerCase().split(".").pop();
  if (extension === "pdf") return "application/pdf";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  return null;
}
function EvidencePicker({
  label,
  uploadLabel,
  successMessage,
  category,
  onUpload,
  disabled,
  variant = "primary",
}: {
  label: string;
  uploadLabel?: string;
  successMessage?: string;
  category: string;
  onUpload: (asset: DocumentPicker.DocumentPickerAsset) => Promise<string | null>;
  disabled: boolean;
  /** "secondary" once the requirement is satisfied, so it stops competing as the next step. */
  variant?: "primary" | "secondary";
}) {
  const [asset, setAsset] = React.useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError,setUploadError]=React.useState("");
  const [uploadSuccess,setUploadSuccess]=React.useState("");
  const send = async (chosen: DocumentPicker.DocumentPickerAsset) => {
    setUploading(true);
    setUploadError("");
    setUploadSuccess("");
    try {
      const uploadResult = await onUpload(chosen);
      if (uploadResult === null) {
        setAsset(null);
        setUploadSuccess(successMessage ?? "Document uploaded successfully.");
      } else {
        setAsset(chosen);
        setUploadError(uploadResult);
      }
    } finally {
      setUploading(false);
    }
  };
  const choose = async () => {
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({
        type: ["application/pdf", "image/jpeg", "image/png"],
        copyToCacheDirectory: true,
        multiple: false,
      });
    } catch {
      // The picker is a separate activity and can fail outright on some devices.
      setUploadError("The document picker could not be opened. Please try again.");
      return;
    }
    if (result.canceled) return;
    const chosen = result.assets?.[0];
    if (!chosen) {
      setUploadError("No document was returned by the picker. Please try again.");
      return;
    }
    setUploadError("");
    setUploadSuccess("");
    // Upload straight away. Choosing a document sends the app to the background, and anything held
    // only in this component's state is gone by the time the picker returns, so a separate
    // "Upload" tap can never be reached on Android.
    await send(chosen);
  };
  const upload = async () => {
    if (!asset) return;
    await send(asset);
  };
  return (
    <View style={s.picker}>
      <Text style={s.fieldLabel}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={uploadLabel||label}
        disabled={disabled || uploading}
        style={[variant === "secondary" ? s.secondary : s.button, (disabled || uploading) && s.disabled]}
        onPress={choose}
      >
        <Text style={variant === "secondary" ? s.secondaryText : s.buttonText}>
          {uploading ? "Uploading…" : uploadLabel||"Choose document"}
        </Text>
      </Pressable>
      {asset ? (
        <Text style={s.itemTitle}>{asset.name}</Text>
      ) : (
        <Text style={s.meta}>Choosing a document uploads it straight away.</Text>
      )}
      {asset && !uploading ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Retry upload of ${pretty(category)} document`}
          disabled={disabled}
          style={[s.secondary, disabled && s.disabled]}
          onPress={upload}
        >
          <Text style={s.secondaryText}>Retry upload</Text>
        </Pressable>
      ) : null}
      {uploadSuccess?<Text accessibilityRole="alert" style={s.pickerSuccess}>{uploadSuccess}</Text>:null}
      {uploadError?<Text style={s.meta}>The selected document has been kept so you can retry.</Text>:null}
      {uploadError?<Text accessibilityRole="alert" style={s.error}>{uploadError}</Text>:null}
      <Text style={s.meta}>Private upload category: {pretty(category)}</Text>
    </View>
  );
}
/**
 * The completed-state contract for every screening section.
 *
 * A satisfied requirement must stop looking like an unfinished form: the summary IS the section,
 * and the form only appears when the Guard explicitly asks to edit (or when the backend says
 * something is genuinely missing). `status` comes from requirements.remediation — there is no
 * second completion model on the client.
 */
function SectionSummary({
  status,
  title,
  rows,
  note,
  editLabel = "Edit",
  onEdit,
  editing,
  children,
  extraAction,
  summaryBody,
}: {
  status: "ACTION_REQUIRED" | "AWAITING_VERIFICATION" | "COMPLETE" | "VERIFIED" | null;
  title: string;
  /** Compact read-only facts. Falsy values are dropped so empty rows never render. */
  rows: Array<[string, string | null | undefined]>;
  note?: string;
  editLabel?: string;
  onEdit?: () => void;
  /** When true the caller's form (children) is shown instead of the summary. */
  editing?: boolean;
  children?: PropsWithChildren<unknown>["children"];
  extraAction?: PropsWithChildren<unknown>["children"];
  /** For sections whose summary is a timeline/list rather than label-value rows. */
  summaryBody?: PropsWithChildren<unknown>["children"];
}) {
  const settled = status === "COMPLETE" || status === "VERIFIED" || status === "AWAITING_VERIFICATION";
  // Not satisfied, or the Guard chose to edit: the form is the section.
  if (!settled || editing) return <>{children}</>;

  const headline =
    status === "VERIFIED" ? `✓ ${title} — verified`
      : status === "COMPLETE" ? `✓ ${title}`
        : `✓ ${title} — awaiting verification`;

  return (
    <View style={status === "AWAITING_VERIFICATION" ? s.awaitingBanner : s.completeBanner}>
      <Text style={status === "AWAITING_VERIFICATION" ? s.awaitingTitle : s.completeTitle}>{headline}</Text>
      {summaryBody}
      {rows.filter(([, value]) => !!value).map(([label, value]) => (
        <Text key={label} style={s.summaryLine}>
          <Text style={s.summaryLabel}>{label}: </Text>
          {value}
        </Text>
      ))}
      {note ? <Text style={s.note}>{note}</Text> : null}
      {onEdit ? (
        <Pressable accessibilityRole="button" style={s.secondary} onPress={onEdit}>
          <Text style={s.secondaryText}>{editLabel}</Text>
        </Pressable>
      ) : null}
      {extraAction}
    </View>
  );
}

/**
 * One presentation for every section state, so a satisfied requirement always reads as
 * information rather than as another job to do. COMPLETE/VERIFIED are green, AWAITING_VERIFICATION
 * is a neutral "with the reviewer" note, ACTION_REQUIRED stays the amber prompt.
 */
function SectionState({
  status,
  complete,
  awaiting,
  action,
  detail,
}: {
  status: "ACTION_REQUIRED" | "AWAITING_VERIFICATION" | "COMPLETE" | "VERIFIED" | null;
  complete: string;
  awaiting: string;
  action?: string;
  detail?: string;
}) {
  if (!status) return null;
  if (status === "COMPLETE" || status === "VERIFIED")
    return (
      <View style={s.completeBanner}>
        <Text style={s.completeTitle}>✓ {status === "VERIFIED" ? `${complete} — verified` : complete}</Text>
        {detail ? <Text style={s.note}>{detail}</Text> : null}
      </View>
    );
  if (status === "AWAITING_VERIFICATION")
    return (
      <View style={s.awaitingBanner}>
        <Text style={s.awaitingTitle}>✓ {awaiting}</Text>
        <Text style={s.note}>
          {detail || "A reviewer will check this. You do not need to do anything else here."}
        </Text>
      </View>
    );
  return (
    <View style={s.actionBanner}>
      <Text style={s.actionTitle}>! {action || "Action required"}</Text>
      {detail ? <Text style={s.note}>{detail}</Text> : null}
    </View>
  );
}
function PeriodGuidance({text,start,end}:{text:string;start?:string;end?:string}) {
  return <View style={s.guidance}><Text style={s.guidanceText}>{text}</Text><Text style={s.requiredPeriod}>Required period: {start&&end?`${dateLabel(start)} – ${dateLabel(end)}`:"Loading authoritative screening period…"}</Text></View>;
}
function Gap({
  title,
  from,
  to,
  message,
}: {
  key?: string;
  title: string;
  from: string;
  to: string;
  message: string;
}) {
  return (
    <View style={s.warning}>
      <Text style={s.warningTitle}>{title}</Text>
      <Text>
        {dateLabel(from)} – {dateLabel(to)}
      </Text>
      <Text style={s.meta}>{message}</Text>
    </View>
  );
}
function Overlap({
  from,
  to,
  message,
}: {
  key?: string;
  from: string;
  to: string;
  message: string;
}) {
  return (
    <View style={s.info}>
      <Text style={s.infoTitle}>OVERLAPPING PERIOD</Text>
      <Text>
        {dateLabel(from)} – {dateLabel(to)}
      </Text>
      <Text style={s.meta}>{message}</Text>
    </View>
  );
}
function Action({
  label,
  onPress,
  disabled,
  variant = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  /** "secondary" for actions that are optional once the requirement is already satisfied. */
  variant?: "primary" | "secondary";
}) {
  if (variant === "secondary")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        style={[s.secondary, disabled && s.disabled]}
        onPress={onPress}
      >
        <Text style={s.secondaryText}>{label}</Text>
      </Pressable>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      style={[s.button, disabled && s.disabled]}
      onPress={onPress}
    >
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}
function StatusCards({ items }: { items: Array<[string, string]> }) {
  return (
    <View style={s.statusGrid}>
      {items.map(([a, b]) => (
        <View key={a} style={s.statusCard}>
          <Text style={s.label}>{a}</Text>
          <Text style={s.itemTitle}>{b}</Text>
        </View>
      ))}
    </View>
  );
}
function verificationLabel(value?: string) {
  return (
    (
      {
        UNVERIFIED: "Candidate supplied — verification not started",
        PENDING: "Awaiting verification",
        VERIFIED: "Verified",
        REJECTED: "Requires attention",
        EXPIRED: "Expired",
      } as Record<string, string>
    )[value || ""] || "Not supplied"
  );
}
function documentStatus(item: {
  uploadCompleted: boolean;
  verificationState: string;
}) {
  if (!item.uploadCompleted) return "Candidate supplied · Upload pending";
  return item.verificationState === "VERIFIED"
    ? "Uploaded · Verified"
    : item.verificationState === "REJECTED"
      ? "Uploaded · Requires attention"
      : item.verificationState === "EXPIRED"
        ? "Uploaded · Expired"
        : "Uploaded · Awaiting verification";
}
function evidenceState(data: GuardScreening, category: string) {
  const item = data.evidence?.find((x) => x.category === category);
  return item ? documentStatus(item) : "Not supplied";
}
function referenceLabel(value: string) {
  return (
    (
      {
        NOT_REQUESTED: "Not requested",
        REQUESTED: "Requested",
        RECEIVED: "Received",
        UNDER_VERIFICATION: "Under verification",
        VERIFIED: "Verified",
        REJECTED: "Rejected / Requires attention",
      } as Record<string, string>
    )[value] || pretty(value)
  );
}
function stageHelp(step: Step, years: number) {
  return {
    personal: "Provide the details used to identify your screening file.",
    identity:
      "Candidate-supplied information, uploaded evidence, and reviewer verification are shown separately.",
    addresses:
      "Add your current address and previous addresses as a clear chronology.",
    history: `Cover the configured ${years}-year screening period. The server detects authoritative gaps and overlaps.`,
    references:
      "Provide permitted referee details linked to an activity record. Only a reviewer can verify them.",
    checks:
      "SIA register and Right to Work checks are distinct reviewer-controlled decisions.",
    evidence:
      "Upload PDF, JPEG, or PNG evidence through the private signed-upload workflow.",
    consent:
      "Read and accept the current version before submitting. You can withdraw consent later.",
    review:
      "Review your progress and resolve every server-reported missing requirement before submission.",
  }[step];
}
function Review({ data,onFix }: { data: GuardScreening;onFix:(step:string)=>void }) {
  const rows=data.requirements?.remediation||[];
  return (
    <View style={s.review}>
      <View style={s.reviewHeader}><Text style={s.label}>Requirement</Text><Text style={s.label}>Status and candidate action</Text></View>
      {rows.map((item) => {
        // Plain-language status, ordered so the Guard reads the outcome before the detail.
        const mark =
          item.status === 'VERIFIED' ? '✓' :
          item.status === 'COMPLETE' ? '✓' :
          item.status === 'AWAITING_VERIFICATION' ? '⏳' : '!';
        const plain =
          item.status === 'VERIFIED' ? 'Verified' :
          item.status === 'COMPLETE' ? 'Complete' :
          item.status === 'AWAITING_VERIFICATION' ? 'Awaiting verification' : 'Action required';
        const tone =
          item.status === 'ACTION_REQUIRED' ? s.actionRequired :
          item.status === 'AWAITING_VERIFICATION' ? s.awaiting : s.accessGood;
        return (
          <View key={item.key} style={s.reviewRow}>
            <View style={s.flex}>
              <Text style={s.label}>{item.label}</Text>
              <Text style={tone}>{mark} {plain}</Text>
              {item.status === 'ACTION_REQUIRED' ? <Text style={s.note}>{item.message}</Text> : null}
            </View>
            {item.status==='ACTION_REQUIRED'?<Pressable accessibilityRole="button" style={s.fixButton} onPress={()=>onFix(item.step)}><Text style={s.fixButtonText}>Fix this</Text></Pressable>:null}
          </View>
        );
      })}
      {data.requirements?.addressChronology?.gaps.map((g) => (
        <Text key={`address-${g.from}`} style={s.missing}>
          Missing address dates: {dateLabel(g.from)} – {dateLabel(g.to)}
        </Text>
      ))}
      {data.requirements?.chronology.gaps.map((g) => (
        <Text key={`activity-${g.from}`} style={s.missing}>
          Missing activity dates: {dateLabel(g.from)} – {dateLabel(g.to)}
        </Text>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  journey: { gap: 16 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 18,
    gap: 12,
  },
  hero: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 20,
    gap: 12,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.2,
    color: colors.accentTealStrong,
  },
  heroTitle: { fontSize: 26, fontWeight: "800", color: colors.textPrimary },
  title: { fontSize: 21, fontWeight: "800", color: colors.textPrimary },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  flex: { flex: 1 },
  label: { color: colors.textSecondary, fontWeight: "700" },
  progress: { fontSize: 26, fontWeight: "900", color: colors.primaryNavy },
  track: {
    height: 9,
    borderRadius: 99,
    backgroundColor: colors.pendingSurface,
    overflow: "hidden",
  },
  trackFill: { height: "100%", backgroundColor: colors.accentTeal },
  note: { color: colors.textSecondary, lineHeight: 20 },
  guidance: { backgroundColor: colors.accentTealSoft, borderRadius: 10, padding: spacing.md, gap: spacing.sm - 1 },
  guidanceText: { color: colors.textPrimary, lineHeight: 21, fontWeight: "700" },
  requiredPeriod: { color: colors.primaryNavy, fontWeight: "900" },
  picker: { gap: 7, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12 },
  entryForm: { gap: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 14, backgroundColor: colors.background },
  checkboxRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 5 },
  checkbox: { fontSize: 21, color: colors.primaryNavy },
  choiceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: { borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9, backgroundColor: colors.card },
  choiceActive: { backgroundColor: colors.primaryNavy, borderColor: colors.primaryNavy },
  choiceText: { color: colors.textPrimary, fontWeight: "700" },
  choiceTextActive: { color: colors.textOnBrand, fontWeight: "800" },
  checkGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  done: { minWidth: 190, flexGrow: 1, color: colors.success },
  pending: { minWidth: 190, flexGrow: 1, color: colors.textSecondary },
  accessBox: {
    backgroundColor: colors.background,
    borderRadius: 10,
    padding: spacing.md,
    gap: spacing.xs + 1,
  },
  accessGood: { color: colors.success, fontWeight: "800" },
  accessWarn: { color: colors.warning, fontWeight: "800" },
  vettedMeta: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
    gap: 3,
  },
  button: {
    backgroundColor: colors.primaryNavy,
    borderRadius: 10,
    padding: 13,
    alignItems: "center",
  },
  buttonText: { color: colors.textOnBrand, fontWeight: "800" },
  disabled: { opacity: 0.45 },
  back: { color: colors.primaryNavy, fontWeight: "800", paddingVertical: 4 },
  stepNav: { gap: 8, paddingBottom: 2 },
  step: {
    width: 150,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 11,
    backgroundColor: colors.card,
  },
  stepActive: {
    backgroundColor: colors.primaryNavy,
    borderColor: colors.primaryNavy,
  },
  stepNumber: { fontWeight: "900", color: colors.accentTealStrong },
  stepText: { fontWeight: "700", color: colors.textPrimary, marginTop: 3 },
  stepTextActive: { color: colors.textOnBrand },
  // Completed steps are marked with a green tick on a quiet tinted card — green is the
  // operational success colour; teal stays reserved for brand/primary actions.
  completeBanner: {
    borderWidth: 1,
    borderColor: colors.successBorder,
    backgroundColor: colors.successSurface,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    marginBottom: 4,
    gap: 3,
  },
  completeTitle: { fontWeight: "900", color: colors.success },
  summaryLine: { color: colors.textPrimary, marginTop: 2 },
  summaryLabel: { fontWeight: "700", color: colors.textMuted },
  awaitingBanner: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    marginBottom: 4,
    gap: 3,
  },
  awaitingTitle: { fontWeight: "900", color: colors.textPrimary },
  actionBanner: {
    borderWidth: 1,
    borderColor: colors.warningBorder,
    backgroundColor: colors.warningSurface,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    marginBottom: 4,
    gap: 3,
  },
  actionTitle: { fontWeight: "900", color: colors.warning },
  stepDone: { borderColor: colors.successBorder, backgroundColor: colors.successSurface },
  stepNumberDone: { color: colors.success },
  stepPending: { fontSize: 11, fontWeight: "700", color: colors.textMuted, marginTop: 2 },
  stage: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 20,
    gap: 14,
  },
  stageTitle: { fontSize: 23, fontWeight: "800", color: colors.textPrimary },
  field: { gap: 6 },
  fieldLabel: { fontWeight: "700", color: colors.textPrimary },
  input: {
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: 9,
    padding: 11,
    color: colors.textPrimary,
    backgroundColor: colors.card,
  },
  list: { gap: 9 },
  item: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  itemTitle: { fontWeight: "800", color: colors.textPrimary },
  meta: { color: colors.textSecondary, lineHeight: 19 },
  timeline: {
    borderLeftWidth: 2,
    borderLeftColor: colors.accentTeal,
    marginLeft: 7,
    gap: 12,
  },
  timelineItem: { flexDirection: "row", gap: 10, marginLeft: -7 },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.accentTeal,
    marginTop: 4,
  },
  warning: {
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSurface,
    borderRadius: 10,
    padding: spacing.md,
    gap: spacing.xs,
  },
  warningTitle: { color: colors.warning, fontWeight: "900" },
  info: {
    borderWidth: 1,
    borderColor: colors.info,
    backgroundColor: colors.infoSurface,
    borderRadius: 10,
    padding: spacing.md,
    gap: spacing.xs,
  },
  infoTitle: { color: colors.info, fontWeight: "900" },
  safety: { color: colors.textSecondary, fontStyle: "italic", lineHeight: 20 },
  declaration: {
    backgroundColor: colors.background,
    padding: 14,
    borderRadius: 10,
    color: colors.textPrimary,
    lineHeight: 22,
  },
  secondary: {
    borderWidth: 1,
    borderColor: colors.primaryNavy,
    borderRadius: 10,
    padding: 12,
    alignItems: "center",
  },
  secondaryText: { color: colors.primaryNavy, fontWeight: "800" },
  statusGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statusCard: {
    minWidth: 220,
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 14,
    gap: 5,
  },
  review: { borderTopWidth: 1, borderTopColor: colors.border },
  reviewHeader: { flexDirection:"row",justifyContent:"space-between",gap:12,paddingVertical:10 },
  reviewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 11,
  },
  missing: { color: colors.warning, lineHeight: 20 },
  actionSummary:{backgroundColor:colors.card,borderWidth:1,borderColor:colors.border,borderRadius:radii.lg,padding:spacing.lg,gap:spacing.md},
  remediationRow:{flexDirection:"row",alignItems:"center",gap:spacing.md,borderTopWidth:1,borderTopColor:colors.border,paddingTop:spacing.md},
  actionRequired:{color:colors.warning,fontWeight:"900"},
  awaiting:{color:colors.info,fontWeight:"900"},
  fixButton:{backgroundColor:colors.primaryNavy,borderRadius:9,paddingHorizontal:spacing.md,paddingVertical:9},
  fixButtonText:{color:colors.textOnBrand,fontWeight:"800"},
  inlineActions:{flexDirection:"row",gap:spacing.sm,marginTop:spacing.sm,flexWrap:"wrap"},
  smallButton:{borderWidth:1,borderColor:colors.primaryNavy,borderRadius:spacing.sm,paddingHorizontal:spacing.md,paddingVertical:7},
  smallButtonText:{color:colors.primaryNavy,fontWeight:"800"},
  deleteButton:{borderWidth:1,borderColor:colors.danger,borderRadius:spacing.sm,paddingHorizontal:spacing.md,paddingVertical:7},
  deleteButtonText:{color:colors.danger,fontWeight:"800"},
  sectionHeading:{fontSize:17,fontWeight:"900",color:colors.textPrimary},
  formMode:{fontSize:13,fontWeight:"900",letterSpacing:1,color:colors.accentTealStrong},
  stageNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
  },
  success: {
    color: colors.success,
    backgroundColor: colors.successSurface,
    borderWidth: 1,
    borderColor: colors.successSurface,
    padding: spacing.md,
    borderRadius: 10,
  },
  error: { color: colors.danger },
  pickerSuccess: { color: colors.success, fontWeight: "700" },
  errorBox: {
    color: colors.danger,
    backgroundColor: colors.dangerSurface,
    borderWidth: 1,
    borderColor: colors.dangerSurface,
    padding: spacing.md,
    borderRadius: 10,
  },
});
