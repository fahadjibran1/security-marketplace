import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ClientDashboardWorkspace } from '../components/client/ClientDashboardWorkspace';
import { ClientIncidentsWorkspace } from '../components/client/ClientIncidentsWorkspace';
import { ClientInvoicesWorkspace } from '../components/client/ClientInvoicesWorkspace';
import { ClientReportsWorkspace } from '../components/client/ClientReportsWorkspace';
import { ClientServiceRecordsWorkspace } from '../components/client/ClientServiceRecordsWorkspace';
import { ClientSitesWorkspace } from '../components/client/ClientSitesWorkspace';
import {
  formatApiErrorMessage,
  getClientPortalDashboard,
  listClientPortalIncidents,
  listClientPortalInvoices,
  listClientPortalServiceRecords,
  listClientPortalSites,
} from '../services/api';
import {
  AuthUser,
  ClientPortalDashboard,
  ClientPortalIncident,
  ClientPortalInvoiceSummary,
  ClientPortalServiceRecord,
  ClientPortalSite,
} from '../types/models';
import { colors } from '../theme';

type ClientSection = 'dashboard' | 'sites' | 'service-records' | 'incidents' | 'reports' | 'invoices';

const NAV_ITEMS: Array<{ id: ClientSection; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'sites', label: 'Sites' },
  { id: 'service-records', label: 'Service Records' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'reports', label: 'Reports' },
  { id: 'invoices', label: 'Invoices' },
];

export function ClientPortalScreen({ user }: { user: AuthUser }) {
  const [activeSection, setActiveSection] = React.useState<ClientSection>('dashboard');
  const [dashboard, setDashboard] = React.useState<ClientPortalDashboard | null>(null);
  const [sites, setSites] = React.useState<ClientPortalSite[]>([]);
  const [serviceRecords, setServiceRecords] = React.useState<ClientPortalServiceRecord[]>([]);
  const [incidents, setIncidents] = React.useState<ClientPortalIncident[]>([]);
  const [invoices, setInvoices] = React.useState<ClientPortalInvoiceSummary[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const loadData = React.useCallback(async () => {
    setError(null);
    try {
      const [nextDashboard, nextSites, nextServiceRecords, nextIncidents, nextInvoices] = await Promise.all([
        getClientPortalDashboard(),
        listClientPortalSites(),
        listClientPortalServiceRecords(),
        listClientPortalIncidents(),
        listClientPortalInvoices(),
      ]);
      setDashboard(nextDashboard);
      setSites(nextSites);
      setServiceRecords(nextServiceRecords);
      setIncidents(nextIncidents);
      setInvoices(nextInvoices);
    } catch (err) {
      setError(formatApiErrorMessage(err, 'Unable to load the client portal.'));
    }
  }, []);

  React.useEffect(() => {
    loadData();
  }, []);

  const renderContent = () => {
    switch (activeSection) {
      case 'dashboard':
        return <ClientDashboardWorkspace dashboard={dashboard} />;
      case 'sites':
        return <ClientSitesWorkspace sites={sites} />;
      case 'service-records':
        return <ClientServiceRecordsWorkspace records={serviceRecords} />;
      case 'incidents':
        return <ClientIncidentsWorkspace incidents={incidents} />;
      case 'reports':
        return <ClientReportsWorkspace />;
      case 'invoices':
        return <ClientInvoicesWorkspace invoices={invoices} />;
      default:
        return null;
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.topCard}>
        <View style={styles.flexGrow}>
          <Text style={styles.portalLabel}>Client Portal</Text>
          <Text style={styles.portalTitle}>{dashboard?.client.name || user.email}</Text>
          <Text style={styles.portalSubtitle}>Secure access to sites, approved service records, incidents, reports, and invoices.</Text>
        </View>
        <Pressable style={styles.refreshButton} onPress={loadData}>
          <Text style={styles.refreshButtonText}>Refresh</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.navRow}>
        {NAV_ITEMS.map((item) => (
          <Pressable
            key={item.id}
            style={[styles.navButton, activeSection === item.id && styles.navButtonActive]}
            onPress={() => setActiveSection(item.id)}
          >
            <Text style={[styles.navButtonText, activeSection === item.id && styles.navButtonTextActive]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.content}>{renderContent()}</ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 20, gap: 16, backgroundColor: colors.background },
  topCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.pendingSurface,
    borderRadius: 24,
    padding: 22,
    flexDirection: 'row',
    gap: 16,
    alignItems: 'center',
  },
  flexGrow: { flex: 1 },
  portalLabel: { color: colors.accentTealStrong, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1.4 },
  portalTitle: { color: colors.primaryNavy, fontSize: 32, fontWeight: '800', marginTop: 8 },
  portalSubtitle: { color: colors.textSecondary, marginTop: 6, lineHeight: 20 },
  refreshButton: { backgroundColor: colors.primaryNavy, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12 },
  refreshButtonText: { color: colors.card, fontWeight: '800' },
  errorCard: { backgroundColor: colors.dangerSurface, borderWidth: 1, borderColor: colors.dangerBorder, borderRadius: 16, padding: 14 },
  errorText: { color: colors.danger, fontWeight: '700' },
  navRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  navButton: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, backgroundColor: colors.pendingSurface },
  navButtonActive: { backgroundColor: colors.primaryNavy },
  navButtonText: { color: colors.primaryNavy, fontWeight: '700' },
  navButtonTextActive: { color: colors.card },
  content: { paddingBottom: 40 },
});
