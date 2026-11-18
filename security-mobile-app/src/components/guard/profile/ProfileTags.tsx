import { StyleSheet, Text, View } from 'react-native';
import type { Tone } from './profileOverview';
import { PROFILE_TONE_COLORS, profileTokens } from './profileTheme';

/**
 * A requirement level ("Required", "By invitation"…) as plain secondary text (UX-02A). It replaced a neutral grey pill:
 * the seven identical pills carried no meaning in their colour, only in their words, so the words stay and the pill
 * goes. Never coloured: a requirement is not a problem.
 */
export function RequirementText({ text, testID }: { text: string; testID?: string }) {
  return <Text style={styles.requirement} testID={testID}>{text}</Text>;
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
  requirement: { ...profileTokens.type.requirement, color: profileTokens.colors.textSecondary, flexShrink: 1 },
  pill: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: profileTokens.shape.tagRadius,
  },
  pillText: { ...profileTokens.type.value },
});
