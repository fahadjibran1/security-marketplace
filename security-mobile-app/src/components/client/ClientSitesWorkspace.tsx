import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ClientPortalSite } from '../../types/models';

export function ClientSitesWorkspace({ sites }: { sites: ClientPortalSite[] }) {
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Sites</Text>
      {sites.length === 0 ? (
        <Text style={styles.helperText}>No sites linked to this client account.</Text>
      ) : (
        sites.map((site) => (
          <View key={site.id} style={styles.row}>
            <View style={styles.flexGrow}>
              <Text style={styles.siteName}>{site.name}</Text>
              <Text style={styles.meta}>{site.address}</Text>
              <Text style={styles.meta}>
                Incidents: {site.recentIncidents} · Open: {site.openIncidents} · Upcoming shifts: {site.upcomingShifts}
              </Text>
            </View>
            <Text style={styles.status}>{site.status}</Text>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 18, padding: 18, gap: 12 },
  title: { color: '#0F172A', fontSize: 22, fontWeight: '800' },
  helperText: { color: '#64748B' },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9', alignItems: 'center' },
  flexGrow: { flex: 1 },
  siteName: { color: '#0F172A', fontWeight: '800', fontSize: 16 },
  meta: { color: '#64748B', marginTop: 3 },
  status: { color: '#0F172A', fontWeight: '700', textTransform: 'capitalize' },
});
