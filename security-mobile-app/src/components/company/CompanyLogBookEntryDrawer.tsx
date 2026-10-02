import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Drawer } from '../ui/Drawer';
import { NOT_RECORDED } from './dailySiteLog';
import type { LogBookRow } from './logBookRegister';
import { colors, radii, spacing } from '../../theme';

export type LogBookEntryDetail = LogBookRow & {
  /** The shift's scheduled window, already formatted. */
  scheduledShift: string;
  /** The exact recorded time, with its date. */
  recordedAt: string;
  /** The required period this entry falls in, when the site has one. */
  periodLabel: string;
};

/**
 * One Log Book entry, read-only. (Phase 4B.)
 *
 * THIS IS EVIDENCE, NOT A NOTE. There is deliberately no Edit, no Delete and no way to change the
 * time: the backend exposes no such endpoint, and offering a control that could not work — or worse,
 * one that could — would misrepresent what a Log Book is. A correction, if it is ever needed, will be
 * an appended amendment that references this entry rather than a rewrite of it.
 *
 * A fact the records do not hold reads as an em dash. Nothing is inferred.
 */
export function CompanyLogBookEntryDrawer({
  entry,
  onClose,
}: {
  entry: LogBookEntryDetail | null;
  onClose: () => void;
}) {
  if (!entry) return null;

  const facts: Array<[string, string]> = [
    ['Site', entry.siteName],
    ['Client', entry.clientName],
    ['Guard', entry.guardName],
    ['Shift', entry.shiftId ? `#${entry.shiftId}` : ''],
    ['Scheduled shift', entry.scheduledShift],
    ['Recorded at', entry.recordedAt],
    ['Log type', entry.logTypeLabel],
    ['Required period', entry.periodLabel],
  ];

  return (
    <Drawer visible onClose={onClose} title="Log Book Entry" subtitle={entry.siteName || undefined} width={560}>
      <View style={styles.facts}>
        {facts.map(([label, value]) => (
          <View key={label} style={styles.factRow}>
            <Text style={styles.factLabel}>{label}</Text>
            <Text style={styles.factValue}>{value || NOT_RECORDED}</Text>
          </View>
        ))}
      </View>

      {/* The guard's words, in full and never clipped: the register may abbreviate, this may not. */}
      <Text style={styles.sectionLabel}>Entry</Text>
      <View style={styles.body}>
        <Text style={styles.bodyText}>{entry.message || 'No entry text was recorded.'}</Text>
      </View>

      <Text style={styles.footnote}>
        Log Book entries are a permanent operational record. They cannot be edited or deleted.
      </Text>
    </Drawer>
  );
}

const styles = StyleSheet.create({
  facts: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm,
    backgroundColor: colors.surfaceSubtle, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 4,
  },
  factRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  factLabel: { width: 118, fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  factValue: { flex: 1, fontSize: 12, color: colors.textPrimary, fontWeight: '600' },

  sectionLabel: {
    fontSize: 10, fontWeight: '800', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.8, marginTop: spacing.sm,
  },
  body: {
    borderWidth: 1, borderColor: colors.border, borderLeftWidth: 3, borderLeftColor: colors.accentTeal,
    borderRadius: radii.sm, backgroundColor: colors.card,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  bodyText: { fontSize: 13, color: colors.textPrimary, lineHeight: 19 },
  footnote: { fontSize: 11, color: colors.textSecondary, lineHeight: 16, marginTop: spacing.sm },
});
