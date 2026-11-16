import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { RequirementTag } from './ProfileTags';
import { REQUIREMENT_LABELS } from './profileCopy';
import { PROFILE_SECTIONS, type ProfileSectionKey } from './profileOverview';
import { profileTokens } from './profileTheme';

/**
 * S4 Guard Profile — one section, opened from the overview (Profile Phase 2C; compact header Phase 2D).
 *
 * The frame only: a Back control that returns to the overview, the section's title and requirement level, then the
 * existing panels and forms passed in as children, unchanged. Profile stays selected in the bottom bar while a section
 * is open (the dashboard keeps activeTab === 'profile').
 */
export function GuardProfileSection({ section, onBack, compact = false, children }: { section: ProfileSectionKey; onBack: () => void; compact?: boolean; children: ReactNode }) {
  const meta = PROFILE_SECTIONS.find((s) => s.key === section) ?? PROFILE_SECTIONS[0];
  const words = REQUIREMENT_LABELS[meta.requirement];
  // The tag sits beside its explanation only when both are short enough to share one line ("Required — Needed for
  // your S4 account."); a long pair would squeeze the explanation into a narrow ragged column, so it goes underneath.
  const beside = !compact && words.label.length + words.description.length <= SHARED_LINE_CHARS;
  return (
    <View style={styles.root} testID={`guard-profile-section-view-${meta.key}`}>
      {/* Phase 2D: Back and the section title share one row, and the requirement level sits beside its explanation,
          so the section's own content starts about one row higher. */}
      <View style={styles.headRow}>
        <Pressable
          onPress={onBack}
          style={({ pressed }: { pressed: boolean }) => [styles.back, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Back to Profile overview"
          hitSlop={{ top: 2, bottom: 2, left: 4, right: 4 }}
          testID="guard-profile-back"
        >
          <Text style={styles.backText}>‹ Profile</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">{meta.title}</Text>
      </View>
      <View style={beside ? styles.requirementRow : styles.requirementStack} testID="guard-profile-section-requirement">
        <RequirementTag requirement={meta.requirement} />
        <Text style={[styles.description, beside && styles.descriptionBeside]}>{words.description}</Text>
      </View>
      {children}
    </View>
  );
}

/** Characters of tag + explanation that still fit on one line of a standard phone at normal text size. */
const SHARED_LINE_CHARS = 48;

const t = profileTokens;
const styles = StyleSheet.create({
  root: { gap: 10, width: '100%' },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { minHeight: 44, justifyContent: 'center', paddingRight: 8, flexShrink: 0 },
  backText: { ...t.type.button, color: t.colors.accent },
  title: { ...t.type.sectionTitle, color: t.colors.textPrimary, flex: 1, minWidth: 0 },
  requirementRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  requirementStack: { flexDirection: 'column', alignItems: 'flex-start', gap: 4 },
  description: { ...t.type.body, color: t.colors.textSecondary },
  descriptionBeside: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.7 },
});
