import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { ADMIN_NAV_ITEMS, type AdminSection, adminPortalError, matchesAdminSearch } from '../navigation/admin-portal';
import { isGuardProfileComplete } from '../navigation/guard-lifecycle';
import {
  getHealthLive, getHealthReady, listAssignments, listAuditLogs, listCompanies,
  listCompanyAttendance, listCompanyDailyLogs, listCompanyIncidents, listCompanyNotifications,
  listCompanySafetyAlerts, listGuards, listJobApplications, listJobs, listShifts, listSites, listTimesheets,
} from '../services/api';
import { colors } from '../theme';

type DisplayRow = { id: string; title: string; detail: string; status?: string };
type Loader = () => Promise<unknown[]>;
const text = (value: unknown, fallback = 'Not recorded') => value === null || value === undefined || value === '' ? fallback : String(value);
const date = (value: unknown) => value ? new Date(String(value)).toLocaleString() : 'Not recorded';

const loaders: Record<Exclude<AdminSection, 'overview'>, Loader> = {
  companies: listCompanies, guards: listGuards, sites: listSites, jobs: listJobs,
  applications: listJobApplications, assignments: listAssignments, shifts: listShifts,
  attendance: listCompanyAttendance, timesheets: listTimesheets, incidents: listCompanyIncidents,
  alerts: listCompanySafetyAlerts, dailyLogs: listCompanyDailyLogs, audit: listAuditLogs,
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
    case 'audit': return { id, title: text(row.action), detail: `${text(row.entityType)} #${text(row.entityId)} · ${text(row.user?.email, 'System actor')} · ${date(row.createdAt)}` };
    case 'notifications': return { id, title: text(row.title), detail: `${text(row.message)} · ${date(row.createdAt)}`, status: text(row.status) };
    case 'health': return { id, title: text(row.name), detail: `API response received · ${Object.keys(row).filter((key) => key !== 'id' && key !== 'name').map((key) => `${key}: ${text(row[key])}`).join(' · ')}`, status: 'available' };
  }
}

export function AdminDashboardScreen() {
  const compact = useWindowDimensions().width < 900;
  const [section, setSection] = useState<AdminSection>('overview');
  const [rows, setRows] = useState<DisplayRow[]>([]);
  const [overview, setOverview] = useState<{ section: AdminSection; count: number }[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DisplayRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (section === 'overview') {
        const keys: Exclude<AdminSection, 'overview'>[] = ['companies', 'guards', 'sites', 'jobs', 'shifts', 'incidents', 'alerts', 'audit'];
        const results = await Promise.all(keys.map((key) => loaders[key]()));
        setOverview(keys.map((key, index) => ({ section: key, count: results[index].length })));
      } else {
        const result = await loaders[section]();
        setRows(result.map((item, index) => displayRow(section, item, index)));
      }
    } catch (nextError) { setError(adminPortalError((nextError as { status?: number })?.status)); }
    finally { setLoading(false); }
  }, [section]);

  useEffect(() => { setQuery(''); setSelected(null); load(); }, [load]);
  const current = ADMIN_NAV_ITEMS.find((item) => item.key === section)!;
  const visibleRows = useMemo(() => rows.filter((row) => matchesAdminSearch([row.id, row.title, row.detail, row.status], query)), [rows, query]);

  const navigation = <ScrollView horizontal={compact} style={compact ? styles.mobileNav : styles.sidebar} contentContainerStyle={compact ? styles.mobileNavContent : styles.sidebarContent}>
    {!compact ? <Text style={styles.brand}>S4 Platform Admin</Text> : null}
    {ADMIN_NAV_ITEMS.map((item) => <Pressable key={item.key} accessibilityRole="button" accessibilityState={{ selected: item.key === section }} onPress={() => setSection(item.key)} style={[styles.navItem, item.key === section && styles.navItemActive]}><Text style={[styles.navText, item.key === section && styles.navTextActive]}>{item.label}</Text></Pressable>)}
  </ScrollView>;

  return <View style={[styles.shell, compact && styles.shellCompact]}>{navigation}<ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
    <View style={styles.headingRow}><View style={styles.headingCopy}><Text style={styles.title}>{current.label}</Text><Text style={styles.subtitle}>Global Platform Admin view · RC1 authorized capability</Text></View><Pressable style={styles.refreshButton} onPress={load} disabled={loading}><Text style={styles.refreshText}>{loading ? 'Loading…' : 'Refresh'}</Text></Pressable></View>
    {section !== 'overview' ? <TextInput accessibilityLabel="Search current admin view" value={query} onChangeText={setQuery} placeholder="Search this view" style={styles.search} /> : null}
    {error ? <View style={styles.errorBox}><Text style={styles.error}>{error}</Text><Pressable onPress={load}><Text style={styles.retry}>Retry</Text></Pressable></View> : null}
    {section === 'overview' && loading ? <Text style={styles.loading}>Loading Platform Admin overview…</Text> : null}
    {section === 'overview' && !error ? <View style={styles.grid}>{overview.map((metric) => { const item = ADMIN_NAV_ITEMS.find((entry) => entry.key === metric.section)!; return <Pressable key={metric.section} onPress={() => setSection(metric.section)} style={styles.metricCard}><Text style={styles.cardLabel}>{item.label}</Text><Text style={styles.cardValue}>{loading ? '—' : metric.count}</Text><Text style={styles.link}>Open view →</Text></Pressable>; })}</View> : null}
    {section !== 'overview' && !loading && !error && visibleRows.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>{query ? 'No matching records' : current.emptyLabel}</Text><Text style={styles.emptyText}>{query ? 'Clear or change the search term.' : 'This is expected for a freshly provisioned pilot database.'}</Text></View> : null}
    {section !== 'overview' && loading ? <Text style={styles.loading}>Loading {current.label.toLocaleLowerCase()}…</Text> : null}
    {selected ? <View style={styles.detailPanel}><Text style={styles.detailHeading}>{selected.title}</Text><Text style={styles.rowDetail}>{selected.detail}</Text>{selected.status ? <Text style={styles.status}>{selected.status}</Text> : null}<Pressable onPress={() => setSelected(null)}><Text style={styles.retry}>Close detail</Text></Pressable></View> : null}
    {section !== 'overview' && !loading && !error ? <View style={styles.list}>{visibleRows.map((row) => <Pressable accessibilityRole="button" accessibilityLabel={`Open ${row.title} detail`} onPress={() => setSelected(row)} key={row.id} style={styles.row}><View style={styles.rowCopy}><Text style={styles.rowTitle}>{row.title}</Text><Text style={styles.rowDetail}>{row.detail}</Text></View>{row.status ? <Text style={styles.status}>{row.status}</Text> : null}</Pressable>)}</View> : null}
  </ScrollView></View>;
}

const styles = StyleSheet.create({
  shell: { flex: 1, flexDirection: 'row', backgroundColor: colors.background }, shellCompact: { flexDirection: 'column' }, sidebar: { width: 245, flexGrow: 0, backgroundColor: colors.primaryNavy }, sidebarContent: { padding: 18, gap: 5 }, brand: { color: '#FFFFFF', fontSize: 19, fontWeight: '800', marginBottom: 18 }, mobileNav: { flexGrow: 0, backgroundColor: colors.primaryNavy }, mobileNavContent: { padding: 10, gap: 6 }, navItem: { borderRadius: 9, paddingHorizontal: 12, paddingVertical: 10 }, navItemActive: { backgroundColor: '#FFFFFF' }, navText: { color: '#D8E2F0', fontWeight: '700' }, navTextActive: { color: colors.primaryNavy },
  content: { flex: 1 }, contentInner: { padding: 24, gap: 18 }, headingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16 }, headingCopy: { flex: 1 }, title: { color: colors.textPrimary, fontSize: 27, fontWeight: '800' }, subtitle: { color: colors.textSecondary, marginTop: 4 }, refreshButton: { backgroundColor: colors.primaryNavy, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 }, refreshText: { color: '#FFFFFF', fontWeight: '700' }, search: { borderWidth: 1, borderColor: colors.border, backgroundColor: '#FFFFFF', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11, color: colors.textPrimary },
  errorBox: { borderWidth: 1, borderColor: '#FCA5A5', backgroundColor: '#FEF2F2', borderRadius: 10, padding: 14, gap: 7 }, error: { color: '#991B1B' }, retry: { color: colors.primaryNavy, fontWeight: '800' }, loading: { color: colors.textSecondary, paddingVertical: 30, textAlign: 'center' }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 }, metricCard: { minWidth: 205, flexGrow: 1, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 16, padding: 20 }, cardLabel: { color: colors.textSecondary, fontWeight: '700' }, cardValue: { color: colors.textPrimary, fontSize: 30, fontWeight: '800', marginTop: 8 }, link: { color: colors.primaryNavy, fontWeight: '700', marginTop: 12 },
  empty: { backgroundColor: '#FFFFFF', borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 28, alignItems: 'center' }, emptyTitle: { color: colors.textPrimary, fontWeight: '800', fontSize: 17 }, emptyText: { color: colors.textSecondary, marginTop: 7, textAlign: 'center' }, detailPanel: { backgroundColor: '#F8FAFC', borderColor: colors.primaryNavy, borderWidth: 1, borderRadius: 12, padding: 16, gap: 8 }, detailHeading: { color: colors.textPrimary, fontWeight: '800', fontSize: 18 }, list: { gap: 10 }, row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 15 }, rowCopy: { minWidth: 220, flex: 1 }, rowTitle: { color: colors.textPrimary, fontWeight: '800' }, rowDetail: { color: colors.textSecondary, marginTop: 5, lineHeight: 20 }, status: { overflow: 'hidden', color: colors.primaryNavy, backgroundColor: '#E8EEF7', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, fontWeight: '700' }, approveButton: { backgroundColor: colors.primaryNavy, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }, approveText: { color: '#FFFFFF', fontWeight: '800' },
});
