import { StyleSheet, Text, View } from 'react-native';
import { PRIVACY_COPY, privacySummary, type PrivacyTopic } from './profileCopy';
import { profileTokens } from './profileTheme';

const TOPICS: ReadonlyArray<[PrivacyTopic, string]> = [
  ['taxIdentifiers', 'Tax identifiers (NINO and UTR)'],
  ['drivingLicence', 'Driving licence number'],
  ['emergencyContact', 'Emergency contact'],
  ['bankDetails', 'Bank details'],
];

/**
 * S4 Guard Profile — "Who can see your information" (Profile Phase 2C, Privacy & account).
 *
 * One line per sensitive topic, derived from PRIVACY_COPY (the table checked against the backend's access rules), so
 * it cannot drift from the full notes shown beside each field in its own section.
 */
export function GuardPrivacySummary() {
  return (
    <View style={styles.card} testID="guard-privacy-summary">
      <Text style={styles.title} accessibilityRole="header">Who can see your information</Text>
      {TOPICS.map(([topic, label]) => (
        <View key={topic} style={styles.row} testID={`guard-privacy-summary-${topic}`}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.body}>{privacySummary(topic)}</Text>
        </View>
      ))}
      {TOPICS.every(([topic]) => PRIVACY_COPY[topic].encryptedAtRest) ? (
        <Text style={styles.body}>All of these are encrypted at rest. The full explanation is shown next to each one in its section.</Text>
      ) : null}
    </View>
  );
}

const t = profileTokens;
const styles = StyleSheet.create({
  card: {
    gap: 10,
    padding: 12,
    borderRadius: t.shape.cardRadius,
    borderWidth: t.shape.cardBorderWidth,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  title: { ...t.type.value, fontFamily: t.type.button.fontFamily, color: t.colors.textPrimary },
  // UX-02 Package B: divided rows (topic, then who can see it), the same compact hierarchy as the other sections.
  row: { gap: 2, borderTopWidth: 1, borderTopColor: t.colors.border, paddingTop: 8 },
  label: { ...t.type.value, color: t.colors.textPrimary },
  body: { ...t.type.body, color: t.colors.textSecondary },
});
