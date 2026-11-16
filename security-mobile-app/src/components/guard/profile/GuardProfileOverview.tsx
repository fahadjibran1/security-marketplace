import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getMyGuardComplianceStatus, getMyScreening } from '../../../services/api';
import type { GuardComplianceSummary, GuardScreening } from '../../../types/models';
import { ProfileAvatar } from './ProfileAvatar';
import { RequirementTag } from './ProfileTags';
import type { ProfileLayout } from './profileLayout';
import {
  buildProfileOverview,
  failed,
  loading,
  localToday,
  ready,
  type Loadable,
  type ProfileOverviewSource,
  type ProfileSectionKey,
  type Tone,
} from './profileOverview';
import { PROFILE_TONE_COLORS, profileTokens } from './profileTheme';

/**
 * S4 Guard Profile — the compact overview (Profile Phase 2C).
 *
 * Renders buildProfileOverview (profileOverview.ts) and nothing else: a header (avatar, name, phone, the SIA and
 * deployment facts the backend reports), up to three needs-attention items and the seven section rows. It decides
 * nothing itself. No overall "profile complete" percentage is shown (approved decision 7): the backend has no
 * per-company requirement list, so any such figure would be invented.
 *
 * The compliance status and the screening status are the only data the dashboard does not already hold; they are
 * read here, with the same calls the Compliance and Screening panels make, each time the overview opens.
 */
export interface GuardProfileOverviewProps {
  source: ProfileOverviewSource;
  layout: ProfileLayout;
  onOpenSection: (section: ProfileSectionKey) => void;
  /** Shown when the Guard's own record could not load, so the overview offers the same recovery as before. */
  profileUnavailable?: { message: string; onRetry: () => void } | null;
}

type ComplianceFacts = Pick<GuardComplianceSummary, 'assignable' | 'blockingReasons'> & { siaExpiryDate?: string | null; siaLicenceNumber?: string | null };
type ScreeningFacts = Pick<GuardScreening, 'status' | 'progress'> | null;

export function GuardProfileOverview({ source, layout, onOpenSection, profileUnavailable }: GuardProfileOverviewProps) {
  const [compliance, setCompliance] = useState<Loadable<ComplianceFacts>>(loading());
  const [screening, setScreening] = useState<Loadable<ScreeningFacts>>(loading());

  useEffect(() => {
    let live = true;
    getMyGuardComplianceStatus()
      .then((summary) => live && setCompliance(ready({ assignable: Boolean(summary?.assignable), blockingReasons: summary?.blockingReasons ?? [], siaExpiryDate: summary?.siaExpiryDate ?? null, siaLicenceNumber: summary?.siaLicenceNumber ?? null })))
      .catch(() => live && setCompliance(failed()));
    getMyScreening()
      .then((file) => live && setScreening(ready(file ? { status: file.status, progress: file.progress } : null)))
      .catch(() => live && setScreening(failed()));
    return () => {
      live = false;
    };
  }, []);

  const overview = buildProfileOverview({ ...source, compliance, screening, today: localToday() });
  const { header, attention, sections } = overview;
  const titleOf = (key: ProfileSectionKey) => sections.find((s) => s.key === key)?.title ?? 'section';

  return (
    <View style={styles.root} testID="guard-profile-overview">
      {profileUnavailable ? (
        <View style={styles.unavailable} testID="guard-profile-overview-unavailable">
          <Text style={styles.unavailableText} accessibilityRole="alert">{profileUnavailable.message}</Text>
          <Pressable
            style={styles.retry}
            onPress={profileUnavailable.onRetry}
            accessibilityRole="button"
            accessibilityLabel="Try loading your profile again"
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.card} testID="guard-profile-header">
        <View style={styles.identityRow}>
          <ProfileAvatar initials={header.initials} size={48} />
          <View style={styles.identityText}>
            <Text style={styles.name} accessibilityRole="header" testID="guard-profile-name">{header.name}</Text>
            {header.phone ? <Text style={styles.meta} testID="guard-profile-phone-summary">{header.phone}</Text> : null}
          </View>
        </View>
        {/* Phase 2D: two equal cells with a fixed caption and a short value, so the header is the same height loading
            and loaded and never wraps into stacked pills. The full sentence is what a screen reader hears. */}
        <View style={styles.facts}>
          <FactCell caption="SIA licence" value={header.sia.detail} spoken={header.sia.label} tone={header.sia.tone} testID="guard-profile-sia-status" />
          <FactCell caption="Deployment" value={header.deployment.short} spoken={header.deployment.label} tone={header.deployment.tone} testID="guard-profile-deployment-status" />
        </View>
      </View>

      {attention.length ? (
        <View style={[styles.card, styles.attentionCard]} testID="guard-profile-attention">
          <Text style={styles.eyebrow} accessibilityRole="header">Needs attention</Text>
          {attention.map((item) => (
            <Pressable
              key={item.key}
              style={({ pressed }: { pressed: boolean }) => [styles.attentionRow, pressed && styles.pressed]}
              onPress={() => onOpenSection(item.section)}
              accessibilityRole="button"
              accessibilityLabel={`${item.text}. Opens ${titleOf(item.section)}`}
              testID={`guard-profile-attention-${item.key}`}
            >
              <View style={[styles.attentionMark, { backgroundColor: PROFILE_TONE_COLORS[item.tone].text }]} />
              <Text style={styles.attentionText}>{item.text}</Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={[styles.card, styles.sectionList]} testID="guard-profile-sections">
        {sections.map((section, index) => {
          const toneColour = section.tone === 'danger' || section.tone === 'warning' ? PROFILE_TONE_COLORS[section.tone].text : profileTokens.colors.textSecondary;
          return (
            <Pressable
              key={section.key}
              style={({ pressed }: { pressed: boolean }) => [styles.sectionRow, index > 0 && styles.sectionDivider, pressed && styles.pressed]}
              onPress={() => onOpenSection(section.key)}
              accessibilityRole="button"
              accessibilityLabel={`${section.title}, ${section.requirementLabel}. ${section.summary}`}
              accessibilityHint="Opens this section"
              testID={`guard-profile-section-${section.key}`}
            >
              <View style={styles.sectionText}>
                <View style={layout.sectionRowStacksTag ? styles.titleStack : styles.titleRow}>
                  <Text style={styles.sectionTitle}>{section.title}</Text>
                  <RequirementTag requirement={section.requirement} short />
                </View>
                <Text style={[styles.sectionSummary, { color: toneColour }]}>{section.summary}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function FactCell({ caption, value, spoken, tone, testID }: { caption: string; value: string; spoken: string; tone: Tone; testID: string }) {
  const colour = tone === 'neutral' ? profileTokens.colors.textPrimary : PROFILE_TONE_COLORS[tone].text;
  return (
    <View
      style={[styles.fact, { backgroundColor: PROFILE_TONE_COLORS[tone].surface }]}
      accessible
      accessibilityLabel={spoken}
      testID={testID}
    >
      <Text style={styles.factCaption}>{caption}</Text>
      <Text style={[styles.factValue, { color: colour }]}>{value}</Text>
    </View>
  );
}

const t = profileTokens;
const styles = StyleSheet.create({
  root: { gap: 12, width: '100%' },
  card: {
    backgroundColor: t.colors.surface,
    borderColor: t.colors.border,
    borderWidth: t.shape.cardBorderWidth,
    borderRadius: t.shape.cardRadius,
    padding: 12,
    gap: 10,
  },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  identityText: { flex: 1, minWidth: 0, gap: 2 },
  name: { ...t.type.sectionTitle, color: t.colors.textPrimary },
  meta: { ...t.type.body, color: t.colors.textSecondary },
  facts: { flexDirection: 'row', gap: 8 },
  fact: { flex: 1, minWidth: 0, maxWidth: '100%', borderRadius: t.shape.tagRadius, paddingHorizontal: 10, paddingVertical: 6, gap: 2 },
  factCaption: { ...t.type.sectionLabel, color: t.colors.textSecondary },
  factValue: { ...t.type.value, fontFamily: t.type.button.fontFamily },
  eyebrow: { ...t.type.sectionLabel, color: t.colors.textSecondary },
  attentionCard: { gap: 0, paddingVertical: 8 },
  attentionRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
  attentionMark: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  attentionText: { ...t.type.value, flex: 1, color: t.colors.textPrimary },
  sectionList: { paddingVertical: 0, gap: 0 },
  sectionRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  sectionDivider: { borderTopWidth: 1, borderTopColor: t.colors.border },
  sectionText: { flex: 1, minWidth: 0, gap: 2 },
  // Phase 2D: one deterministic rule — beside the title on a standard phone (no wrapping), under it when compact.
  titleRow: { flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', gap: 8 },
  titleStack: { flexDirection: 'column', alignItems: 'flex-start', gap: 4 },
  sectionTitle: { ...t.type.value, fontFamily: t.type.button.fontFamily, color: t.colors.textPrimary, flexShrink: 1 },
  sectionSummary: { ...t.type.body },
  chevron: { fontSize: 22, color: t.colors.textSecondary },
  pressed: { opacity: 0.7 },
  unavailable: {
    gap: 8,
    padding: t.spacing.sectionPadding,
    borderRadius: t.shape.cardRadius,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  unavailableText: { ...t.type.body, color: t.colors.danger },
  retry: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: t.shape.controlRadius,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  retryText: { ...t.type.button, color: t.colors.textPrimary },
});
