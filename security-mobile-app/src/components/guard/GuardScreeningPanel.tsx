import React from "react";
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
const HISTORY_TYPES = [
  ["EMPLOYMENT", "Employment"],
  ["SELF_EMPLOYMENT", "Self-employment"],
  ["EDUCATION", "Education"],
  ["UNEMPLOYMENT", "Unemployment"],
  ["CAREER_BREAK", "Career break"],
  ["OVERSEAS", "Overseas period"],
  ["OTHER_EXPLAINED_PERIOD", "Other explained period"],
] as const;
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
const emptyAddressForm = () => ({ addressLine1: "", addressLine2: "", townCity: "", postcode: "", startDate: "", endDate: "", isCurrent: false });
const emptyActivityForm = () => ({ type: "", startDate: "", endDate: "", organisation: "", description: "" });
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
  const checks: Array<[string, boolean]> = [
    ["Personal details", !!data?.legalFullName],
    ["Identity", data?.identityVerification === "VERIFIED"],
    ["Address history", !!data?.addresses?.length],
    [
      `${data?.screeningPeriodYears || 5}-year activity history`,
      !!data?.requirements?.chronology.continuous,
    ],
    ["References", !!data?.references?.length],
    ["Right to Work", data?.rightToWorkVerification === "VERIFIED"],
    ["Supporting evidence", !!data?.evidence?.some((x) => x.uploadCompleted)],
    ["Consent & declaration", !!data?.consents?.some((x) => !x.withdrawnAt)],
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

export function GuardScreeningJourney({ onBack }: { onBack: () => void }) {
  const [data, setData] = React.useState<GuardScreening | null>(null),
    [step, setStep] = React.useState<Step>("personal");
  const [guard, setGuard] = React.useState<GuardProfile | null>(null);
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
  const [showAddressForm, setShowAddressForm] = React.useState(false);
  const [showHistoryForm, setShowHistoryForm] = React.useState(false);
  const [reference, setReference] = React.useState({
    historyId: "",
    organisation: "",
    contactPerson: "",
    relationship: "",
    businessEmail: "",
    phone: "",
  });
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
    const source = await fetch(asset.uri);
    if (!source.ok) throw new Error("Unable to read the selected document.");
    const blob = await source.blob();
    const mimeType = normalizeEvidenceMimeType(asset.mimeType || blob.type, asset.name);
    if (!mimeType) throw new Error("Choose a PDF, JPEG/JPG or PNG document.");
    const sizeBytes = asset.size || blob.size;
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1)
      throw new Error("The selected document is empty or its size is unavailable.");
    if (sizeBytes > 10 * 1024 * 1024)
      throw new Error("The selected document exceeds the 10 MB size limit.");
    const created = await createMyScreeningEvidence({
      category,
      originalFileName: asset.name,
      mimeType,
      sizeBytes,
    });
    const uploaded = await fetch(created.upload.url, {
      method: created.upload.method,
      headers: created.upload.headers,
      body: blob,
    });
    if (!uploaded.ok)
      throw new Error("Private evidence upload failed. Please try again.");
    await completeMyScreeningEvidence(created.id);
  };
  const canEdit = editable(data?.status),
    canCorrectRecords = canEdit || data?.status === "READY_FOR_REVIEW",
    activeIndex = STEPS.findIndex((x) => x.key === step);
  const actionRequired = (key:string) => data?.requirements?.remediation?.some((item)=>item.key===key&&item.status==="ACTION_REQUIRED")===true;
  const canCorrectCompliance = canEdit || (data?.status === "READY_FOR_REVIEW" && (actionRequired("sia_expiry") || actionRequired("sia_check") || actionRequired("rtw_status") || actionRequired("rtw_check")));
  const canUploadEvidence = (category:string) => canEdit || (data?.status === "READY_FOR_REVIEW" && (category==="reference" || actionRequired(`${category}_evidence`)));
  const navigateToStep = (next: Step) => {
    setError("");
    setFeedback("");
    setStep(next);
  };
  const navigateToRemediation = (next: Step) => {
    navigateToStep(next);
    if(next==="addresses"){setEditingAddressId(null);setAddress(emptyAddressForm());setShowAddressForm(true);}
    if(next==="history"){setEditingHistoryId(null);setHistory(emptyActivityForm());setShowHistoryForm(true);}
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
        {STEPS.map((x, i) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: x.key === step }}
            key={x.key}
            onPress={() => navigateToStep(x.key)}
            style={[s.step, x.key === step && s.stepActive]}
          >
            <Text style={[s.stepNumber, x.key === step && s.stepTextActive]}>
              {i + 1}
            </Text>
            <Text style={[s.stepText, x.key === step && s.stepTextActive]}>
              {x.label}
            </Text>
          </Pressable>
        ))}
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
      <View style={s.stage}>
        <Text style={s.stageTitle}>{STEPS[activeIndex].label}</Text>
        <Text style={s.note}>
          {stageHelp(step, data.screeningPeriodYears || 5)}
        </Text>
        {step === "personal" ? (
          <>
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
                )
              }
            />
          </>
        ) : null}
        {step === "identity" ? (
          <>
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
            <EvidencePicker
              label="Choose identity evidence"
              category="identity"
              disabled={!canUploadEvidence("identity") || busy}
              onUpload={(asset) =>
                act(
                  () => uploadEvidence("identity", asset),
                  "Identity evidence uploaded. It is awaiting reviewer verification.",
                )
              }
            />
          </>
        ) : null}
        {step === "addresses" ? (
          <>
            <PeriodGuidance
              text={`Please provide your complete address history for the last ${data.screeningPeriodYears || 5} years. There must be no unexplained gaps between addresses.`}
              start={data.requirements?.addressChronology?.periodStart}
              end={data.requirements?.addressChronology?.periodEnd}
            />
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
              label="+ Add another address"
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
              <Action disabled={!canCorrectRecords || busy} label={editingAddressId?"Save address changes":"Save address"} onPress={() => {const payload={addressLine1:address.addressLine1,addressLine2:address.addressLine2||undefined,townCity:address.townCity,postcode:normalizeScreeningPostcode(address.postcode),startDate:screeningDateToIso(address.startDate),isCurrent:address.isCurrent,endDate:address.isCurrent?undefined:screeningDateToIso(address.endDate)};return act(() => editingAddressId?updateMyScreeningAddress(editingAddressId,payload):addMyScreeningAddress(payload), "Address history updated. The authoritative coverage check has been refreshed.", () => { setEditingAddressId(null); setAddress(emptyAddressForm()); setShowAddressForm(false); });}} />
              <Action disabled={busy} label="Cancel" onPress={() => { setEditingAddressId(null); setAddress(emptyAddressForm()); setShowAddressForm(false); }} />
            </View> : null}
            <EvidencePicker
              label="Choose address evidence"
              category="address"
              disabled={!canUploadEvidence("address") || busy}
              onUpload={(asset) =>
                act(
                  () => uploadEvidence("address", asset),
                  "Address evidence uploaded. It is awaiting reviewer verification.",
                )
              }
            />
            <Text style={s.safety}>
              Only an authorised reviewer can verify an address. Incomplete
              five-year coverage blocks submission.
            </Text>
          </>
        ) : null}
        {step === "history" ? (
          <>
            <PeriodGuidance
              text={`Please account for your complete employment, education and activity history for the last ${data.screeningPeriodYears || 5} years. There must be no unexplained gaps.`}
              start={data.requirements?.chronology.periodStart}
              end={data.requirements?.chronology.periodEnd}
            />
            <View style={s.timeline}>
              {(data.history || []).map((h) => (
                <View key={h.id} style={s.timelineItem}>
                  <View style={s.dot} />
                  <View style={s.flex}>
                    <Text style={s.itemTitle}>{pretty(h.type)}</Text>
                    <Text>{h.organisation || "Explanation provided"}</Text>
                    <Text style={s.meta}>
                      {dateLabel(h.startDate)} – {dateLabel(h.endDate)}
                    </Text>
                    {canCorrectRecords ? <View style={s.inlineActions}>
                      <Pressable accessibilityRole="button" style={s.smallButton} onPress={() => {setEditingHistoryId(h.id);setHistory({type:h.type,startDate:dateLabel(h.startDate),endDate:h.endDate?dateLabel(h.endDate):"",organisation:h.organisation||"",description:h.description||""});setShowHistoryForm(true);}}><Text style={s.smallButtonText}>Edit</Text></Pressable>
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
            <Action disabled={!canCorrectRecords || busy} label="+ Add another activity" onPress={() => { setEditingHistoryId(null); setHistory(emptyActivityForm()); setShowHistoryForm(true); }} />
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
            <Field
              label="End date (DD/MM/YYYY, leave blank if present)"
              value={history.endDate}
              set={(v) => setHistory({ ...history, endDate: v })}
            />
            <Field
              label="Details"
              value={history.description}
              set={(v) => setHistory({ ...history, description: v })}
            />
            <Action
              disabled={!canCorrectRecords || busy}
              label={editingHistoryId?"Save activity changes":"Save activity"}
              onPress={() => {
                const payload = {
                  ...history,
                  startDate: screeningDateToIso(history.startDate),
                  isCurrent: !history.endDate,
                  endDate: history.endDate ? screeningDateToIso(history.endDate) : undefined,
                };
                return act(
                  () => editingHistoryId ? updateMyScreeningHistory(editingHistoryId,payload) : addMyScreeningHistory(payload),
                  "Activity history updated. Authoritative gaps and overlaps have been refreshed.",
                  () => { setEditingHistoryId(null); setHistory(emptyActivityForm()); setShowHistoryForm(false); },
                );
              }}
            />
            <Action disabled={busy} label="Cancel" onPress={() => { setEditingHistoryId(null); setHistory(emptyActivityForm()); setShowHistoryForm(false); }} />
            </> : <Text style={s.meta}>Choose the activity type to continue.</Text>}
            </View> : null}
          </>
        ) : null}
        {step === "references" ? (
          <>
            <Text style={s.note}>Provide someone or an organisation that can confirm this period of your history. S4 or an authorised reviewer may contact them.</Text>
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
            <Text style={s.fieldLabel}>Activity this referee can confirm</Text>
            {data.history?.length ? (
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
                        {pretty(h.type)} ·{" "}
                        {h.organisation || "Explained period"} ·{" "}
                        {dateLabel(h.startDate)}–{dateLabel(h.endDate)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <Text style={s.warningTitle}>
                Add an activity period before adding a referee.
              </Text>
            )}
            <Field
              label="Organisation"
              value={reference.organisation}
              set={(v) => setReference({ ...reference, organisation: v })}
            />
            <Field
              label="Referee name"
              value={reference.contactPerson}
              set={(v) => setReference({ ...reference, contactPerson: v })}
            />
            <Field
              label="Relationship"
              value={reference.relationship}
              set={(v) => setReference({ ...reference, relationship: v })}
            />
            <Field
              label="Business email"
              value={reference.businessEmail}
              set={(v) => setReference({ ...reference, businessEmail: v })}
            />
            <Field
              label="Phone (optional)"
              value={reference.phone}
              set={(v) => setReference({ ...reference, phone: v })}
            />
            <Action
              disabled={!canEdit || busy || !reference.historyId}
              label="Add referee"
              onPress={() =>
                act(
                  () =>
                    addMyScreeningReference({
                      ...reference,
                      historyId: Number(reference.historyId),
                    }),
                  "Your referee details have been submitted. You do not need to wait on this page. An authorised reviewer will verify the reference.",
                )
              }
            />
            <EvidencePicker
              label="Choose optional reference supporting document"
              uploadLabel="Upload supporting document"
              category="reference"
              disabled={!canUploadEvidence("reference") || busy}
              onUpload={(asset) =>
                act(
                  () => uploadEvidence("reference", asset),
                  "Supporting document uploaded privately. It may assist the reviewer but does not verify the reference.",
                )
              }
            />
            <Text style={s.safety}>
              The selector contains only activity records returned for your
              screening file. The backend ownership check remains authoritative.
            </Text>
          </>
        ) : null}
        {step === "checks" ? (
          <>
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
            <EvidencePicker
              label="Choose SIA evidence"
              category="sia"
              disabled={!canUploadEvidence("sia") || busy}
              onUpload={(asset) =>
                act(
                  () => uploadEvidence("sia", asset),
                  "SIA evidence uploaded. It is awaiting register verification.",
                )
              }
            />
            <EvidencePicker
              label="Choose Right-to-Work evidence"
              category="right_to_work"
              disabled={!canUploadEvidence("right_to_work") || busy}
              onUpload={(asset) =>
                act(
                  () => uploadEvidence("right_to_work", asset),
                  "Right-to-Work evidence uploaded. It is awaiting reviewer verification.",
                )
              }
            />
          </>
        ) : null}
        {step === "evidence" ? (
          <>
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
            <EvidencePicker
              label="Choose additional supporting evidence"
              category="other"
              disabled={!canEdit || busy}
              onUpload={(asset) =>
                act(
                  () => uploadEvidence("other", asset),
                  "Supporting evidence uploaded. It is awaiting reviewer verification.",
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
            <Text style={s.meta}>
              Current consent:{" "}
              {data.consents?.some((x) => !x.withdrawnAt)
                ? "Accepted"
                : "Not accepted or withdrawn"}{" "}
              · Version: S4-PILOT-1
            </Text>
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
  category,
  onUpload,
  disabled,
}: {
  label: string;
  uploadLabel?:string;
  category: string;
  onUpload: (asset: DocumentPicker.DocumentPickerAsset) => Promise<boolean>;
  disabled: boolean;
}) {
  const [asset, setAsset] = React.useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError,setUploadError]=React.useState("");
  const choose = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/jpeg", "image/png"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return;
    setAsset(result.assets[0]);
    setUploadError("");
  };
  const upload = async () => {
    if (!asset) return;
    setUploading(true);
    setUploadError("");
    try {
      const success=await onUpload(asset);
      if(success)setAsset(null);else setUploadError("Upload failed. The selected document has been kept so you can try again.");
    } finally {
      setUploading(false);
    }
  };
  return (
    <View style={s.picker}>
      <Text style={s.fieldLabel}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled || uploading}
        style={[s.secondary, disabled && s.disabled]}
        onPress={choose}
      >
        <Text style={s.secondaryText}>Choose document</Text>
      </Pressable>
      {asset ? (
        <Text style={s.itemTitle}>{asset.name}</Text>
      ) : (
        <Text style={s.meta}>No document selected.</Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={uploadLabel||`Upload ${pretty(category)} document`}
        disabled={disabled || uploading || !asset}
        style={[s.button, (disabled || uploading || !asset) && s.disabled]}
        onPress={upload}
      >
        <Text style={s.buttonText}>{uploading ? "Uploading…" : uploadLabel||"Upload document"}</Text>
      </Pressable>
      {uploadError?<Text style={s.error}>{uploadError}</Text>:null}
      <Text style={s.meta}>Private upload category: {pretty(category)}</Text>
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
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
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
      {rows.map((item) => (
        <View key={item.key} style={s.reviewRow}>
          <View style={s.flex}><Text style={s.label}>{item.label}</Text><Text style={s.itemTitle}>{item.status.replaceAll('_',' ')}</Text><Text style={s.note}>{item.message}</Text></View>
          {item.status==='ACTION_REQUIRED'?<Pressable accessibilityRole="button" style={s.fixButton} onPress={()=>onFix(item.step)}><Text style={s.fixButtonText}>Fix this</Text></Pressable>:null}
        </View>
      ))}
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
  errorBox: {
    color: colors.danger,
    backgroundColor: colors.dangerSurface,
    borderWidth: 1,
    borderColor: colors.dangerSurface,
    padding: spacing.md,
    borderRadius: 10,
  },
});
