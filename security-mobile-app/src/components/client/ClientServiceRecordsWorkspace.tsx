import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ClientPortalServiceRecord } from '../../types/models';

export function ClientServiceRecordsWorkspace({ records }: { records: ClientPortalServiceRecord[] }) {
  const grouped = React.useMemo(() => {
    const map = new Map<string, { key: string; siteName: string; periodKey: string; approvedHours: number; count: number }>();
    records.forEach((record) => {
      const key = `${record.siteName}|${record.periodKey}`;
      const current = map.get(key) || { key, siteName: record.siteName, periodKey: record.periodKey, approvedHours: 0, count: 0 };
      current.approvedHours += record.approvedHours;
      current.count += 1;
      map.set(key, current);
    });
    return Array.from(map.values()).sort((left, right) => right.periodKey.localeCompare(left.periodKey));
  }, [records]);

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Approved Service Records</Text>
      {grouped.length === 0 ? (
        <Text style={styles.helperText}>No approved service records match the current client scope.</Text>
      ) : (
        grouped.map((group) => (
          <View key={group.key} style={styles.row}>
            <View style={styles.flexGrow}>
              <Text style={styles.rowTitle}>{group.siteName}</Text>
              <Text style={styles.meta}>Period: {group.periodKey} | Records: {group.count}</Text>
            </View>
            <Text style={styles.hours}>{group.approvedHours.toFixed(2)}h</Text>
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
  rowTitle: { color: '#0F172A', fontWeight: '800' },
  meta: { color: '#64748B', marginTop: 3 },
  hours: { color: '#0F172A', fontWeight: '800', fontSize: 16 },
});
