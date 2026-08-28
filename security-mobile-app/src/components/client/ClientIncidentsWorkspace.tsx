import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ClientPortalIncident } from '../../types/models';
import { colors } from '../../theme';

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
  panel: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.pendingSurface, borderRadius: 18, padding: 18, gap: 12 },
  title: { color: colors.primaryNavy, fontSize: 22, fontWeight: '800' },
  helperText: { color: colors.textSecondary },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.background, alignItems: 'flex-start' },
  flexGrow: { flex: 1 },
  rowTitle: { color: colors.primaryNavy, fontWeight: '800' },
  meta: { color: colors.textSecondary, marginTop: 3 },
  summary: { color: colors.primaryNavySoft, marginTop: 5, lineHeight: 20 },
  status: { color: colors.primaryNavy, fontWeight: '700', textTransform: 'capitalize' },
});
