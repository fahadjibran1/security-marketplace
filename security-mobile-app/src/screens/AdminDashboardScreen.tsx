import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { ADMIN_NAV_ITEMS, type AdminSection, adminPortalError, matchesAdminSearch } from '../navigation/admin-portal';
import { isGuardProfileComplete } from '../navigation/guard-lifecycle';
import {
  getHealthLive, getHealthReady, listAssignments, listAuditLogs, listCompanies,
  listCompanyAttendance, listCompanyDailyLogs, listCompanyIncidents, listCompanyNotifications,
  listCompanySafetyAlerts, listGuards, listJobApplications, listJobs, listShifts, listSites, listTimesheets,
  accessScreeningEvidence, formatApiErrorMessage, getScreening, listScreeningQueue,
  completeScreeningReview, expireScreening, rejectScreening, requestScreeningInformation, requestScreeningReference, reviewScreeningReference, startScreeningReview, verifyScreeningCheck,
} from '../services/api';
import type { GuardScreening, ScreeningQueueFilter, ScreeningQueueResponse, ScreeningQueueRow } from '../types/models';
// The same DD/MM/YYYY <-> ISO helpers the Guard journey uses. A reviewer should never have to know
// the transport format, and the two sides of the product should not disagree about what a date is.
import { formatScreeningDate, screeningDateToIso } from '../components/guard/screening-format';
import { colors } from '../theme';

// The reviewer workload. "Needs review" is the default: everything that can actually be progressed
// right now, which is why it spans three derived buckets.
const QUEUE_FILTERS: Array<{ key: ScreeningQueueFilter; label: string }> = [
  { key: 'needs_review', label: 'Needs review' }, { key: 'awaiting_review', label: 'Awaiting review' },
  { key: 'under_review', label: 'Under review' }, { key: 'needs_guard_action', label: 'Needs Guard action' },
  { key: 'ready_to_complete', label: 'Ready to complete' }, { key: 'vetted', label: 'Vetted' },
  { key: 'not_submitted', label: 'Not submitted' }, { key: 'all', label: 'All' },
];
const QUEUE_BUCKET_LABEL: Record<string, string> = { AWAITING_REVIEW: 'AWAITING REVIEW', UNDER_REVIEW: 'UNDER REVIEW', NEEDS_GUARD_ACTION: 'NEEDS GUARD ACTION', READY_TO_COMPLETE: 'READY TO COMPLETE', VETTED: 'VETTED', NOT_SUBMITTED: 'NOT SUBMITTED', CLOSED: 'CLOSED' };
const QUEUE_PRIMARY_ACTION: Record<string, string> = { AWAITING_REVIEW: 'Start review', UNDER_REVIEW: 'Continue review', NEEDS_GUARD_ACTION: 'View', READY_TO_COMPLETE: 'Complete review', VETTED: 'View', NOT_SUBMITTED: 'View', CLOSED: 'View' };
const shortDate = (value: unknown) => value ? new Date(String(value)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'Not submitted';

type DisplayRow = { id: string; title: string; detail: string; status?: string; raw?: Record<string, any> };
type Loader = () => Promise<unknown[]>;
const text = (value: unknown, fallback = 'Not recorded') => value === null || value === undefined || value === '' ? fallback : String(value);
const date = (value: unknown) => value ? new Date(String(value)).toLocaleString() : 'Not recorded';

const loaders: Record<Exclude<AdminSection, 'overview'>, Loader> = {
  companies: listCompanies, guards: listGuards, sites: listSites, jobs: listJobs,
  applications: listJobApplications, assignments: listAssignments, shifts: listShifts,
  attendance: listCompanyAttendance, timesheets: listTimesheets, incidents: listCompanyIncidents,
  alerts: listCompanySafetyAlerts, dailyLogs: listCompanyDailyLogs, audit: listAuditLogs,
  // Screening has its own compact queue endpoint and never goes through this generic loader; the
  // key exists only to satisfy the section map. Calling it would fetch every full application.
  screening: async () => [],
  notifications: listCompanyNotifications,
  health: async () => [{ id: 'live', name: 'Liveness', ...(await getHealthLive()) }, { id: 'ready', name: 'Readiness', ...(await getHealthReady()) }],
};

function displayRow(section: Exclude<AdminSection, 'overview'>, value: unknown, index: number): DisplayRow {
  const row = value as Record<string, any>;
  const id = text(row.id, String(index + 1));
  switch (section) {
    case 'companies': return { id, title: text(row.name), detail: `Company no. ${text(row.companyNumber)} · ${text(row.address)}` };
    case 'guards': return { id, title: text(row.fullName), detail: `Account: ${text(row.user?.status, 'unknown')} · Profile: ${isGuardProfileComplete(row) ? 'Complete' : 'Incomplete'} · Vetting: company review required · Work eligibility: assessed per company`, status: `Account ${text(row.user?.status, 'unknown')}` };
    case 'sites': return { id, title: text(row.name), detail: `${text(row.address)} · ${text(row.company?.name, 'Company not linked')}`, status: text(row.status) };
    case 'jobs': return { id, title: text(row.title), detail: `${text(row.company?.name, `Company ${text(row.companyId)}`)} · ${text(row.guardsRequired, '0')} guards`, status: text(row.status) };
    case 'applications': return { id, title: text(row.guard?.fullName, `Guard ${text(row.guardId)}`), detail: `${text(row.job?.title, `Job ${text(row.jobId)}`)} · Applied ${date(row.appliedAt)}`, status: text(row.status) };
    case 'assignments': return { id, title: text(row.guard?.fullName, `Guard ${text(row.guardId)}`), detail: `${text(row.job?.title, `Job ${text(row.jobId)}`)} · Hired ${date(row.hiredAt)}`, status: text(row.status) };
    case 'shifts': return { id, title: text(row.siteName ?? row.site?.name, 'Shift'), detail: `${date(row.start)} — ${date(row.end)} · ${text(row.guard?.fullName, 'Unassigned')}`, status: text(row.status) };
    case 'attendance': return { id, title: `${text(row.type)} · ${text(row.guard?.fullName, 'Guard')}`, detail: `${date(row.occurredAt)} · ${text(row.shift?.siteName, 'Site not recorded')}` };
    case 'timesheets': return { id, title: `Timesheet #${id}`, detail: `Guard ${text(row.guardId)} · Approved ${text(row.approvedHours, 'pending')}h · Payroll ${text(row.payrollStatus)} · Billing ${text(row.billingStatus)}`, status: text(row.approvalStatus) };
    case 'incidents': return { id, title: text(row.title), detail: `${text(row.severity)} severity · ${text(row.site?.name, row.locationText ?? 'Location not recorded')} · ${date(row.createdAt)}`, status: text(row.status) };
    case 'alerts': return { id, title: `${text(row.type)} · ${text(row.priority)} priority`, detail: `${text(row.guard?.fullName, 'Guard not recorded')} · ${date(row.createdAt)} · ${text(row.message)}`, status: text(row.status) };
    case 'dailyLogs': return { id, title: `${text(row.logType)} · ${text(row.guard?.fullName, 'Guard')}`, detail: `${date(row.createdAt)} · ${text(row.message)}` };
    case 'screening': return { id, title: text(row.guard?.fullName, `Screening #${id}`), detail: `${text(row.progress, '0')}% complete · ${text(row.requirements?.missing?.length, '0')} outstanding requirements`, status: text(row.status), raw: row };
    case 'audit': return { id, title: text(row.action), detail: `${text(row.entityType)} #${text(row.entityId)} · ${text(row.user?.email, 'System actor')} · ${date(row.createdAt)}` };
    case 'notifications': return { id, title: text(row.title), detail: `${text(row.message)} · ${date(row.createdAt)}`, status: text(row.status) };
    case 'health': return { id, title: text(row.name), detail: `API response received · ${Object.keys(row).filter((key) => key !== 'id' && key !== 'name').map((key) => `${key}: ${text(row[key])}`).join(' · ')}`, status: 'available' };
  }
}

export function AdminDashboardScreen() {
  const compact = useWindowDimensions().width < 900;
  const contentScroll=useRef<any>(null);
  const [section, setSection] = useState<AdminSection>('overview');
  const [rows, setRows] = useState<DisplayRow[]>([]);
  const [overview, setOverview] = useState<{ section: AdminSection; count: number }[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DisplayRow | null>(null);
  const [reviewReason,setReviewReason]=useState('');
  const [reviewReasonAction,setReviewReasonAction]=useState<'complete'|'request'|'reject'|'expire'|null>(null);
  const [reviewAction,setReviewAction]=useState<string|null>(null);
  const [reviewFeedback,setReviewFeedback]=useState<{tone:'success'|'error';message:string}|null>(null);
  const [reviewCategory,setReviewCategory]=useState<'identity'|'address'|'sia'|'rtw'|null>(null);
  const [inspectedEvidenceId,setInspectedEvidenceId]=useState<number|null>(null);
  const [verificationConfirm,setVerificationConfirm]=useState(false);
  const [imageViewer,setImageViewer]=useState<{url:string;label:string}|null>(null);
  const [referencesOpen,setReferencesOpen]=useState(false);
  const [referenceReviewId,setReferenceReviewId]=useState<number|null>(null);
  const [referenceDecision,setReferenceDecision]=useState<'VERIFIED'|'DISCREPANCY'|'UNABLE_TO_VERIFY'|'REJECTED'|'SOURCE_VERIFICATION_REQUIRED'>('VERIFIED');
  // Both start blank: the reviewer is recording what the referee confirmed, which is not today and
  // is not automatically the candidate's claim.
  const [confirmedStart,setConfirmedStart]=useState('');
  const [confirmedEnd,setConfirmedEnd]=useState('');
  const [confirmedCurrent,setConfirmedCurrent]=useState(false);
  const [confirmedError,setConfirmedError]=useState<{field:'start'|'end';message:string}|null>(null);
  const [referenceMethod,setReferenceMethod]=useState('Telephone call');
  const [referenceNotes,setReferenceNotes]=useState('');
  const [referenceConfirm,setReferenceConfirm]=useState(false);
  const [queue,setQueue]=useState<ScreeningQueueResponse|null>(null);
  const [queueFilter,setQueueFilter]=useState<ScreeningQueueFilter>('needs_review');
  const [queueTerm,setQueueTerm]=useState('');
  const [completedOpen,setCompletedOpen]=useState(false);
  // Set only after a check is successfully *completed*, so the focused task can hand the reviewer
  // straight to the next one instead of stranding them in a finished task.
  const [completedCheck,setCompletedCheck]=useState<{key:string;label:string}|null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (section === 'overview') {
        const keys: Exclude<AdminSection, 'overview'>[] = ['companies', 'guards', 'sites', 'jobs', 'shifts', 'incidents', 'alerts', 'audit'];
        const results = await Promise.all(keys.map((key) => loaders[key]()));
        setOverview(keys.map((key, index) => ({ section: key, count: results[index].length })));
      } else if (section === 'screening') {
        // The reviewer queue has its own compact endpoint and its own effect; never load the full
        // screening applications here.
        setRows([]);
      } else {
        const result = await loaders[section]();
        const nextRows=result.map((item, index) => displayRow(section, item, index));
        setRows(nextRows);
      }
    } catch (nextError) { setError(adminPortalError((nextError as { status?: number })?.status)); }
    finally { setLoading(false); }
  }, [section]);

  useEffect(() => { setQuery(''); setSelected(null); setReviewReason(''); setReviewReasonAction(null); setReviewFeedback(null); setReviewCategory(null); setInspectedEvidenceId(null); setVerificationConfirm(false); setReferencesOpen(false); setReferenceReviewId(null); load(); }, [load]);
  const loadQueue=useCallback(async(overrides:{filter?:ScreeningQueueFilter;q?:string}={})=>{
    const result=await listScreeningQueue({filter:overrides.filter??queueFilter,q:(overrides.q??queueTerm)||undefined});
    setQueue(result);
    return result;
  },[queueFilter,queueTerm]);
  // Server-side search, debounced: the queue is filtered in the database, not over a page already
  // downloaded.
  useEffect(()=>{if(section!=='screening')return undefined;const timer=setTimeout(()=>setQueueTerm(query.trim()),300);return ()=>clearTimeout(timer);},[query,section]);
  useEffect(()=>{
    if(section!=='screening')return undefined;
    let cancelled=false;
    setLoading(true);setError(null);
    loadQueue().catch((queueError)=>{if(!cancelled)setError(adminPortalError((queueError as {status?:number})?.status));}).finally(()=>{if(!cancelled)setLoading(false);});
    return ()=>{cancelled=true;};
  },[section,loadQueue]);
  // A review action must never re-download every screening: refresh the open Guard, then the
  // compact queue so its row and the workload counts stay correct.
  const refreshSelectedScreening=useCallback(async(id:number)=>{const detail=await getScreening(id);const detailRow=displayRow('screening',detail,0);setSelected(detailRow);void loadQueue().catch(()=>undefined);return detailRow;},[loadQueue]);
  const openQueueRow=useCallback(async(row:ScreeningQueueRow)=>{
    setReviewReason('');setReviewReasonAction(null);setReviewFeedback(null);setReviewCategory(null);setInspectedEvidenceId(null);setVerificationConfirm(false);setReferencesOpen(false);setReferenceReviewId(null);setCompletedOpen(false);setCompletedCheck(null);
    setLoading(true);
    try{const detail=await getScreening(row.id);setSelected(displayRow('screening',detail,0));}
    catch(openError){setError(adminPortalError((openError as {status?:number})?.status));}
    finally{setLoading(false);}
  },[]);
  const backToQueue=useCallback(()=>{setSelected(null);setReviewCategory(null);setReferencesOpen(false);setReviewFeedback(null);setCompletedOpen(false);setCompletedCheck(null);void loadQueue().catch(()=>undefined);},[loadQueue]);
  const runReviewAction=async(key:string,mutation:()=>Promise<unknown>,success:string,blankReasonMessage?:string)=>{if(reviewAction||!selected)return false;if(blankReasonMessage&&!reviewReason.trim()){setReviewFeedback({tone:'error',message:blankReasonMessage});return false;}const selectedId=Number(selected.id);setReviewAction(key);setReviewFeedback(null);try{await mutation();await refreshSelectedScreening(selectedId);setReviewFeedback({tone:'success',message:success});return true;}catch(actionError){setReviewFeedback({tone:'error',message:formatApiErrorMessage(actionError,'Unable to update this screening review.')});return false;}finally{setReviewAction(null);}};
  const submitReasonAction=async()=>{if(!selected||!reviewReasonAction)return;const reason=reviewReason.trim();let success=false;if(reviewReasonAction==='complete')success=await runReviewAction('complete',()=>completeScreeningReview(Number(selected.id),reason),'Screening completed successfully.','Add a completion decision note before completing screening.');if(reviewReasonAction==='request')success=await runReviewAction('request',()=>requestScreeningInformation(Number(selected.id),reason),'Information request recorded successfully.','Describe what information the candidate needs to provide.');if(reviewReasonAction==='reject')success=await runReviewAction('reject',()=>rejectScreening(Number(selected.id),reason),'Screening rejected successfully.','Add a rejection reason before rejecting screening.');if(reviewReasonAction==='expire')success=await runReviewAction('expire',()=>expireScreening(Number(selected.id),reason),'Screening marked expired successfully.','Add an expiry reason before expiring screening.');if(success){setReviewReason('');setReviewReasonAction(null);if(reviewReasonAction==='complete'){/* Vetted: hand the reviewer straight back to the queue with the row gone from Needs review. */setSelected(null);setCompletedOpen(false);void loadQueue().catch(()=>undefined);}}};
  const openEvidence=async(evidence:{id:number;category:string;mimeType:string})=>{if(reviewAction||!selected)return;setReviewAction(`evidence-${evidence.id}`);setReviewFeedback(null);try{const access=await accessScreeningEvidence(Number(selected.id),evidence.id);setInspectedEvidenceId(evidence.id);setVerificationConfirm(false);if(evidence.mimeType.startsWith('image/'))setImageViewer({url:access.url,label:`${evidence.category.replaceAll('_',' ')} evidence`});else await Linking.openURL(access.url);setReviewFeedback({tone:'success',message:'Private evidence opened for review. Verification has not been changed.'});}catch(accessError){setReviewFeedback({tone:'error',message:formatApiErrorMessage(accessError,'Unable to open this private evidence.')});}finally{setReviewAction(null);}};
  const current = ADMIN_NAV_ITEMS.find((item) => item.key === section)!;
  const visibleRows = useMemo(() => rows.filter((row) => matchesAdminSearch([row.id, row.title, row.detail, row.status], query)), [rows, query]);
  const reviewEvidenceCategory=reviewCategory==='rtw'?'right_to_work':reviewCategory;
  const reviewEvidence=(selected?.raw?.evidence||[]).filter((entry:Record<string,any>)=>entry.category===reviewEvidenceCategory&&entry.uploadCompleted);
  const currentReviewAddress=selected?.raw?.addresses?.find((entry:Record<string,unknown>)=>entry.isCurrent);
  const reviewReadiness=selected?.raw?.reviewReadiness as {ready:boolean;blockers:Array<{key:string;label:string;detail:string}>;addressVerificationScope?:string}|undefined;
  const verificationSummary=(selected?.raw?.reviewReadiness as any)?.verificationSummary as {completed:number;total:number;checks:Array<{key:string;label:string;complete:boolean}>}|undefined;
  const screeningReferences=(selected?.raw?.references||[]) as Array<Record<string,any>>;
  // Attention first, from the single classification the backend also built the queue row with, so
  // an opened review can never contradict the row that led to it.
  const classification=selected?.raw?.reviewClassification as GuardScreening['reviewClassification'];
  const yourActions=classification?.reviewerActions||[];
  const waitingForGuard=classification?.guardActions||[];
  const checklist=classification?.checklist||[];
  // The backend refuses every reviewer decision unless the file is UNDER_REVIEW, so the screen
  // offers the controls on exactly the same condition rather than inventing its own.
  const reviewerActionable=classification?.reviewerActionable??false;
  const checksRemaining=classification?.checksRemaining??checklist.filter(entry=>!entry.complete).length;
  const completedChecks=(verificationSummary?.checks||[]).filter(check=>check.complete);
  const referenceRecord=screeningReferences[0];
  // While a specific check is being reviewed, the checklist steps out of the way.
  const focusedReview=!!reviewCategory||referencesOpen;
  const openCheck=(key:string)=>{
    if(key==='consent')return;
    setCompletedCheck(null);
    if(key==='reference'){openReferences();return;}
    setReviewCategory(key as 'identity'|'address'|'sia'|'rtw');setInspectedEvidenceId(null);setVerificationConfirm(false);setReviewFeedback(null);
  };
  // The next task comes from the refreshed backend checklist, in its order — never a hard-coded
  // chain. Anything complete, Guard-owned or not yet actionable is skipped.
  const nextCheck=checklist.find(entry=>!entry.complete&&entry.owner==='reviewer'&&entry.actionable&&entry.key!==completedCheck?.key);
  const leaveFocusedTask=()=>{setCompletedCheck(null);setReviewCategory(null);setReferencesOpen(false);setReferenceReviewId(null);setInspectedEvidenceId(null);setVerificationConfirm(false);setReviewFeedback(null);};
  const sourceVerifiedReferences=screeningReferences.filter(entry=>entry.status==='VERIFIED'&&entry.sourceVerified).length;
  // Opening the reference task must land on the decision form, not just the summary. With a single
  // outstanding reference there is nothing to choose, so select it; with several the reviewer picks.
  const openReferences=()=>{
    const outstanding=((selected?.raw?.references||[]) as Array<Record<string,any>>).filter(entry=>!(entry.status==='VERIFIED'&&entry.sourceVerified));
    setReferencesOpen(true);
    setReferenceReviewId(outstanding.length===1?Number(outstanding[0].id):null);
    if(outstanding.length===1){setReferenceDecision('VERIFIED');setReferenceMethod('Telephone call');setReferenceNotes('');setReferenceConfirm(false);setConfirmedStart('');setConfirmedEnd('');setConfirmedCurrent(false);}
    setReviewCategory(null);setReviewFeedback(null);setTimeout(()=>contentScroll.current?.scrollToEnd({animated:true}),0);
  };
  const beginReferenceReview=(id:number)=>{setReferenceReviewId(id);setReferenceDecision('VERIFIED');setReferenceMethod('Telephone call');setReferenceNotes('');setReferenceConfirm(false);setReviewFeedback(null);};
  const submitReferenceDecision=async()=>{if(!selected||!referenceReviewId)return;if(!referenceMethod||!referenceNotes.trim()){setReviewFeedback({tone:'error',message:'Verification method and reviewer note are required.'});return;}if(!referenceConfirm){setReviewFeedback({tone:'error',message:'Confirm that you independently checked the source of this reference.'});return;}const confirmsDates=referenceDecision==='VERIFIED'||referenceDecision==='DISCREPANCY';
    // Convert the reviewer's DD/MM/YYYY into the canonical YYYY-MM-DD the DTO accepts, and refuse
    // to send anything the backend would reject. Errors are plain language, against the field.
    setConfirmedError(null);
    let startIso:string|undefined;let endIso:string|undefined;
    if(confirmsDates){
      if(!confirmedStart.trim()){setConfirmedError({field:'start',message:'Enter the start date the reference confirmed, as DD/MM/YYYY.'});return;}
      try{startIso=screeningDateToIso(confirmedStart);}catch(e){setConfirmedError({field:'start',message:(e as Error).message});return;}
      if(!confirmedCurrent){
        if(!confirmedEnd.trim()){setConfirmedError({field:'end',message:'Enter the end date the reference confirmed, or tick “Still current”.'});return;}
        try{endIso=screeningDateToIso(confirmedEnd);}catch(e){setConfirmedError({field:'end',message:(e as Error).message});return;}
        if(endIso<startIso){setConfirmedError({field:'end',message:'The confirmed end date cannot be before the confirmed start date.'});return;}
      }
    }
    const label=referenceDecision==='VERIFIED'?'verified':referenceDecision==='DISCREPANCY'?'recorded as a discrepancy':referenceDecision==='UNABLE_TO_VERIFY'?'marked unable to verify':referenceDecision==='REJECTED'?'rejected':'marked as requiring clarification';
    const success=await runReviewAction(`reference-${referenceReviewId}`,()=>reviewScreeningReference(Number(selected.id),referenceReviewId,{status:referenceDecision,verificationMethod:referenceMethod,notes:referenceNotes.trim(),confirmed:true,...(confirmsDates?{confirmedStartDate:startIso,...(confirmedCurrent?{confirmedIsCurrent:true}:{confirmedEndDate:endIso})}:{})}),`Reference ${label} successfully.`);
    if(success){setReferenceReviewId(null);setReferenceMethod('Telephone call');setReferenceNotes('');setReferenceConfirm(false);setConfirmedStart('');setConfirmedEnd('');setConfirmedCurrent(false);setConfirmedError(null);
      // Only a clean confirmation completes the check. A discrepancy, an unable-to-verify, a
      // rejection or a clarification request all need the reviewer's attention where they are.
      if(referenceDecision==='VERIFIED')setCompletedCheck({key:'reference',label:'Reference'});}};
  const reasonCopy=reviewReasonAction?({complete:{label:'Completion decision note',help:'Record why this screening is being approved.',button:'Complete screening'},request:{label:'Information requested from candidate',help:'Explain exactly what the candidate must provide or correct.',button:'Send information request'},reject:{label:'Rejection reason',help:'Record why this screening is being rejected.',button:'Reject screening'},expire:{label:'Expiry reason',help:'Record why this screening approval is being expired.',button:'Mark expired'}} as const)[reviewReasonAction]:null;

  const navigation = <ScrollView horizontal={compact} style={compact ? styles.mobileNav : styles.sidebar} contentContainerStyle={compact ? styles.mobileNavContent : styles.sidebarContent}>
    {!compact ? <Text style={styles.brand}>S4 Platform Admin</Text> : null}
    {ADMIN_NAV_ITEMS.map((item) => <Pressable key={item.key} accessibilityRole="button" accessibilityState={{ selected: item.key === section }} onPress={() => setSection(item.key)} style={[styles.navItem, item.key === section && styles.navItemActive]}><Text style={[styles.navText, item.key === section && styles.navTextActive]}>{item.label}</Text></Pressable>)}
  </ScrollView>;

  return <View style={[styles.shell, compact && styles.shellCompact]}>{imageViewer?<Modal transparent animationType="fade" onRequestClose={()=>setImageViewer(null)}><View style={styles.modalBackdrop}><View style={styles.imageModal}><Text style={styles.detailHeading}>{imageViewer.label}</Text><Image source={{uri:imageViewer.url}} resizeMode="contain" style={styles.evidenceImage}/><Text style={styles.rowDetail}>This short-lived private preview does not change verification state.</Text><Pressable style={styles.approveButton} onPress={()=>setImageViewer(null)}><Text style={styles.approveText}>Close preview</Text></Pressable></View></View></Modal>:null}{navigation}<ScrollView ref={contentScroll} style={styles.content} contentContainerStyle={styles.contentInner}>
    <View style={styles.headingRow}><View style={styles.headingCopy}><Text style={styles.title}>{current.label}</Text><Text style={styles.subtitle}>Global Platform Admin view · RC1 authorized capability</Text></View><Pressable style={styles.refreshButton} onPress={load} disabled={loading}><Text style={styles.refreshText}>{loading ? 'Loading…' : 'Refresh'}</Text></Pressable></View>
    {section !== 'overview' && !(section === 'screening' && selected) ? <TextInput accessibilityLabel={section === 'screening' ? 'Search Guards' : 'Search current admin view'} value={query} onChangeText={setQuery} placeholder={section === 'screening' ? 'Search Guards…' : 'Search this view'} style={styles.search} /> : null}
    {section === 'screening' && !selected ? <>
      <View style={styles.grid}>
        {([['Awaiting review',queue?.counts.awaitingReview],['Under review',queue?.counts.underReview],['Needs Guard action',queue?.counts.needsGuardAction],['Ready to complete',queue?.counts.readyToComplete],['Vetted',queue?.counts.vetted]] as Array<[string,number|undefined]>).map(([label,count])=>
          <View key={label} style={styles.metricCard}><Text style={styles.cardLabel}>{label}</Text><Text style={styles.cardValue}>{count===undefined?'—':count}</Text></View>)}
      </View>
      <View style={styles.filterRow}>
        {QUEUE_FILTERS.map((option)=><Pressable key={option.key} accessibilityRole="button" accessibilityState={{selected:option.key===queueFilter}} onPress={()=>{setQueueFilter(option.key);setSelected(null);}} style={[styles.filterChip,option.key===queueFilter&&styles.filterChipActive]}><Text style={option.key===queueFilter?styles.filterChipTextActive:styles.filterChipText}>{option.label}</Text></Pressable>)}
      </View>
      {!loading&&!error&&queue&&!queue.rows.length?<View style={styles.empty}><Text style={styles.emptyTitle}>{queueTerm?'No matching Guards':'Nothing waiting for you'}</Text><Text style={styles.emptyText}>{queueTerm?'Clear or change the search term.':'No screening files are in this part of the workload.'}</Text></View>:null}
      {queue?.rows.length?<View style={styles.list}>{queue.rows.map((row)=>
        <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`Open ${row.guardName??`screening ${row.id}`} review`} onPress={()=>openQueueRow(row)} style={styles.queueRow}>
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>{text(row.guardName,`Screening #${row.id}`)}</Text>
            <Text style={styles.rowDetail}>{text(row.guardEmail,'No email recorded')}</Text>
            <Text style={styles.rowDetail}>Submitted {shortDate(row.submittedAt)}</Text>
            <Text style={styles.rowDetail}>Candidate {row.progress}% · Verification {row.verificationCompleted}/{row.verificationTotal}</Text>
            <Text style={styles.rowDetail}>Reviewer actions: {row.reviewerActions} · Guard actions: {row.guardActions}</Text>
            <Text style={styles.status}>{QUEUE_BUCKET_LABEL[row.bucket]}</Text>
          </View>
          <Text style={styles.queueAction}>{QUEUE_PRIMARY_ACTION[row.bucket]}</Text>
        </Pressable>)}
      </View>:null}
      {queue&&queue.total>queue.rows.length?<Text style={styles.reasonHelp}>Showing {queue.rows.length} of {queue.total}. Narrow with a filter or search.</Text>:null}
    </> : null}
    {error ? <View style={styles.errorBox}><Text style={styles.error}>{error}</Text><Pressable onPress={load}><Text style={styles.retry}>Retry</Text></Pressable></View> : null}
    {section === 'overview' && loading ? <Text style={styles.loading}>Loading Platform Admin overview…</Text> : null}
    {section === 'overview' && !error ? <View style={styles.grid}>{overview.map((metric) => { const item = ADMIN_NAV_ITEMS.find((entry) => entry.key === metric.section)!; return <Pressable key={metric.section} onPress={() => setSection(metric.section)} style={styles.metricCard}><Text style={styles.cardLabel}>{item.label}</Text><Text style={styles.cardValue}>{loading ? '—' : metric.count}</Text><Text style={styles.link}>Open view →</Text></Pressable>; })}</View> : null}
    {section !== 'overview' && section !== 'screening' && !loading && !error && visibleRows.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>{query ? 'No matching records' : current.emptyLabel}</Text><Text style={styles.emptyText}>{query ? 'Clear or change the search term.' : 'This is expected for a freshly provisioned pilot database.'}</Text></View> : null}
    {section !== 'overview' && loading ? <Text style={styles.loading}>Loading {current.label.toLocaleLowerCase()}…</Text> : null}
    {selected ? <View style={styles.detailPanel}>{section==='screening'?<Pressable accessibilityRole="button" onPress={backToQueue}><Text style={styles.backToQueue}>← Back to Screening Review</Text></Pressable>:null}<Text style={styles.detailHeading}>{selected.title}</Text><Text style={styles.rowDetail}>{selected.detail}</Text>{selected.status ? <Text style={styles.status}>{selected.status}</Text> : null}
      {section==='screening'?<><View style={styles.readinessReady}><Text style={styles.reviewSuccessTitle}>SCREENING REVIEW</Text>
        {/* The whole job in three lines. Everything else is the checklist or is behind
            "View full application". */}
        <Text style={styles.rowTitle}>Candidate application: {Number(selected.raw?.progress)===100?'Complete ✓':`${text(selected.raw?.progress,'0')}% complete`}</Text>
        <Text style={styles.rowDetail}>{checksRemaining===0?'No checks remaining':`${checksRemaining} check${checksRemaining===1?'':'s'} remaining`}</Text>
        <Text style={styles.rowDetail}>Reviewer actions remaining: {yourActions.length} · Guard actions remaining: {waitingForGuard.length}</Text>
        {classification?.informationRequestOutstanding?<>
          <Text style={styles.rowDetail}>An information request was sent to this Guard and has not been answered{selected.raw?.reviewNotes?`: “${text(selected.raw.reviewNotes)}”`:'.'}</Text>
          {/* Until this is answered or withdrawn the backend refuses every reviewer decision, so the
              way out has to be on screen rather than implied. */}
          <Text style={styles.rowDetail}>Checks cannot be verified while the request is outstanding.</Text>
          <Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>runReviewAction('resume',()=>startScreeningReview(Number(selected.id)),'Information request withdrawn. The screening is under review again.')}><Text style={styles.approveText}>{reviewAction==='resume'?'Resuming…':'Withdraw request & resume review'}</Text></Pressable>
        </>:null}</View>
      {classification?.referenceDiscrepancy?<View style={styles.waitingRow}><Text style={styles.screeningWarningTitle}>Reference discrepancy</Text>
        <Text style={styles.rowDetail}>Candidate claimed: {text(referenceRecord?.history?.startDate)} — {text(referenceRecord?.history?.endDate,referenceRecord?.history?.isCurrent?'Present':'Not recorded')}</Text>
        <Text style={styles.rowDetail}>Reference confirmed: {text(referenceRecord?.confirmedStartDate)} — {referenceRecord?.confirmedIsCurrent?'Present':text(referenceRecord?.confirmedEndDate)}</Text>
        {referenceRecord?.outcomeNotes?<Text style={styles.rowDetail}>Reviewer note: “{text(referenceRecord.outcomeNotes)}”</Text>:null}
        <Text style={styles.rowDetail}>This screening cannot be completed until the discrepancy is resolved.</Text></View>:null}
      {reviewReadiness?.ready&&selected.status==='UNDER_REVIEW'?<View style={styles.readinessReady}><Text style={styles.reviewSuccessTitle}>✓ All required checks complete</Text><Text style={styles.rowDetail}>Record the completion decision note to make the final deliberate approval. The backend remains authoritative.</Text><Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>{setReviewReasonAction('complete');setReviewReason('');setReviewFeedback(null);}}><Text style={styles.approveText}>Mark Guard vetted</Text></Pressable></View>:null}
      {/* The normal reviewer workflow: six named checks, one next action each. Choosing one
          focuses it and the checklist steps aside. */}
      {!focusedReview?<><Text style={styles.detailHeading}>REVIEW CHECKLIST</Text>
      {checklist.map(entry=><View key={entry.key} style={entry.owner==='guard'?styles.waitingRow:styles.attentionRow}>
        <View style={styles.rowCopy}>
          <Text style={styles.rowTitle}>{entry.label}{entry.key==='reference'&&referenceRecord?.organisation?` — ${text(referenceRecord.organisation)}`:''}</Text>
          <Text style={styles.rowDetail}>{entry.complete?`✓ ${entry.message}`:entry.owner==='guard'?`Waiting for Guard — ${entry.message}`:'Awaiting verification'}</Text>
        </View>
        {!entry.complete&&entry.owner==='reviewer'?<Pressable disabled={!!reviewAction||!entry.actionable} style={[styles.approveButton,(reviewAction||!entry.actionable)&&styles.disabledButton]} onPress={()=>openCheck(entry.key)}><Text style={styles.approveText}>Review</Text></Pressable>:null}
      </View>)}
      {waitingForGuard.length&&['READY_FOR_REVIEW','UNDER_REVIEW'].includes(selected.status||'')?<Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>{setReviewReasonAction('request');setReviewReason('');setReviewFeedback(null);}}><Text style={styles.approveText}>Request information</Text></Pressable>:null}
      <Pressable accessibilityRole="button" accessibilityState={{expanded:completedOpen}} onPress={()=>setCompletedOpen(value=>!value)}><Text style={styles.collapseToggle}>{completedOpen?'▾':'▸'} View full application ({completedChecks.length} of {checklist.length} checks complete)</Text></Pressable></>:null}
      {completedOpen&&!focusedReview?<>
        {/* The authoritative six-check ledger, in the section it belongs to rather than repeated
            above the actions. */}
        {verificationSummary?.checks.map(check=><Text key={check.key} style={styles.rowDetail}>{check.complete?'✓':'!'} {check.label} {check.complete?'verified or current':'requires review'}</Text>)}
        <View style={styles.screeningReviewGrid}>
        {([['Identity',selected.raw?.identityVerification],['Address',selected.raw?.addresses?.find((entry:Record<string,unknown>)=>entry.isCurrent)?.verificationState],['SIA register',selected.raw?.siaRegisterVerification],['Right to Work',selected.raw?.rightToWorkVerification],['Consent',selected.raw?.consents?.some((entry:Record<string,unknown>)=>!entry.withdrawnAt)?'CURRENT':'MISSING']] as Array<[string,unknown]>).map(([label,value])=><View key={label} style={styles.screeningCheck}><Text style={styles.cardLabel}>{label}</Text><Text style={styles.screeningCheckValue}>{text(value,'Not supplied').replaceAll('_',' ')}</Text></View>)}
      </View>
      <Text style={styles.detailHeading}>Activity chronology</Text>{selected.raw?.history?.length?selected.raw.history.map((entry:Record<string,unknown>)=><View key={text(entry.id)} style={styles.screeningLine}><Text style={styles.rowTitle}>{text(entry.type).replaceAll('_',' ')}</Text><Text style={styles.rowDetail}>{text(entry.organisation,'Explanation provided')} · {text(entry.startDate)} — {text(entry.endDate,'Present')}</Text></View>):<Text style={styles.rowDetail}>No activity periods supplied.</Text>}
      {selected.raw?.requirements?.chronology?.gaps?.map((gap:Record<string,unknown>)=><View key={`${text(gap.from)}-${text(gap.to)}`} style={styles.screeningWarning}><Text style={styles.screeningWarningTitle}>Unexplained period</Text><Text style={styles.rowDetail}>{text(gap.from)} — {text(gap.to)}</Text></View>)}
      <Text style={styles.detailHeading}>Addresses</Text>{selected.raw?.addresses?.map((entry:Record<string,unknown>)=><View key={text(entry.id)} style={styles.screeningLine}><Text style={styles.rowTitle}>{entry.isCurrent?'Current address':'Previous address'} · {text(entry.verificationState).replaceAll('_',' ')}</Text><Text style={styles.rowDetail}>{text(entry.address)} · {text(entry.startDate)} — {text(entry.endDate,'Present')}</Text></View>)}
      <Text style={styles.detailHeading}>References & evidence</Text><Text style={styles.rowDetail}>{screeningReferences.length} reference(s) · {text(selected.raw?.evidence?.length,'0')} private evidence record(s). Verification remains reviewer controlled; storage identifiers and signed URLs are not displayed.</Text>
      {selected.raw?.requirements?.missing?.length?<View style={styles.screeningWarning}><Text style={styles.screeningWarningTitle}>Requires attention</Text>{selected.raw.requirements.missing.map((item:string)=><Text key={item} style={styles.rowDetail}>• {item}</Text>)}</View>:null}
      {reviewReadiness?<View style={reviewReadiness.ready?styles.readinessReady:styles.readinessBlocked}><Text style={reviewReadiness.ready?styles.reviewSuccessTitle:styles.screeningWarningTitle}>SCREENING COMPLETION READINESS</Text><Text style={styles.rowTitle}>{reviewReadiness.ready?'Ready to complete':'Not ready to complete'}</Text>{reviewReadiness.blockers.map(blocker=><View key={blocker.key}><Text style={styles.rowDetail}>• {blocker.detail}</Text>{blocker.key==='reference_verification'?<Pressable style={styles.approveButton} onPress={openReferences}><Text style={styles.approveText}>Review references</Text></Pressable>:null}</View>)}<Text style={styles.reasonHelp}>Address verification scope: current address only. Historical address rows establish chronology and are not individually required to be VERIFIED.</Text></View>:null}
      </>:null}
      {/* One vetting session, not five: a completed check hands straight over to the next one the
          backend says is actionable, without a trip back through the checklist or the queue. */}
      {completedCheck?<View style={styles.readinessReady}>
        <Text style={styles.reviewSuccessTitle}>✓ {completedCheck.label} verified</Text>
        <Text style={styles.rowDetail}>{checksRemaining===0?'No checks remaining.':`${checksRemaining} check${checksRemaining===1?'':'s'} remaining.`}</Text>
        {reviewReadiness?.ready&&selected.status==='UNDER_REVIEW'?<>
          <Text style={styles.reviewSuccessTitle}>✓ All required checks complete</Text>
          <Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>{setCompletedCheck(null);setReviewCategory(null);setReferencesOpen(false);setReviewReasonAction('complete');setReviewReason('');setReviewFeedback(null);}}><Text style={styles.approveText}>Mark Guard Vetted</Text></Pressable>
        </>:nextCheck?<Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>openCheck(nextCheck.key)}><Text style={styles.approveText}>Review next: {nextCheck.label}</Text></Pressable>:null}
        <Pressable accessibilityRole="button" onPress={leaveFocusedTask}><Text style={styles.collapseToggle}>Back to checklist</Text></Pressable>
      </View>:null}
      {referencesOpen&&!completedCheck?<View style={styles.evidenceReviewPanel}><View style={styles.reviewPanelHeading}><View><Text style={styles.detailHeading}>REFERENCES</Text><Text style={styles.rowDetail}>{screeningReferences.length} submitted · {sourceVerifiedReferences} source verified. At least one source-verified reference is required.</Text></View><Pressable onPress={()=>{setReferencesOpen(false);setReferenceReviewId(null);}}><Text style={styles.retry}>Close references</Text></Pressable></View>{screeningReferences.map(reference=><View key={reference.id} style={styles.screeningLine}><Text style={styles.rowTitle}>{text(reference.contactPerson,'Referee')} · {text(reference.organisation)}</Text><Text style={styles.rowDetail}>Relationship: {text(reference.relationship)} · Email: {text(reference.businessEmail)} · Phone: {text(reference.phone,'Not supplied')}</Text><Text style={styles.rowDetail}>Activity: {text(reference.history?.type,'Not linked')} · {text(reference.history?.organisation,'Organisation not recorded')} · {text(reference.history?.startDate)} — {text(reference.history?.endDate,reference.history?.isCurrent?'Present':'Not recorded')}</Text><Text style={styles.status}>{reference.status==='NOT_REQUESTED'?'NOT VERIFIED':reference.status==='REQUESTED'||reference.status==='RECEIVED'?'AWAITING RESPONSE':reference.status==='SOURCE_VERIFICATION_REQUIRED'?'REQUIRES ATTENTION':reference.status}</Text>{reference.verifiedAt?<Text style={styles.rowDetail}>Reviewed {date(reference.verifiedAt)} · Method: {text(reference.verificationMethod)}</Text>:null}{reviewerActionable?<View style={styles.grid}><Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>beginReferenceReview(Number(reference.id))}><Text style={styles.approveText}>Review reference</Text></Pressable><Pressable disabled={!!reviewAction} onPress={()=>runReviewAction(`request-reference-${reference.id}`,()=>requestScreeningReference(Number(selected.id),Number(reference.id)),'Reference request recorded; awaiting response.')}><Text style={styles.retry}>Mark request sent</Text></Pressable></View>:null}{referenceReviewId===Number(reference.id)?<View style={styles.reasonPanel}><Text style={styles.rowTitle}>Controlled reference decision</Text><Text style={styles.rowDetail}>Inspect the submitted source details. Candidate submission alone is not verification.</Text><Text style={styles.rowDetail}>Candidate claims: {text(reference.history?.type).replaceAll('_',' ').toLowerCase()} at {text(reference.organisation)}, {text(reference.history?.startDate)} — {text(reference.history?.endDate,reference.history?.isCurrent?'Present':'Not recorded')}</Text><View style={styles.grid}>{(['VERIFIED','DISCREPANCY','SOURCE_VERIFICATION_REQUIRED','UNABLE_TO_VERIFY','REJECTED'] as const).map(decision=><Pressable key={decision} style={[styles.approveButton,referenceDecision!==decision&&styles.disabledButton]} onPress={()=>{setReferenceDecision(decision);setReferenceConfirm(false);}}><Text style={styles.approveText}>{decision==='VERIFIED'?'Confirmed':decision==='DISCREPANCY'?'Discrepancy':decision==='UNABLE_TO_VERIFY'?'Unable to verify':decision==='REJECTED'?'Reject':'Request clarification'}</Text></Pressable>)}</View><TextInput accessibilityLabel="Reference verification method" placeholder="Verification method" value={referenceMethod} onChangeText={setReferenceMethod} style={styles.search}/>
{/* A confirmed outcome has to say what the referee actually confirmed, which is the only way a
    discrepancy can be recorded against the dates it disputes. */}
{referenceDecision==='VERIFIED'||referenceDecision==='DISCREPANCY'?<>
  <Text style={styles.rowTitle}>Reference confirmed</Text>
  <Text style={styles.reasonHelp}>Record what the referee confirmed, which may differ from the candidate claim above. Dates are DD/MM/YYYY.</Text>
  {/* Copying the claim is a deliberate, labelled action — never a silent default. */}
  <Pressable accessibilityRole="button" onPress={()=>{setConfirmedStart(formatScreeningDate(reference.history?.startDate));setConfirmedCurrent(!!reference.history?.isCurrent);setConfirmedEnd(reference.history?.isCurrent?'':formatScreeningDate(reference.history?.endDate));setConfirmedError(null);}}><Text style={styles.retry}>Copy candidate claim into these fields</Text></Pressable>
  <TextInput accessibilityLabel="Confirmed start date" placeholder="Confirmed start date (DD/MM/YYYY)" value={confirmedStart} onChangeText={(value:string)=>{setConfirmedStart(value);setConfirmedError(null);}} style={styles.search}/>
  {confirmedError?.field==='start'?<Text style={styles.error}>{confirmedError.message}</Text>:null}
  <Pressable accessibilityRole="checkbox" accessibilityState={{checked:confirmedCurrent}} onPress={()=>{setConfirmedCurrent(value=>!value);setConfirmedEnd('');setConfirmedError(null);}}><Text style={styles.retry}>{confirmedCurrent?'☑ Still current':'☐ Still current'}</Text></Pressable>
  {!confirmedCurrent?<><TextInput accessibilityLabel="Confirmed end date" placeholder="Confirmed end date (DD/MM/YYYY)" value={confirmedEnd} onChangeText={(value:string)=>{setConfirmedEnd(value);setConfirmedError(null);}} style={styles.search}/>
  {confirmedError?.field==='end'?<Text style={styles.error}>{confirmedError.message}</Text>:null}</>:null}
</>:null}<TextInput accessibilityLabel="Reference reviewer note" placeholder="Reviewer note or clarification required" value={referenceNotes} onChangeText={setReferenceNotes} multiline style={styles.search}/><Pressable onPress={()=>setReferenceConfirm(value=>!value)}><Text style={styles.retry}>{referenceConfirm?'✓ Decision confirmed':'Confirm that reference details were inspected'}</Text></Pressable><Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={submitReferenceDecision}><Text style={styles.approveText}>{reviewAction===`reference-${reference.id}`?'Saving decision…':'Record reference decision'}</Text></Pressable></View>:null}</View>)}{!screeningReferences.length?<View style={styles.screeningWarning}><Text style={styles.screeningWarningTitle}>No references submitted</Text><Text style={styles.rowDetail}>The candidate must provide a reference before source verification can occur.</Text></View>:null}</View>:null}
      {reviewCategory&&!completedCheck?<View style={styles.evidenceReviewPanel}><View style={styles.reviewPanelHeading}><View><Text style={styles.detailHeading}>REVIEW {reviewCategory==='rtw'?'RIGHT TO WORK':reviewCategory.toUpperCase()}</Text><Text style={styles.rowDetail}>Inspect the candidate information and at least one matching evidence item before confirming verification.</Text></View><Pressable onPress={()=>{setReviewCategory(null);setInspectedEvidenceId(null);setVerificationConfirm(false);}}><Text style={styles.retry}>Cancel</Text></Pressable></View>
        {reviewCategory==='identity'?<View style={styles.submittedDetails}><Text style={styles.rowTitle}>Submitted identity details</Text><Text style={styles.rowDetail}>Name: {text(selected.raw?.legalFullName)} · Date of birth: {text(selected.raw?.dateOfBirth)} · Nationality: {text(selected.raw?.nationality)} · Previous names: {text(selected.raw?.previousNames,'None supplied')}</Text></View>:null}
        {reviewCategory==='address'?<View style={styles.submittedDetails}><Text style={styles.rowTitle}>Address being verified</Text><Text style={styles.rowDetail}>{text(currentReviewAddress?.address)} · {text(currentReviewAddress?.startDate)} — {text(currentReviewAddress?.endDate,'Present')}</Text></View>:null}
        {reviewCategory==='sia'?<View style={styles.submittedDetails}><Text style={styles.rowTitle}>Submitted SIA information</Text><Text style={styles.rowDetail}>Licence number: {text(selected.raw?.guard?.siaLicenseNumber)} · Expiry: {text(selected.raw?.guard?.siaExpiryDate)} · Current reviewer status: {text(selected.raw?.siaRegisterVerification)}</Text><Pressable accessibilityRole="link" onPress={()=>Linking.openURL('https://www.gov.uk/check-a-private-security-licence')}><Text style={styles.retry}>Check SIA register ↗</Text></Pressable><Text style={styles.reasonHelp}>External official register check; no automatic verification is performed.</Text></View>:null}
        {reviewCategory==='rtw'?<View style={styles.submittedDetails}><Text style={styles.rowTitle}>Submitted Right to Work information</Text><Text style={styles.rowDetail}>Status/type: {text(selected.raw?.guard?.rightToWorkStatus)} · Expiry: {text(selected.raw?.guard?.rightToWorkExpiryDate,'Not applicable or not supplied')} · Current reviewer status: {text(selected.raw?.rightToWorkVerification)} · Existing check method: {text(selected.raw?.rightToWorkCheckMethod,'Not yet recorded')}</Text></View>:null}
        <Text style={styles.rowTitle}>Submitted {reviewEvidenceCategory?.replaceAll('_',' ')} evidence</Text>{reviewEvidence.length?reviewEvidence.map((entry:Record<string,any>)=><View key={entry.id} style={styles.evidenceRow}><View style={styles.rowCopy}><Text style={styles.rowTitle}>{text(entry.originalFileName,`Evidence #${entry.id}`)}</Text><Text style={styles.rowDetail}>{text(entry.mimeType)} · {Math.ceil(Number(entry.sizeBytes||0)/1024)} KB · Uploaded {date(entry.uploadedAt)}</Text><Text style={styles.rowDetail}>Reviewer state: {text(entry.verificationState,'UNVERIFIED').replaceAll('_',' ')}{entry.verifiedAt?` · decided ${date(entry.verifiedAt)}`:''}</Text></View><Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>openEvidence({id:Number(entry.id),category:String(entry.category),mimeType:String(entry.mimeType)})}><Text style={styles.approveText}>{reviewAction===`evidence-${entry.id}`?'Opening…':inspectedEvidenceId===entry.id?'Reviewed — open again':'View document'}</Text></Pressable></View>):<View style={styles.screeningWarning}><Text style={styles.screeningWarningTitle}>No completed matching evidence</Text><Text style={styles.rowDetail}>Verification is unavailable until the candidate supplies this evidence.</Text></View>}
        {!verificationConfirm?<Pressable disabled={!inspectedEvidenceId||!!reviewAction} style={[styles.approveButton,(!inspectedEvidenceId||reviewAction)&&styles.disabledButton]} onPress={()=>setVerificationConfirm(true)}><Text style={styles.approveText}>Continue to verification</Text></Pressable>:<View style={styles.confirmPanel}><Text style={styles.rowTitle}>Confirm reviewer decision</Text><Text style={styles.rowDetail}>Confirm that you inspected evidence #{inspectedEvidenceId} and completed the appropriate external or document checks. Upload alone is not verification.</Text><Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={async()=>{const label=reviewCategory==='rtw'?'Right to Work':reviewCategory[0].toUpperCase()+reviewCategory.slice(1);if(inspectedEvidenceId&&await runReviewAction(`verify-${reviewCategory}`,()=>verifyScreeningCheck(Number(selected.id),reviewCategory,inspectedEvidenceId),`${label} verified successfully.`)){setVerificationConfirm(false);setCompletedCheck({key:reviewCategory,label});}}}><Text style={styles.approveText}>{reviewAction===`verify-${reviewCategory}`?'Verifying…':`Confirm Verify ${reviewCategory==='rtw'?'RTW':reviewCategory.toUpperCase()}`}</Text></Pressable><Pressable disabled={!!reviewAction} style={[styles.rejectButton,reviewAction&&styles.disabledButton]} onPress={async()=>{if(inspectedEvidenceId&&await runReviewAction(`reject-${reviewCategory}`,()=>verifyScreeningCheck(Number(selected.id),reviewCategory,inspectedEvidenceId,'REJECTED'),`${reviewCategory==='rtw'?'Right to Work':reviewCategory[0].toUpperCase()+reviewCategory.slice(1)} evidence rejected. The candidate must supply replacement evidence.`))setVerificationConfirm(false);}}><Text style={styles.approveText}>{reviewAction===`reject-${reviewCategory}`?'Rejecting…':'Reject evidence'}</Text></Pressable><Pressable onPress={()=>setVerificationConfirm(false)}><Text style={styles.retry}>Back to evidence review</Text></Pressable></View>}
      </View>:null}
      {reviewFeedback?<View accessibilityLiveRegion="polite" style={reviewFeedback.tone==='success'?styles.reviewSuccess:styles.reviewFailure}><Text style={reviewFeedback.tone==='success'?styles.reviewSuccessTitle:styles.reviewFailureTitle}>{reviewFeedback.tone==='success'?'SUCCESS':'ACTION FAILED'}</Text><Text style={styles.rowDetail}>{reviewFeedback.message}</Text></View>:null}
      {reasonCopy?<View style={styles.reasonPanel}><Text style={styles.rowTitle}>{reasonCopy.label}</Text><Text style={styles.reasonHelp}>{reasonCopy.help} Required.</Text><TextInput accessibilityLabel={reasonCopy.label} placeholder={reasonCopy.label} value={reviewReason} onChangeText={setReviewReason} style={styles.search}/><View style={styles.grid}><Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={submitReasonAction}><Text style={styles.approveText}>{reviewAction?`${reasonCopy.button}…`:reasonCopy.button}</Text></Pressable><Pressable onPress={()=>{setReviewReasonAction(null);setReviewReason('');}}><Text style={styles.retry}>Cancel</Text></Pressable></View></View>:null}<View style={styles.grid}>
        {selected.status==='READY_FOR_REVIEW'?<Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>runReviewAction('start',()=>startScreeningReview(Number(selected.id)),'Review started successfully.')}><Text style={styles.approveText}>{reviewAction==='start'?'Starting…':'Start review'}</Text></Pressable>:null}
        {/* The per-check entry points live in YOUR ACTIONS, which lists only the checks that
            actually need one. A second always-on row of them here is what the owner saw twice. */}
        {['READY_FOR_REVIEW','UNDER_REVIEW'].includes(selected.status||'')?<Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>{setReviewReasonAction('request');setReviewReason('');setReviewFeedback(null);}}><Text style={styles.approveText}>Request information</Text></Pressable>:null}
        {selected.status==='UNDER_REVIEW'?<Pressable disabled={!!reviewAction||!reviewReadiness?.ready} style={[styles.approveButton,(reviewAction||!reviewReadiness?.ready)&&styles.disabledButton]} onPress={()=>{setReviewReasonAction('complete');setReviewReason('');setReviewFeedback(null);}}><Text style={styles.approveText}>Complete screening</Text></Pressable>:null}
        {['READY_FOR_REVIEW','UNDER_REVIEW'].includes(selected.status||'')?<Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>{setReviewReasonAction('reject');setReviewReason('');setReviewFeedback(null);}}><Text style={styles.approveText}>Reject</Text></Pressable>:null}
        {selected.status==='VETTED'?<Pressable disabled={!!reviewAction} style={[styles.approveButton,reviewAction&&styles.disabledButton]} onPress={()=>{setReviewReasonAction('expire');setReviewReason('');setReviewFeedback(null);}}><Text style={styles.approveText}>Mark expired</Text></Pressable>:null}
      </View></>:null}<Pressable onPress={() => { if(section==='screening')backToQueue(); else setSelected(null); }}><Text style={styles.retry}>{section==='screening'?'Back to Screening Review':'Close detail'}</Text></Pressable></View> : null}
    {section !== 'overview' && section !== 'screening' && !loading && !error ? <View style={styles.list}>{visibleRows.map((row) => <Pressable accessibilityRole="button" accessibilityLabel={`Open ${row.title} detail`} onPress={() => {setSelected(row);setReviewReason('');setReviewReasonAction(null);setReviewFeedback(null);setReviewCategory(null);setInspectedEvidenceId(null);setVerificationConfirm(false);}} key={row.id} style={styles.row}><View style={styles.rowCopy}><Text style={styles.rowTitle}>{row.title}</Text><Text style={styles.rowDetail}>{row.detail}</Text></View>{row.status ? <Text style={styles.status}>{row.status}</Text> : null}</Pressable>)}</View> : null}
  </ScrollView></View>;
}

const styles = StyleSheet.create({
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filterChip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  filterChipActive: { backgroundColor: colors.primaryNavy, borderColor: colors.primaryNavy },
  filterChipText: { color: colors.textPrimary, fontWeight: '700' },
  filterChipTextActive: { color: colors.card, fontWeight: '800' },
  queueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 14 },
  queueAction: { color: colors.primaryNavy, fontWeight: '800' },
  backToQueue: { color: colors.primaryNavy, fontWeight: '800', marginBottom: 10 },
  attentionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 14 },
  waitingRow: { backgroundColor: colors.card, borderColor: colors.warningBorder ?? colors.border, borderWidth: 1, borderRadius: 12, padding: 14, gap: 4 },
  waitingLabel: { color: colors.textSecondary, fontWeight: '800', fontSize: 12, letterSpacing: 0.5 },
  collapseToggle: { color: colors.primaryNavy, fontWeight: '800', paddingVertical: 10 },
  shell: { flex: 1, flexDirection: 'row', backgroundColor: colors.background }, shellCompact: { flexDirection: 'column' }, sidebar: { width: 245, flexGrow: 0, backgroundColor: colors.primaryNavy }, sidebarContent: { padding: 18, gap: 5 }, brand: { color: colors.card, fontSize: 19, fontWeight: '800', marginBottom: 18 }, mobileNav: { flexGrow: 0, backgroundColor: colors.primaryNavy }, mobileNavContent: { padding: 10, gap: 6 }, navItem: { borderRadius: 9, paddingHorizontal: 12, paddingVertical: 10 }, navItemActive: { backgroundColor: colors.card }, navText: { color: colors.surfaceSubtle, fontWeight: '700' }, navTextActive: { color: colors.primaryNavy },
  content: { flex: 1 }, contentInner: { padding: 24, gap: 18 }, headingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16 }, headingCopy: { flex: 1 }, title: { color: colors.textPrimary, fontSize: 27, fontWeight: '800' }, subtitle: { color: colors.textSecondary, marginTop: 4 }, refreshButton: { backgroundColor: colors.primaryNavy, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 }, refreshText: { color: colors.card, fontWeight: '700' }, search: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11, color: colors.textPrimary },
  errorBox: { borderWidth: 1, borderColor: colors.dangerBorder, backgroundColor: colors.dangerSurface, borderRadius: 10, padding: 14, gap: 7 }, error: { color: colors.danger }, retry: { color: colors.primaryNavy, fontWeight: '800' }, loading: { color: colors.textSecondary, paddingVertical: 30, textAlign: 'center' }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 }, metricCard: { minWidth: 205, flexGrow: 1, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 16, padding: 20 }, cardLabel: { color: colors.textSecondary, fontWeight: '700' }, cardValue: { color: colors.textPrimary, fontSize: 30, fontWeight: '800', marginTop: 8 }, link: { color: colors.primaryNavy, fontWeight: '700', marginTop: 12 }, screeningReviewGrid:{flexDirection:'row',flexWrap:'wrap',gap:10},screeningCheck:{minWidth:180,flex:1,backgroundColor:colors.card,borderWidth:1,borderColor:colors.border,borderRadius:10,padding:12,gap:4},screeningCheckValue:{fontWeight:'800',color:colors.textPrimary,textTransform:'capitalize'},screeningLine:{borderLeftWidth:3,borderLeftColor:colors.accentTeal,paddingLeft:10,paddingVertical:5},screeningWarning:{backgroundColor:colors.warningSurface,borderWidth:1,borderColor:colors.warningBorder,borderRadius:10,padding:12,gap:4},screeningWarningTitle:{color:colors.warning,fontWeight:'800'},reviewSuccess:{backgroundColor:colors.successSurface,borderWidth:1,borderColor:colors.successBorder,borderRadius:10,padding:12,gap:3},reviewSuccessTitle:{color:colors.success,fontWeight:'800'},reviewFailure:{backgroundColor:colors.dangerSurface,borderWidth:1,borderColor:colors.dangerBorder,borderRadius:10,padding:12,gap:3},reviewFailureTitle:{color:colors.danger,fontWeight:'800'},reasonHelp:{color:colors.textSecondary,fontSize:12},disabledButton:{opacity:0.55},evidenceReviewPanel:{borderWidth:1,borderColor:colors.primaryNavy,borderRadius:12,backgroundColor:colors.card,padding:14,gap:12},reviewPanelHeading:{flexDirection:'row',justifyContent:'space-between',gap:12},submittedDetails:{backgroundColor:colors.background,borderRadius:9,padding:12,gap:6},evidenceRow:{flexDirection:'row',alignItems:'center',gap:12,borderWidth:1,borderColor:colors.border,borderRadius:9,padding:10},confirmPanel:{backgroundColor:colors.infoSurface,borderWidth:1,borderColor:colors.info,borderRadius:10,padding:12,gap:9},modalBackdrop:{flex:1,backgroundColor:'rgba(15,23,42,0.72)',alignItems:'center',justifyContent:'center',padding:20},imageModal:{width:'100%',maxWidth:900,height:'85%',backgroundColor:colors.card,borderRadius:14,padding:16,gap:10},evidenceImage:{flex:1,width:'100%',backgroundColor:colors.background},readinessReady:{backgroundColor:colors.successSurface,borderWidth:1,borderColor:colors.successBorder,borderRadius:10,padding:12,gap:5},readinessBlocked:{backgroundColor:colors.warningSurface,borderWidth:1,borderColor:colors.warningBorder,borderRadius:10,padding:12,gap:5},reasonPanel:{backgroundColor:colors.card,borderWidth:1,borderColor:colors.border,borderRadius:10,padding:12,gap:8},
  empty: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 28, alignItems: 'center' }, emptyTitle: { color: colors.textPrimary, fontWeight: '800', fontSize: 17 }, emptyText: { color: colors.textSecondary, marginTop: 7, textAlign: 'center' }, detailPanel: { backgroundColor: colors.background, borderColor: colors.primaryNavy, borderWidth: 1, borderRadius: 12, padding: 16, gap: 8 }, detailHeading: { color: colors.textPrimary, fontWeight: '800', fontSize: 18 }, list: { gap: 10 }, row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 15 }, rowCopy: { minWidth: 220, flex: 1 }, rowTitle: { color: colors.textPrimary, fontWeight: '800' }, rowDetail: { color: colors.textSecondary, marginTop: 5, lineHeight: 20 }, status: { overflow: 'hidden', color: colors.primaryNavy, backgroundColor: colors.surfaceSubtle, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, fontWeight: '700' }, approveButton: { backgroundColor: colors.primaryNavy, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }, rejectButton: { backgroundColor: colors.danger, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }, approveText: { color: colors.card, fontWeight: '800' },
});
