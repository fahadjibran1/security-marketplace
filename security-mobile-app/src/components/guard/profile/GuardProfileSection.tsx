import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { REQUIREMENT_LABELS } from './profileCopy';
import { PROFILE_SECTIONS, type ProfileSectionKey } from './profileOverview';
import { profileTokens } from './profileTheme';

/**
 * S4 Guard Profile — one section, opened from the overview (Profile Phase 2C; compact header Phase 2D).
 *
 * The frame only: a Back control that returns to the overview, the section's title and requirement level, then the
 * existing panels and forms passed in as children, unchanged. Profile stays selected in the bottom bar while a section
 * is open (the dashboard keeps activeTab === 'profile').
 *
 * UX-02A: the requirement level is one line of plain text under the title ("Required for your S4 account.") instead of
 * a grey pill followed by a separate explanation, so the distinction is still made, once, in words.
 */
export function GuardProfileSection({ section, onBack, children }: { section: ProfileSectionKey; onBack: () => void; children: ReactNode }) {
  const meta = PROFILE_SECTIONS.find((s) => s.key === section) ?? PROFILE_SECTIONS[0];
  const words = REQUIREMENT_LABELS[meta.requirement];
  return (
    <View style={styles.root} testID={`guard-profile-section-view-${meta.key}`}>
      {/* Phase 2D: Back and the section title share one row, so the section's own content starts one row higher. */}
      <View style={styles.headRow}>
        <Pressable
          onPress={onBack}
          style={({ pressed }: { pressed: boolean }) => [styles.back, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Back to Profile overview"
          testID="guard-profile-back"
        >
          <Text style={styles.backText}>‹ Profile</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">{meta.title}</Text>
      </View>
      <Text style={styles.caption} accessibilityLabel={`${words.label}. ${words.caption}`} testID="guard-profile-section-requirement">
        {words.caption}
      </Text>
      {children}
    </View>
  );
}

const t = profileTokens;
const styles = StyleSheet.create({
  root: { gap: 10, width: '100%' },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // UX-02A: 48dp, the Android minimum, without relying on hit slop.
  back: { minHeight: 48, justifyContent: 'center', paddingRight: 8, flexShrink: 0 },
  backText: { ...t.type.button, color: t.colors.accent },
  title: { ...t.type.sectionTitle, color: t.colors.textPrimary, flex: 1, minWidth: 0 },
  caption: { ...t.type.requirement, color: t.colors.textSecondary },
  pressed: { opacity: 0.7 },
});
