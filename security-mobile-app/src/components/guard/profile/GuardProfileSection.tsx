import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { RequirementTag } from './ProfileTags';
import { REQUIREMENT_LABELS } from './profileCopy';
import { PROFILE_SECTIONS, type ProfileSectionKey } from './profileOverview';
import { profileTokens } from './profileTheme';

/**
 * S4 Guard Profile — one section, opened from the overview (Profile Phase 2C).
 *
 * The frame only: a Back control that returns to the overview, the section's title and requirement level, then the
 * existing panels and forms passed in as children, unchanged. Profile stays selected in the bottom bar while a section
 * is open (the dashboard keeps activeTab === 'profile').
 */
export function GuardProfileSection({ section, onBack, children }: { section: ProfileSectionKey; onBack: () => void; children: ReactNode }) {
  const meta = PROFILE_SECTIONS.find((s) => s.key === section) ?? PROFILE_SECTIONS[0];
  return (
    <View style={styles.root} testID={`guard-profile-section-view-${meta.key}`}>
      <Pressable
        onPress={onBack}
        style={({ pressed }: { pressed: boolean }) => [styles.back, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Back to Profile overview"
        testID="guard-profile-back"
      >
        <Text style={styles.backText}>‹ Profile</Text>
      </Pressable>
      <View style={styles.heading}>
        <Text style={styles.title} accessibilityRole="header">{meta.title}</Text>
        <RequirementTag requirement={meta.requirement} />
        <Text style={styles.description}>{REQUIREMENT_LABELS[meta.requirement].description}</Text>
      </View>
      {children}
    </View>
  );
}

const t = profileTokens;
const styles = StyleSheet.create({
  root: { gap: 12, width: '100%' },
  back: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingRight: 16 },
  backText: { ...t.type.button, color: t.colors.accent },
  heading: { gap: 6 },
  title: { ...t.type.sectionTitle, color: t.colors.textPrimary },
  description: { ...t.type.body, color: t.colors.textSecondary },
  pressed: { opacity: 0.7 },
});
