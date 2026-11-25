import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { S4_SUPPORT_EMAIL, openS4Link, s4Links, type S4LinkKey } from '../../constants/s4Links';
import { colors, control, spacing, typography } from '../../theme';

interface S4LegalLinksProps {
  /** Show "Support: info@…" under the links, for screens where the address itself is useful (account settings). */
  showSupportAddress?: boolean;
  /** Test seam: defaults to React Native's Linking. */
  linking?: { openURL: (url: string) => Promise<unknown> };
  testID?: string;
}

/**
 * Privacy Policy · Terms and Conditions · Support · Account Deletion — the S4 public pages and the support address
 * (src/constants/s4Links.ts), opened with the system browser or mail app. Shown on sign-in and on every account or
 * settings surface.
 */
export function S4LegalLinks({ showSupportAddress = false, linking = Linking, testID = 's4-legal-links' }: S4LegalLinksProps) {
  const open = (key: S4LinkKey) => { void openS4Link(key, linking); };
  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.row}>
        {s4Links().map((link) => (
          <Pressable
            key={link.key}
            accessibilityRole="link"
            accessibilityLabel={link.label}
            accessibilityHint={link.accessibilityHint}
            onPress={() => open(link.key)}
            style={styles.link}
            testID={`s4-link-${link.key}`}
          >
            <Text style={styles.linkText}>{link.label}</Text>
          </Pressable>
        ))}
      </View>
      {showSupportAddress ? <Text style={styles.caption}>Support: {S4_SUPPORT_EMAIL}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.md, rowGap: 0 },
  link: { minHeight: control.minTouchTarget, justifyContent: 'center' },
  linkText: { ...typography.caption, color: colors.accentTealStrong, fontWeight: '600', textDecorationLine: 'underline' },
  caption: { ...typography.caption, color: colors.textSecondary },
});
