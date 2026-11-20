import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
// Phase 2D: the shared flat Profile card, as in every other Profile section. UX-02 Package B: the shared primary button.
import { ProfileCard, ProfilePrimaryButton } from '../components/guard/profile/ProfileCard';
import { ApiError, formatApiErrorMessage, listMyAvailabilityOverrides, listMyAvailabilityRules, listMyGuardLeave, listMyLeaveCompanies, saveAvailabilityOverride, saveAvailabilityRule, saveMyGuardLeave } from '../services/api';
import { buildNewLeavePayload, canSubmitLeave, LEAVE_COPY, LeaveCompanyState, leaveCompanyStateFromError, leaveCompanyStateFromList, leaveErrorCode, refusalNeedsCompanyReload, showsCompanySelector, validSelection } from '../components/guard/guardLeaveCompany';
import { GuardAvailabilityOverride, GuardAvailabilityRule, GuardLeave } from '../types/models';
import { colors, control, radii, spacing, typography } from '../theme';
import { WEEKDAY_GAP, WEEKDAY_MIN_TARGET, weekdayColumns, weekdayRows } from '../components/guard/profile/profileAvailability';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function formatDate(value?: string | null) { if (!value) return 'Not set'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB'); }

type FeedbackArea = 'load' | 'weekly' | 'oneOff' | 'leave';

export function GuardAvailabilityScreen() {
  const [rules, setRules] = useState<GuardAvailabilityRule[]>([]);
  const [overrides, setOverrides] = useState<GuardAvailabilityOverride[]>([]);
  const [leaveRows, setLeaveRows] = useState<GuardLeave[]>([]);
  const [ruleForm, setRuleForm] = useState({ weekday: '1', startTime: '09:00', endTime: '17:00', isAvailable: 'true' });
  const [overrideForm, setOverrideForm] = useState({ date: '', startTime: '', endTime: '', status: 'unavailable', note: '' });
  const [leaveForm, setLeaveForm] = useState({ leaveType: 'annual_leave', startAt: '', endAt: '', reason: '' });
  // UX-02 Package B: feedback is shown beside the action that produced it (not only at the top of a long screen).
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string; area: FeedbackArea } | null>(null);
  const [loading, setLoading] = useState(false);
  // Which company a leave request goes to (SEC-001B 2B): a selector only when the guard has several ACTIVE employers.
  const [leaveCompanies, setLeaveCompanies] = useState<LeaveCompanyState>({ kind: 'loading' });
  const [leaveCompanyId, setLeaveCompanyId] = useState<number | null>(null);
  const { width, fontScale } = useWindowDimensions();
  const dayRows = weekdayRows(weekdayColumns(width, fontScale));

  async function loadData() { setLoading(true); try { const [nextRules, nextOverrides, nextLeave] = await Promise.all([listMyAvailabilityRules(), listMyAvailabilityOverrides(), listMyGuardLeave()]); setRules(nextRules); setOverrides(nextOverrides); setLeaveRows(nextLeave); } catch (error) { setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load availability records.'), area: 'load' }); } finally { setLoading(false); } }
  async function loadLeaveCompanies() { setLeaveCompanies({ kind: 'loading' }); try { const next = leaveCompanyStateFromList(await listMyLeaveCompanies()); setLeaveCompanies(next); setLeaveCompanyId(current => validSelection(next, current)); } catch (error) { setLeaveCompanies(leaveCompanyStateFromError(error instanceof ApiError ? error.status : undefined, error instanceof ApiError ? error.body : undefined)); setLeaveCompanyId(null); } }
  useEffect(() => { loadData(); loadLeaveCompanies(); }, []);
  async function handleSaveRule() { try { await saveAvailabilityRule({ weekday: Number(ruleForm.weekday), startTime: ruleForm.startTime, endTime: ruleForm.endTime, isAvailable: ruleForm.isAvailable === 'true' }, true); setFeedback({ tone: 'success', message: 'Weekly availability saved.', area: 'weekly' }); await loadData(); } catch (error) { setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save availability.'), area: 'weekly' }); } }
  async function handleSaveOverride() { try { await saveAvailabilityOverride({ date: overrideForm.date, startTime: overrideForm.startTime || null, endTime: overrideForm.endTime || null, status: overrideForm.status, note: overrideForm.note || null }, true); setOverrideForm({ date: '', startTime: '', endTime: '', status: 'unavailable', note: '' }); setFeedback({ tone: 'success', message: 'One-off availability saved.', area: 'oneOff' }); await loadData(); } catch (error) { setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save one-off availability.'), area: 'oneOff' }); } }
  async function handleSaveLeave() { const built = buildNewLeavePayload(leaveForm, leaveCompanies, leaveCompanyId); if (!built.ok) { setFeedback({ tone: 'error', message: built.message, area: 'leave' }); return; } try { await saveMyGuardLeave(built.payload); setLeaveForm({ leaveType: 'annual_leave', startAt: '', endAt: '', reason: '' }); setLeaveCompanyId(null); setFeedback({ tone: 'success', message: 'Leave request saved for company review.', area: 'leave' }); await loadData(); } catch (error) { setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to save leave request.'), area: 'leave' }); if (error instanceof ApiError && refusalNeedsCompanyReload(leaveErrorCode(error.body))) await loadLeaveCompanies(); } }

  const feedbackFor = (area: FeedbackArea) => feedback && feedback.area === area
    ? <View style={[styles.feedback, feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess]} accessibilityLiveRegion="polite"><Text style={styles.feedbackText} accessibilityRole={feedback.tone === 'error' ? 'alert' : 'text'}>{feedback.message}</Text></View>
    : null;

  return <View style={styles.root}>
    {feedbackFor('load')}
    <ProfileCard title="Weekly availability" subtitle="Your normal working week.">
      <View style={styles.dayGrid}>{dayRows.map((row, r) => <View key={r} style={styles.dayRow}>
        {row.map((i) => { const selected = ruleForm.weekday === String(i); return <Pressable key={WEEKDAYS[i]} onPress={() => setRuleForm(p => ({...p, weekday:String(i)}))} accessibilityRole="button" accessibilityLabel={WEEKDAY_NAMES[i]} accessibilityState={{ selected }} style={[styles.dayChip, selected && styles.dayChipActive]}><Text style={[styles.dayChipText, selected && styles.dayChipTextActive]}>{WEEKDAYS[i]}</Text></Pressable>; })}
        {row.length < dayRows[0].length ? <View style={styles.daySpacer} /> : null}
      </View>)}</View>
      <View style={styles.grid}><Field label="Start time" value={ruleForm.startTime} placeholder="09:00" onChangeText={(startTime:string)=>setRuleForm(p=>({...p,startTime}))}/><Field label="End time" value={ruleForm.endTime} placeholder="17:00" onChangeText={(endTime:string)=>setRuleForm(p=>({...p,endTime}))}/></View>
      <View style={styles.choiceRow}><Pressable onPress={()=>setRuleForm(p=>({...p,isAvailable:'true'}))} style={[styles.choice,ruleForm.isAvailable==='true'&&styles.choiceActive]}><Text style={[styles.choiceText,ruleForm.isAvailable==='true'&&styles.choiceTextActive]}>Available</Text></Pressable><Pressable onPress={()=>setRuleForm(p=>({...p,isAvailable:'false'}))} style={[styles.choice,ruleForm.isAvailable==='false'&&styles.choiceActive]}><Text style={[styles.choiceText,ruleForm.isAvailable==='false'&&styles.choiceTextActive]}>Unavailable</Text></Pressable></View>
      <ProfilePrimaryButton label="Save weekly availability" onPress={handleSaveRule}/>
      {feedbackFor('weekly')}
      <View style={styles.list}>{loading?<Text style={styles.empty}>Loading availability…</Text>:rules.length===0?<Text style={styles.empty}>No weekly availability saved yet.</Text>:rules.map(rule=><View key={rule.id} style={styles.row}><View><Text style={styles.rowTitle}>{WEEKDAYS[rule.weekday]||`Day ${rule.weekday}`}</Text><Text style={styles.meta}>{rule.startTime}–{rule.endTime}</Text></View><Status value={rule.isAvailable?'Available':'Unavailable'}/></View>)}</View>
    </ProfileCard>

    <ProfileCard title="One-off change" subtitle="Change one date without altering your normal week.">
      <View style={styles.grid}><Field label="Date" value={overrideForm.date} placeholder="YYYY-MM-DD" onChangeText={(date:string)=>setOverrideForm(p=>({...p,date}))}/><Field label="Start (optional)" value={overrideForm.startTime} placeholder="HH:mm" onChangeText={(startTime:string)=>setOverrideForm(p=>({...p,startTime}))}/><Field label="End (optional)" value={overrideForm.endTime} placeholder="HH:mm" onChangeText={(endTime:string)=>setOverrideForm(p=>({...p,endTime}))}/></View>
      <View style={styles.choiceRow}>{['available','unavailable'].map(status=><Pressable key={status} onPress={()=>setOverrideForm(p=>({...p,status}))} style={[styles.choice,overrideForm.status===status&&styles.choiceActive]}><Text style={[styles.choiceText,overrideForm.status===status&&styles.choiceTextActive]}>{status==='available'?'Available':'Unavailable'}</Text></Pressable>)}</View>
      <Field label="Note (optional)" value={overrideForm.note} placeholder="Add context for your company" onChangeText={(note:string)=>setOverrideForm(p=>({...p,note}))}/>
      <ProfilePrimaryButton label="Save one-off change" onPress={handleSaveOverride}/>
      {feedbackFor('oneOff')}
      <View style={styles.list}>{overrides.length===0&&!loading?<Text style={styles.empty}>No one-off changes saved.</Text>:overrides.slice(0,5).map(o=><View key={o.id} style={styles.row}><View><Text style={styles.rowTitle}>{formatDate(o.date)}</Text><Text style={styles.meta}>{o.startTime||'All day'}–{o.endTime||'All day'}</Text></View><Status value={o.status}/></View>)}</View>
    </ProfileCard>

    <ProfileCard title="Leave" subtitle="Your company reviews each request.">
      {leaveCompanies.kind === 'none' ? <View style={styles.field}><Text style={styles.label}>No active company</Text><Text style={styles.meta}>{LEAVE_COPY.noActiveEmployer}</Text></View> : <>
      {leaveCompanies.kind === 'loading' ? <Text style={styles.meta}>{LEAVE_COPY.loading}…</Text> : null}
      {leaveCompanies.kind === 'error' ? <View style={styles.inlineNotice}><Text style={[styles.meta, styles.flex]}>{LEAVE_COPY.loadError}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry loading your companies" onPress={loadLeaveCompanies} style={({pressed}:any)=>[styles.retry,pressed&&styles.pressed]}><Text style={styles.secondaryText}>{LEAVE_COPY.retry}</Text></Pressable></View> : null}
      {leaveCompanies.kind === 'multiple' && showsCompanySelector(leaveCompanies) ? <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel={LEAVE_COPY.selectorLabel}><Text style={styles.label}>{LEAVE_COPY.selectorLabel}</Text><Text style={styles.meta}>{LEAVE_COPY.selectorHint}</Text><View style={styles.choiceRow}>{leaveCompanies.companies.map(company => { const selected = leaveCompanyId === company.companyId; return <Pressable key={company.companyId} accessibilityRole="radio" accessibilityState={{ checked: selected, selected }} accessibilityLabel={company.name} onPress={() => setLeaveCompanyId(company.companyId)} style={[styles.choice, styles.companyChoice, selected && styles.choiceActive]}><Text style={[styles.choiceText, selected && styles.choiceTextActive]}>{company.name}</Text></Pressable>; })}</View></View> : null}
      <View style={styles.grid}><Field label="Leave type" value={leaveForm.leaveType} placeholder="annual_leave" onChangeText={(leaveType:string)=>setLeaveForm(p=>({...p,leaveType}))}/><Field label="Start" value={leaveForm.startAt} placeholder="Date / ISO" onChangeText={(startAt:string)=>setLeaveForm(p=>({...p,startAt}))}/><Field label="End" value={leaveForm.endAt} placeholder="Date / ISO" onChangeText={(endAt:string)=>setLeaveForm(p=>({...p,endAt}))}/></View>
      <Field label="Reason (optional)" value={leaveForm.reason} placeholder="Add a short reason" onChangeText={(reason:string)=>setLeaveForm(p=>({...p,reason}))}/>
      <ProfilePrimaryButton label="Request leave" onPress={handleSaveLeave} disabled={!canSubmitLeave(leaveCompanies, leaveCompanyId)}/>
      </>}
      {feedbackFor('leave')}
      <View style={styles.list}>{leaveRows.length===0&&!loading?<Text style={styles.empty}>No leave requests yet.</Text>:leaveRows.slice(0,5).map(l=><View key={l.id} style={styles.row}><View style={styles.flex}><Text style={styles.rowTitle}>{String(l.leaveType).replace(/_/g,' ')}</Text><Text style={styles.meta}>{formatDate(l.startAt)} to {formatDate(l.endAt)}</Text></View><Status value={l.status}/></View>)}</View>
    </ProfileCard>
  </View>;
}

function Field({label,...props}:{label:string;[key:string]:any}){return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} {...props} placeholderTextColor={colors.fieldPlaceholder} style={styles.input}/></View>}
function Status({value}:{value:string}){const positive=value.toLowerCase().includes('available')&&!value.toLowerCase().includes('unavailable')||value.toLowerCase().includes('approved');return <View style={[styles.status,positive?styles.statusGood:styles.statusNeutral]}><Text style={[styles.statusText,positive?styles.statusGoodText:styles.statusNeutralText]}>{value.replace(/_/g,' ')}</Text></View>}

const styles=StyleSheet.create({root:{width:'100%',gap:spacing.md},grid:{flexDirection:'row',flexWrap:'wrap',gap:spacing.md},field:{minWidth:145,flexGrow:1,flexBasis:'30%',gap:6},label:{color:colors.textPrimary,...typography.label},input:{minHeight:control.inputHeight,borderWidth:1,borderColor:colors.fieldBorder,borderRadius:radii.md,paddingHorizontal:spacing.md,color:colors.textPrimary,backgroundColor:colors.card,...typography.body},dayGrid:{gap:WEEKDAY_GAP},dayRow:{flexDirection:'row',gap:WEEKDAY_GAP},dayChip:{flex:1,flexBasis:0,minWidth:WEEKDAY_MIN_TARGET,minHeight:WEEKDAY_MIN_TARGET,alignItems:'center',justifyContent:'center',borderRadius:radii.md,borderWidth:1,borderColor:colors.border,backgroundColor:colors.card,paddingHorizontal:4},daySpacer:{flex:1,flexBasis:0,minWidth:WEEKDAY_MIN_TARGET},dayChipActive:{backgroundColor:colors.accentTealSoft,borderColor:colors.accentTealStrong},dayChipText:{color:colors.textSecondary,...typography.label},dayChipTextActive:{color:colors.accentTealStrong},choiceRow:{flexDirection:'row',flexWrap:'wrap',gap:spacing.sm},choice:{minHeight:WEEKDAY_MIN_TARGET,justifyContent:'center',paddingHorizontal:spacing.lg,borderRadius:radii.pill,borderWidth:1,borderColor:colors.border},choiceActive:{backgroundColor:colors.accentTealSoft,borderColor:colors.accentTealStrong},choiceText:{color:colors.textSecondary,...typography.label},choiceTextActive:{color:colors.accentTealStrong},secondaryText:{color:colors.primaryNavy,...typography.label},pressed:{opacity:.82},companyChoice:{maxWidth:'100%',paddingVertical:spacing.sm},inlineNotice:{flexDirection:'row',flexWrap:'wrap',alignItems:'center',gap:spacing.sm},retry:{minHeight:WEEKDAY_MIN_TARGET,justifyContent:'center',paddingHorizontal:spacing.md},list:{gap:spacing.sm},empty:{color:colors.textSecondary,...typography.caption},row:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:spacing.md,borderTopWidth:1,borderTopColor:colors.border,paddingVertical:spacing.sm},rowTitle:{color:colors.textPrimary,...typography.label,textTransform:'capitalize'},meta:{color:colors.textSecondary,...typography.caption,marginTop:2},status:{borderRadius:radii.pill,paddingHorizontal:spacing.sm,paddingVertical:spacing.xs},statusGood:{backgroundColor:colors.successSurface},statusNeutral:{backgroundColor:colors.pendingSurface},statusText:{...typography.caption,fontWeight:'700',textTransform:'capitalize'},statusGoodText:{color:colors.success},statusNeutralText:{color:colors.pending},feedback:{borderRadius:radii.md,padding:spacing.md},feedbackError:{backgroundColor:colors.dangerSurface},feedbackSuccess:{backgroundColor:colors.successSurface},feedbackText:{color:colors.textPrimary,...typography.label},flex:{flex:1}});
