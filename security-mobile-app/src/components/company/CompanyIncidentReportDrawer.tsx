import * as React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { Drawer } from '../ui/Drawer';
import { NOT_RECORDED, type IncidentReportModel } from './incidentReport';
import { colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

/**
 * The Incident Report, on screen. (Phase 4A — client evidence.)
 *
 * The register could say that Incident #4 existed and was resolved; it could not answer the question
 * a client actually asks, which is what happened and what was done about it. This is that answer, in
 * the order someone reads it: what and where, then the guard's own account, then the evidence, then
 * who handled it and when, then how it was resolved.
 *
 * It renders a view model and holds no logic of its own, which is what lets the printed A4 page be
 * built from exactly the same facts rather than from a second reading of the same record.
 *
 * NOTHING HERE IS INVENTED. A fact the records do not hold is shown as absent — an em dash in a
 * field, a plain sentence for a whole section — never as a blank, a zero, or a plausible guess.
 */
export function CompanyIncidentReportDrawer({
  model,
  onClose,
  onPrint,
  printing,
  notice,
}: {
  model: IncidentReportModel | null;
  onClose: () => void;
  onPrint: () => void;
  printing: boolean;
  /** A message about the report itself, e.g. a blocked print window. */
  notice: string | null;
}) {
  if (!model) return null;

  return (
    <Drawer
      visible
      onClose={onClose}
      title={`Incident Report ${model.reference}`}
      subtitle={model.title || undefined}
      width={620}
      footer={
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[styles.secondaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={onClose}
          >
            <Text style={styles.secondaryBtnText}>Close</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Print / Save PDF"
            accessibilityState={{ disabled: printing }}
            style={[styles.primaryBtn, printing ? styles.primaryBtnBusy : null, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={onPrint}
            disabled={printing}
          >
            <Text style={styles.primaryBtnText}>{printing ? 'Preparing…' : 'Print / Save PDF'}</Text>
          </Pressable>
          {/*
            No placeholder for a future action. Sharing a report with a client will need a recipient,
            a sender, a timestamp and a record of the version sent; until that exists there is nothing
            honest to put here, and a greyed-out promise on a client-facing surface is clutter.
          */}
        </View>
      }
    >
      <View style={styles.statusRow}>
        <View style={styles.statusBadge}>
          <Text style={styles.statusBadgeText}>{model.statusLabel}</Text>
        </View>
      </View>

      <Section label="Overview">
        <View style={styles.fields}>
          {model.overview.map((field) => (
            <View key={field.label} style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>{field.label}</Text>
              <Text style={styles.fieldValue}>{field.value || NOT_RECORDED}</Text>
            </View>
          ))}
        </View>
      </Section>

      {/* The guard's own words. Shown, never edited, never written over by the resolution. */}
      <Section label="Original report">
        {model.originalReport ? (
          <View style={styles.body}>
            <Text style={styles.bodyText}>{model.originalReport}</Text>
          </View>
        ) : (
          <Absent>No report text was recorded.</Absent>
        )}
      </Section>

      <Section label="Evidence">
        {model.evidence.length ? (
          <View style={styles.evidence}>
            {model.evidence.map((item) => (
              <View key={item.id} style={styles.evidenceItem}>
                {item.isImage && item.fileUrl ? (
                  <Image
                    source={{ uri: item.fileUrl }}
                    style={styles.evidenceImage}
                    resizeMode="cover"
                    accessibilityLabel={item.fileName}
                  />
                ) : null}
                <Text style={styles.evidenceName} numberOfLines={1}>{item.fileName}</Text>
                <Text style={styles.evidenceMeta}>
                  {[item.size, item.uploadedBy, item.at].filter(Boolean).join(' · ')}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Absent>No evidence attached.</Absent>
        )}
      </Section>

      <Section label="Handling history">
        {model.handling.length ? (
          <View style={styles.timeline}>
            {model.handling.map((entry, index) => (
              <View
                key={entry.key}
                style={[styles.timelineItem, index === model.handling.length - 1 ? styles.timelineItemLast : null]}
              >
                <View style={styles.timelineDot} />
                <View style={styles.timelineBody}>
                  <Text style={styles.timelineEvent}>{entry.label}</Text>
                  <Text style={styles.timelineWhen}>{entry.at}</Text>
                  {entry.actor ? <Text style={styles.timelineWho}>By {entry.actor}</Text> : null}
                </View>
              </View>
            ))}
          </View>
        ) : (
          <Absent>No handling history recorded.</Absent>
        )}
      </Section>

      <Section label="Resolution">
        {model.resolution.recorded ? (
          <>
            <View style={styles.fields}>
              {([
                ['Resolution reason', model.resolution.reason],
                ['Resolved by', model.resolution.by],
                ['Resolved at', model.resolution.at],
              ] as const)
                .filter(([, value]) => Boolean(value))
                .map(([label, value]) => (
                  <View key={label} style={styles.fieldRow}>
                    <Text style={styles.fieldLabel}>{label}</Text>
                    <Text style={styles.fieldValue}>{value}</Text>
                  </View>
                ))}
            </View>
            {/* Labelled: on a client's report an unlabelled quote is just a floating sentence. */}
            {model.resolution.note ? (
              <>
                <Text style={styles.subLabel}>Resolution note</Text>
                <View style={styles.body}>
                  <Text style={styles.bodyText}>{model.resolution.note}</Text>
                </View>
              </>
            ) : null}
          </>
        ) : (
          /* Every incident raised before Migration 60 looks like this, and must. */
          <Absent>No resolution evidence recorded.</Absent>
        )}
      </Section>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    </Drawer>
  );
}

function Section({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Absent({ children }: React.PropsWithChildren) {
  return (
    <View style={styles.absent}>
      <Text style={styles.absentText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row' },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.primaryNavy,
    backgroundColor: colors.surfaceSubtle,
  },
  statusBadgeText: {
    fontSize: 10, fontWeight: '800', color: colors.primaryNavy,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },

  section: { gap: 6 },
  sectionLabel: {
    fontSize: 10, fontWeight: '800', color: colors.primaryNavy,
    textTransform: 'uppercase', letterSpacing: 0.9,
    borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 4,
  },

  fields: { gap: 0 },
  fieldRow: {
    flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', paddingVertical: 5,
    borderTopWidth: 1, borderTopColor: colors.surfaceSubtle,
  },
  fieldLabel: { width: 130, fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  fieldValue: { flex: 1, fontSize: 12, color: colors.textPrimary, fontWeight: '600' },

  body: {
    borderWidth: 1, borderColor: colors.border, borderLeftWidth: 3, borderLeftColor: colors.accentTeal,
    borderRadius: radii.sm, backgroundColor: colors.card,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  bodyText: { fontSize: 12, color: colors.textPrimary, lineHeight: 18 },
  subLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginTop: 8, marginBottom: 2,
  },

  absent: {
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', borderRadius: radii.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  absentText: { fontSize: 12, color: colors.textSecondary, fontStyle: 'italic' },

  evidence: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  evidenceItem: { width: 160, gap: 2 },
  evidenceImage: {
    width: 160, height: 110, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border,
  },
  evidenceName: { fontSize: 11, fontWeight: '700', color: colors.textPrimary },
  evidenceMeta: { fontSize: 10, color: colors.textSecondary },

  timeline: { gap: 0 },
  timelineItem: { flexDirection: 'row', gap: spacing.sm, paddingBottom: 10 },
  timelineItemLast: { paddingBottom: 0 },
  timelineDot: {
    width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accentTeal, marginTop: 4,
  },
  timelineBody: { flex: 1, gap: 1 },
  timelineEvent: { fontSize: 12, fontWeight: '800', color: colors.textPrimary },
  timelineWhen: { fontSize: 12, color: colors.textPrimary },
  timelineWho: { fontSize: 11, color: colors.textSecondary },

  notice: { fontSize: 11, color: colors.danger, fontWeight: '700' },

  footer: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', flexWrap: 'wrap' },
  secondaryBtn: {
    paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: radii.sm,
    borderWidth: 1, borderColor: colors.fieldBorder,
  },
  secondaryBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  primaryBtn: {
    paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: radii.sm,
    backgroundColor: colors.primaryNavy,
  },
  primaryBtnBusy: { opacity: 0.7 },
  primaryBtnText: { fontSize: 13, fontWeight: '800', color: colors.textOnBrand },
});
