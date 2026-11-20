import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getMyGuardComplianceStatus, getMyScreening } from '../../../services/api';
import type { GuardComplianceSummary, GuardScreening } from '../../../types/models';
import { ProfileAvatar } from './ProfileAvatar';
import { freshValue, type TimedValue } from './profileData';
import { RequirementText } from './ProfileTags';
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
 * read here, with the same calls the Compliance and Screening panels make. Profile Phase 2E: a read younger than the
 * freshness window is reused from the dashboard's in-memory cache (so Back from a section sends nothing), and the
 * overview reads again when it is older or when the dashboard asks (refreshKey).
 */
export interface GuardProfileOverviewProps {
  source: ProfileOverviewSource;
  onOpenSection: (section: ProfileSectionKey) => void;
  /** Shown when the Guard's own record could not load, so the overview offers the same recovery as before. */
  profileUnavailable?: { message: string; onRetry: () => void } | null;
  /** Phase 2E: the dashboard's short-lived copy of the two backend summaries (held in memory only). */
  cache?: ProfileOverviewCache;
  /** Phase 2E: changing it re-checks freshness and reads whatever is stale (for example on return to the foreground). */
  refreshKey?: number;
  /** UX-02A: the system text scale (the dashboard's Guard Home layout), which decides whether the two facts share a row. */
  fontScale?: number;
}

export interface ProfileOverviewCache {
  compliance?: TimedValue<ComplianceFacts>;
  screening?: TimedValue<ScreeningFacts>;
}

export type ComplianceFacts = Pick<GuardComplianceSummary, 'assignable' | 'blockingReasons'> & { siaExpiryDate?: string | null; siaLicenceNumber?: string | null };
export type ScreeningFacts = Pick<GuardScreening, 'status' | 'progress'> | null;

/** The facts the overview shows from a compliance summary, so the Compliance panel's read can refresh the same cache. */
export function complianceFactsFrom(summary: GuardComplianceSummary | null | undefined): ComplianceFacts {
  return { assignable: Boolean(summary?.assignable), blockingReasons: summary?.blockingReasons ?? [], siaExpiryDate: summary?.siaExpiryDate ?? null, siaLicenceNumber: summary?.siaLicenceNumber ?? null };
}

/**
 * UX-02A accessibility correction — the narrowest a fact cell's text may be, in unscaled points, before the two cells
 * stop sharing a row. The longest single word a cell shows is the SIA date ("30/06/2028", about 84pt at 1.0x in the
 * cell's 14pt SemiBold), so below this width Android broke it mid-value ("30/06/20 | 28") and split "Deployment".
 */
export const PROFILE_FACT_MIN_TEXT_WIDTH = 96;
/** A fact cell's horizontal padding (10dp each side), added to the scaled text width. */
const FACT_HORIZONTAL_PADDING = 20;

/**
 * The flex basis of one fact cell at this text scale. The cells sit side by side while two bases fit the card, and
 * each takes a full-width row (SIA first) when they do not: content-driven wrapping, so nothing is hidden, shortened
 * or scaled down. On a 360dp phone they share a row up to about 1.3x; on 411dp up to about 1.6x.
 */
export function profileFactBasis(fontScale: number): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return Math.ceil(PROFILE_FACT_MIN_TEXT_WIDTH * scale) + FACT_HORIZONTAL_PADDING;
}

export function GuardProfileOverview({ source, onOpenSection, profileUnavailable, cache, refreshKey = 0, fontScale = 1 }: GuardProfileOverviewProps) {
  const factBasis = profileFactBasis(fontScale);
  // A fresh cached read is shown at once (no loading flash on Back); otherwise the status loads as before.
  const [compliance, setCompliance] = useState<Loadable<ComplianceFacts>>(() => {
    const cached = freshValue(cache?.compliance, Date.now());
    return cached ? ready(cached) : loading();
  });
  const [screening, setScreening] = useState<Loadable<ScreeningFacts>>(() => {
    const cached = freshValue(cache?.screening, Date.now());
    return cached !== undefined ? ready(cached) : loading();
  });

  useEffect(() => {
    // `live` drops a response that arrives after the overview closed or a newer read began (stale-response guard).
    let live = true;
    const now = Date.now();
    const cachedCompliance = freshValue(cache?.compliance, now);
    if (cachedCompliance) setCompliance(ready(cachedCompliance));
    else {
      getMyGuardComplianceStatus()
        .then((summary) => {
          if (!live) return;
          const facts = complianceFactsFrom(summary);
          if (cache) cache.compliance = { value: facts, at: Date.now() };
          setCompliance(ready(facts));
        })
        .catch(() => live && setCompliance(failed()));
    }
    const cachedScreening = freshValue(cache?.screening, now);
    if (cachedScreening !== undefined) setScreening(ready(cachedScreening));
    else {
      getMyScreening()
        .then((file) => {
          if (!live) return;
          const facts: ScreeningFacts = file ? { status: file.status, progress: file.progress } : null;
          if (cache) cache.screening = { value: facts, at: Date.now() };
          setScreening(ready(facts));
        })
        .catch(() => live && setScreening(failed()));
    }
    return () => {
      live = false;
    };
    // The cache object is the dashboard's ref and never changes identity; refreshKey is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

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
            and loaded and never wraps into stacked pills. The full sentence is what a screen reader hears. UX-02A: the
            SIA cell's verb moved into its caption, so the value is the date alone and fits one line. UX-02A accessibility
            correction: at large text the two cells wrap onto their own full-width rows (profileFactBasis) instead of
            breaking the date or "Deployment" mid-word. */}
        <View style={styles.facts} testID="guard-profile-facts">
          <FactCell caption={header.sia.caption} value={header.sia.value} spoken={header.sia.label} tone={header.sia.tone} basis={factBasis} testID="guard-profile-sia-status" />
          <FactCell caption="Deployment" value={header.deployment.short} spoken={header.deployment.label} tone={header.deployment.tone} basis={factBasis} testID="guard-profile-deployment-status" />
        </View>

        {/* UX-02A: Needs attention is part of the same card (identity, facts, attention), divided from the facts above. */}
        {attention.length ? (
          <View style={styles.attention} testID="guard-profile-attention">
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
      </View>

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
                {/* UX-02A: the requirement is plain secondary text beside the title, wrapping under it only when the
                    pair does not fit (never a grey pill, never forced onto its own line). */}
                <View style={styles.titleRow}>
                  <Text style={styles.sectionTitle}>{section.title}</Text>
                  {section.requirementText ? <RequirementText text={section.requirementText} testID={`guard-profile-requirement-${section.requirement}`} /> : null}
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

function FactCell({ caption, value, spoken, tone, basis, testID }: { caption: string; value: string; spoken: string; tone: Tone; basis: number; testID: string }) {
  const colour = tone === 'neutral' ? profileTokens.colors.textPrimary : PROFILE_TONE_COLORS[tone].text;
  return (
    <View
      style={[styles.fact, { flexBasis: basis, backgroundColor: PROFILE_TONE_COLORS[tone].surface }]}
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
  // Wraps when two cells' bases (profileFactBasis) do not fit; each grows to fill its row.
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fact: { flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: '100%', borderRadius: t.shape.tagRadius, paddingHorizontal: 10, paddingVertical: 6, gap: 2 },
  factCaption: { ...t.type.sectionLabel, color: t.colors.textSecondary },
  factValue: { ...t.type.value, fontFamily: t.type.button.fontFamily },
  eyebrow: { ...t.type.sectionLabel, color: t.colors.textSecondary },
  attention: { borderTopWidth: 1, borderTopColor: t.colors.border, paddingTop: 8, gap: 0 },
  attentionRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 },
  attentionMark: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  attentionText: { ...t.type.value, flex: 1, color: t.colors.textPrimary },
  sectionList: { paddingVertical: 0, gap: 0 },
  sectionRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  sectionDivider: { borderTopWidth: 1, borderTopColor: t.colors.border },
  sectionText: { flex: 1, minWidth: 0, gap: 2 },
  // UX-02A: content-driven — the requirement text follows the title on the same line and wraps under it only when the
  // pair does not fit, at any width or text size (no width breakpoint, no pill).
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 0 },
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
