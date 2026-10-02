import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Drawer } from '../ui/Drawer';
import { resolutionLabel } from './alertResolution';
import {
  incidentCategoryLabel,
  incidentLifecycleLabel,
  incidentSeverityLabel,
} from './incidentLifecycle';
import { formatInstantDateTime } from '../../services/siteTime';
import type { Incident } from '../../types/models';
import { colors, radii, spacing } from '../../theme';

/**
 * One incident, in full. (UAT FIX 03.)
 *
 * The register was a seven-column table and nothing more: a controller could see that Incident #4
 * existed and was "Open", but not what was reported, who looked at it, when, or — once it had been
 * resolved — why. Everything the record holds is shown here, including the lifecycle evidence the
 * resolution workflow writes, so the register answers the question a client actually asks: what
 * happened, and what did you do about it.
 *
 * EVERY FIELD IS OPTIONAL IN PRACTICE. `reviewedAt`, `closedAt`, `resolutionReason` and
 * `resolutionNote` are null on every incident raised before the resolution workflow existed, and
 * `site`, `shift`, `guard` and `category` can all be absent. Nothing here renders "null" or an
 * invented value: a missing fact reads as an em dash, and a whole section that has no facts yet is
 * left out rather than shown empty.
 */
export function CompanyIncidentDetailDrawer({
  incident,
  timeZone,
  onClose,
}: {
  incident: Incident | null;
  /** The site's clock, so a time reads as the site read it. */
  timeZone: string;
  onClose: () => void;
}) {
  if (!incident) return null;

  const when = (value: string | null | undefined) =>
    (value ? formatInstantDateTime(value, timeZone) : '');

  const facts: Array<[string, string]> = [
    ['Incident', `#${incident.id}`],
    ['Status', incidentLifecycleLabel(incident.status)],
    ['Severity', incidentSeverityLabel(incident.severity)],
    ['Category', incidentCategoryLabel(incident.category)],
    ['Site', incident.site?.name || incident.shift?.site?.name || ''],
    ['Location', incident.locationText || ''],
    ['Guard', incident.guard?.fullName || ''],
    ['Shift', incident.shift?.id ? `#${incident.shift.id}` : ''],
    ['Raised', when(incident.reportedAt || incident.createdAt)],
  ];

  // Who has handled it, and when. Shown only once there is something to show.
  const lifecycle: Array<[string, string]> = [
    ['Reviewed', when(incident.reviewedAt)],
    ['Reviewed by', incident.reviewedByUserId ? `User #${incident.reviewedByUserId}` : ''],
    ['Closed', when(incident.closedAt)],
    ['Closed by', incident.closedByUserId ? `User #${incident.closedByUserId}` : ''],
  ].filter(([, value]) => Boolean(value)) as Array<[string, string]>;

  const reason = incident.resolutionReason
    ? resolutionLabel('incident', incident.resolutionReason)
    : '';
  const resolutionNote = incident.resolutionNote?.trim() || '';

  return (
    <Drawer
      visible
      onClose={onClose}
      title={`Incident #${incident.id}`}
      subtitle={incident.title || undefined}
      width={560}
    >
      <View style={styles.facts}>
        {facts.map(([label, value]) => (
          <View key={label} style={styles.factRow}>
            <Text style={styles.factLabel}>{label}</Text>
            <Text style={styles.factValue} numberOfLines={2}>{value || '—'}</Text>
          </View>
        ))}
      </View>

      {/* What the guard reported, verbatim and never written over. */}
      <Text style={styles.sectionLabel}>Reported</Text>
      <View style={styles.block}>
        <Text style={styles.blockText}>
          {incident.notes?.trim() || 'No report text was recorded.'}
        </Text>
      </View>

      {lifecycle.length ? (
        <>
          <Text style={styles.sectionLabel}>Handling</Text>
          <View style={styles.facts}>
            {lifecycle.map(([label, value]) => (
              <View key={label} style={styles.factRow}>
                <Text style={styles.factLabel}>{label}</Text>
                <Text style={styles.factValue} numberOfLines={2}>{value}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {reason || resolutionNote ? (
        <>
          <Text style={styles.sectionLabel}>Resolution</Text>
          <View style={styles.block}>
            {reason ? <Text style={styles.resolutionReason}>{reason}</Text> : null}
            {resolutionNote ? <Text style={styles.blockText}>{resolutionNote}</Text> : null}
          </View>
        </>
      ) : (
        <Text style={styles.footnote}>
          No resolution has been recorded for this incident yet.
        </Text>
      )}
    </Drawer>
  );
}

const styles = StyleSheet.create({
  facts: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 4,
  },
  factRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  factLabel: { width: 84, fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  factValue: { flex: 1, fontSize: 12, color: colors.textPrimary, fontWeight: '600' },

  sectionLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: spacing.sm,
  },
  block: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 4,
  },
  blockText: { fontSize: 12, color: colors.textPrimary, lineHeight: 18 },
  resolutionReason: { fontSize: 13, fontWeight: '800', color: colors.textPrimary },
  footnote: { fontSize: 11, color: colors.textSecondary, lineHeight: 16, marginTop: spacing.sm },
});
