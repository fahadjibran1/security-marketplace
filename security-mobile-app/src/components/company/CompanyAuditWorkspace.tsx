import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatApiErrorMessage, listCompanyAuditLogs } from '../../services/api';
import { AuditLog } from '../../types/models';

type WebSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
};

function WebSelect({ value, onChange, options }: WebSelectProps) {
  const [isBrowserReady, setIsBrowserReady] = React.useState(false);

  React.useEffect(() => {
    setIsBrowserReady(typeof document !== 'undefined');
  }, []);

  if (isBrowserReady) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';
    return (
      <SelectTag value={value} onChange={(event: any) => onChange(event.target.value)} style={webSelectStyle}>
        {options.map((option) => (
          <OptionTag key={option.value} value={option.value}>
            {option.label}
          </OptionTag>
        ))}
      </SelectTag>
    );
  }

  return <TextInput value={value} onChangeText={onChange} style={styles.input} />;
}

function formatDateTime(value?: string | null) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatJson(value?: Record<string, unknown> | null) {
  if (!value) return 'No data captured';
  return JSON.stringify(value, null, 2);
}

export function CompanyAuditWorkspace() {
  const [logs, setLogs] = React.useState<AuditLog[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [entityType, setEntityType] = React.useState('all');
  const [action, setAction] = React.useState('all');
  const [dateFrom, setDateFrom] = React.useState('');
  const [dateTo, setDateTo] = React.useState('');
  const [expandedIds, setExpandedIds] = React.useState<number[]>([]);

  const loadLogs = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLogs(await listCompanyAuditLogs());
    } catch (err) {
      setError(formatApiErrorMessage(err, 'Unable to load audit logs.'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const entityOptions = React.useMemo(() => {
    const values = Array.from(new Set(logs.map((log) => log.entityType).filter(Boolean))).sort();
    return [{ label: 'All entity types', value: 'all' }, ...values.map((value) => ({ label: value, value }))];
  }, [logs]);

  const actionOptions = React.useMemo(() => {
    const values = Array.from(new Set(logs.map((log) => log.action).filter(Boolean))).sort();
    return [{ label: 'All actions', value: 'all' }, ...values.map((value) => ({ label: value, value }))];
  }, [logs]);

  const filteredLogs = React.useMemo(() => {
    const from = dateFrom.trim() ? new Date(`${dateFrom.trim()}T00:00:00`) : null;
    const to = dateTo.trim() ? new Date(`${dateTo.trim()}T23:59:59`) : null;
    return logs.filter((log) => {
      const createdAt = new Date(log.createdAt);
      if (entityType !== 'all' && log.entityType !== entityType) return false;
      if (action !== 'all' && log.action !== action) return false;
      if (from && createdAt < from) return false;
      if (to && createdAt > to) return false;
      return true;
    });
  }, [action, dateFrom, dateTo, entityType, logs]);

  function toggleExpanded(id: number) {
    setExpandedIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.eyebrow}>Compliance</Text>
          <Text style={styles.title}>Audit Trail</Text>
          <Text style={styles.subtitle}>Trace financial and operational actions with before-and-after data.</Text>
        </View>
        <Pressable style={styles.primaryButton} onPress={loadLogs} disabled={loading}>
          <Text style={styles.primaryButtonText}>{loading ? 'Refreshing...' : 'Refresh Audit Logs'}</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.filterCard}>
        <View style={styles.filterGrid}>
          <WebSelect value={entityType} onChange={setEntityType} options={entityOptions} />
          <WebSelect value={action} onChange={setAction} options={actionOptions} />
          <TextInput style={styles.input} value={dateFrom} onChangeText={setDateFrom} placeholder="From YYYY-MM-DD" />
          <TextInput style={styles.input} value={dateTo} onChangeText={setDateTo} placeholder="To YYYY-MM-DD" />
        </View>
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>{filteredLogs.length} audit log(s)</Text>
        <ScrollView style={styles.logList}>
          {filteredLogs.length === 0 ? (
            <Text style={styles.helperText}>No audit records match these filters.</Text>
          ) : (
            filteredLogs.map((log) => {
              const expanded = expandedIds.includes(log.id);
              return (
                <Pressable key={log.id} style={styles.logCard} onPress={() => toggleExpanded(log.id)}>
                  <View style={styles.logHeader}>
                    <View>
                      <Text style={styles.logTitle}>{log.action}</Text>
                      <Text style={styles.logMeta}>
                        {log.entityType} #{log.entityId ?? 'n/a'} | {formatDateTime(log.createdAt)}
                      </Text>
                    </View>
                    <Text style={styles.badge}>{expanded ? 'Hide details' : 'View details'}</Text>
                  </View>
                  <Text style={styles.helperText}>User: {log.user?.email || `User #${log.user?.id ?? 'unknown'}`}</Text>
                  {expanded ? (
                    <View style={styles.diffGrid}>
                      <View style={styles.diffBox}>
                        <Text style={styles.diffTitle}>Before</Text>
                        <Text style={styles.codeBlock}>{formatJson(log.beforeData)}</Text>
                      </View>
                      <View style={styles.diffBox}>
                        <Text style={styles.diffTitle}>After</Text>
                        <Text style={styles.codeBlock}>{formatJson(log.afterData)}</Text>
                      </View>
                    </View>
                  ) : null}
                </Pressable>
              );
            })
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const webSelectStyle = {
  borderRadius: 14,
  borderWidth: 1,
  borderColor: '#d6dce5',
  backgroundColor: '#ffffff',
  padding: '12px 14px',
  fontSize: 14,
  color: '#132238',
  minHeight: 46,
} as const;

const styles = StyleSheet.create({
  workspace: { gap: 18 },
  headerCard: {
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 22,
    borderWidth: 1,
    borderColor: '#dbe4ef',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
  },
  eyebrow: { color: '#0f766e', fontSize: 12, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  title: { color: '#0f172a', fontSize: 30, fontWeight: '800' },
  subtitle: { color: '#64748b', marginTop: 6, fontSize: 14, lineHeight: 21 },
  primaryButton: { backgroundColor: '#0f172a', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, alignSelf: 'center' },
  primaryButtonText: { color: '#ffffff', fontWeight: '800' },
  errorCard: { backgroundColor: '#fef2f2', borderColor: '#fecaca', borderWidth: 1, borderRadius: 16, padding: 14 },
  errorText: { color: '#991b1b', fontWeight: '700' },
  filterCard: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1 },
  filterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: {
    minWidth: 180,
    flex: 1,
    backgroundColor: '#ffffff',
    borderColor: '#d6dce5',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#132238',
  },
  panel: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1, gap: 12 },
  panelTitle: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  logList: { maxHeight: 720 },
  logCard: { borderColor: '#e2e8f0', borderWidth: 1, borderRadius: 18, padding: 14, marginBottom: 10, gap: 8 },
  logHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  logTitle: { color: '#0f172a', fontWeight: '800', fontSize: 16 },
  logMeta: { color: '#64748b', fontSize: 12, marginTop: 3 },
  badge: { color: '#0f766e', fontWeight: '800', fontSize: 12 },
  helperText: { color: '#64748b', fontSize: 13, lineHeight: 19 },
  diffGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  diffBox: { flex: 1, minWidth: 280, backgroundColor: '#f8fafc', borderRadius: 14, padding: 12, gap: 6 },
  diffTitle: { color: '#0f172a', fontWeight: '800' },
  codeBlock: { color: '#334155', fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
});
