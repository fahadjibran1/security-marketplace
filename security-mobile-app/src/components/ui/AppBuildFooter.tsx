import * as React from 'react';
import Constants from 'expo-constants';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../../theme';
import { formatBuildInfoLines, resolveAppBuildInfo } from '../../services/appBuildInfo';

/** The live runtime values for this running app. Never hard-coded — see appBuildInfo.ts. */
function liveBuildInfo() {
  const config = Constants.expoConfig;
  return resolveAppBuildInfo({
    version: config?.version ?? null,
    androidVersionCode: config?.android?.versionCode ?? null,
    iosBuildNumber: config?.ios?.buildNumber ?? null,
    // Set per EAS build profile (the pilot profile sets "pilot"). A build label only, never a secret.
    buildLabel: process.env.EXPO_PUBLIC_BUILD_LABEL ?? null,
    platform: Platform.OS,
  });
}

/**
 * Read-only build provenance, for the bottom of a profile/settings area only — never an operational
 * screen. It exists so a UAT tester can state exactly which build they are running without adb or an
 * EAS lookup. Values come from runtime configuration (see appBuildInfo.ts), never hard-coded text.
 */
export function AppBuildFooter({ appLabel }: { appLabel: string }) {
  const lines = React.useMemo(() => formatBuildInfoLines(liveBuildInfo(), appLabel), [appLabel]);
  return (
    <View style={styles.root} accessibilityLabel="App version information">
      {lines.map((line, index) => (
        <Text key={line} style={index === 0 ? styles.appName : styles.detail} selectable>
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    alignItems: 'center',
    gap: 2,
  },
  appName: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  detail: { fontSize: 11, color: colors.textMuted },
});
