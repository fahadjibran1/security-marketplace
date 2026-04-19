import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ClientPortalIncident } from '../../types/models';

export function ClientIncidentsWorkspace({ incidents }: { incidents: ClientPortalIncident[] }) {
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Incidents</Text>
      {incidents.length === 0 ? (
        <Text style={styles.helperText}>No incidents are currently visible for your sites.</Text>
      ) : (
        incidents.map((incident) => (
          <View key={incident.id} style={styles.row}>
            <View style={styles.flexGrow}>
              <Text style={styles.rowTitle}>{incident.title}</Text>
              <Text style={styles.meta}>{incident.siteName} | {incident.category} | {incident.severity}</Text>
              <Text style={styles.summary}>{incident.summary}</Text>
            </View>
            <Text style={styles.status}>{incident.status}</Text>
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
  row: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9', alignItems: 'flex-start' },
  flexGrow: { flex: 1 },
  rowTitle: { color: '#0F172A', fontWeight: '800' },
  meta: { color: '#64748B', marginTop: 3 },
  summary: { color: '#334155', marginTop: 5, lineHeight: 20 },
  status: { color: '#0F172A', fontWeight: '700', textTransform: 'capitalize' },
});
