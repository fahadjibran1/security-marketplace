import { StyleSheet, Text, View } from 'react-native';
import { REQUIREMENT_LABELS, type ProfileRequirement } from './profileCopy';
import type { Tone } from './profileOverview';
import { PROFILE_TONE_COLORS, REQUIREMENT_TAG_COLORS, profileTokens } from './profileTheme';

/** A requirement level ("Required", "By invitation"…). Always neutral: a requirement is not a problem. */
export function RequirementTag({ requirement }: { requirement: ProfileRequirement }) {
  const c = REQUIREMENT_TAG_COLORS[requirement];
  return (
    <View style={[styles.tag, { backgroundColor: c.surface }]} testID={`guard-profile-requirement-${requirement}`}>
      <Text style={[styles.tagText, { color: c.text }]}>{REQUIREMENT_LABELS[requirement].label}</Text>
    </View>
  );
}

/** A status fact (SIA validity, deployment). Coloured only when it is good news or a real problem. */
export function StatusPill({ label, tone, testID }: { label: string; tone: Tone; testID?: string }) {
  const c = PROFILE_TONE_COLORS[tone];
  return (
    <View style={[styles.pill, { backgroundColor: c.surface }]} testID={testID}>
      <Text style={[styles.pillText, { color: c.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: profileTokens.shape.tagRadius,
  },
  tagText: { ...profileTokens.type.sectionLabel },
  pill: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: profileTokens.shape.tagRadius,
  },
  pillText: { ...profileTokens.type.value },
});
