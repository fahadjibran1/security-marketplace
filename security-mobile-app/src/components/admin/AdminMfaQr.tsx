import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, typography } from '../../theme';
import { otpauthQrMatrix } from '../../navigation/admin-mfa';

/**
 * The otpauth:// enrolment URI as a QR code for an authenticator app, drawn as a grid of squares (no canvas, no SVG
 * dependency) exactly like the patrol checkpoint labels, so it renders the same on web and native. Anything that is not
 * an otpauth://totp/ URI is refused, never drawn.
 */
export function AdminMfaQr({ uri, size = 200 }: { uri: string; size?: number }) {
  const matrix = React.useMemo(() => otpauthQrMatrix(uri), [uri]);
  if (!matrix) {
    return (
      <View style={[styles.invalid, { width: size, height: size }]} accessibilityRole="text">
        <Text style={styles.invalidText}>QR code unavailable — use the setup key below.</Text>
      </View>
    );
  }
  const quiet = 4;
  const cell = Math.max(1, Math.floor(size / (matrix.length + quiet * 2)));
  const side = cell * (matrix.length + quiet * 2);
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="QR code for your authenticator app"
      testID="admin-mfa-qr"
      style={[styles.frame, { width: side, height: side, padding: cell * quiet }]}
    >
      {matrix.map((row, r) => (
        <View key={r} style={styles.row}>
          {row.map((dark, c) => (
            <View key={c} style={{ width: cell, height: cell, backgroundColor: dark ? '#000000' : '#FFFFFF' }} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: '#FFFFFF' },
  row: { flexDirection: 'row' },
  invalid: { alignItems: 'center', justifyContent: 'center', padding: 8, borderWidth: 1, borderColor: colors.dangerBorder, backgroundColor: colors.dangerSurface },
  invalidText: { ...typography.caption, color: colors.danger, textAlign: 'center' },
});
