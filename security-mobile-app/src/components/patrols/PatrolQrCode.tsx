import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, typography } from '../../theme';
import { qrMatrix } from './patrolQr';

/**
 * A checkpoint QR drawn from the SERVER-ISSUED label payload as a grid of squares (no canvas, no SVG dependency), so it
 * renders identically on web and native. A payload that is not a server label is refused, never repaired.
 */
export function PatrolQrCode({ payload, size = 160 }: { payload: string; size?: number }) {
  const matrix = React.useMemo(() => qrMatrix(payload), [payload]);
  if (!matrix) {
    return (
      <View style={[styles.invalid, { width: size, height: size }]} accessibilityRole="text">
        <Text style={styles.invalidText}>Label unavailable</Text>
      </View>
    );
  }
  const quiet = 2;
  const cell = Math.max(1, Math.floor(size / (matrix.length + quiet * 2)));
  const side = cell * (matrix.length + quiet * 2);
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="Checkpoint QR code"
      testID="patrol-qr"
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
  invalid: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.dangerBorder, backgroundColor: colors.dangerSurface },
  invalidText: { ...typography.caption, color: colors.danger },
});
