import { StyleSheet, View } from 'react-native';

/**
 * UX-02A — the Guard header's two icons, drawn with plain Views: an outline bell (Notifications) and a cross (Close
 * notifications). No icon font or new dependency, so nothing loads asynchronously (no blank glyph on first paint) and
 * they render identically on Android, iOS, web and in the specs' test renderer. Decorative only: the Pressable that
 * holds them carries the accessible name ("Notifications, 3 unread" / "Close notifications").
 *
 * Both sit in a 24dp box and use a 2dp stroke, the weight of the header's text controls they replace.
 */
const BOX = 24;
const STROKE = 2;

export function GuardBellIcon({ color }: { color: string }) {
  return (
    <View style={styles.box} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden testID="guard-header-bell-icon">
      <View style={[styles.knob, { backgroundColor: color }]} />
      <View style={[styles.dome, { borderColor: color }]} />
      <View style={[styles.rim, { backgroundColor: color }]} />
      <View style={[styles.clapper, { backgroundColor: color }]} />
    </View>
  );
}

export function GuardCloseIcon({ color }: { color: string }) {
  return (
    <View style={styles.box} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden testID="guard-header-close-icon">
      <View style={[styles.bar, { backgroundColor: color, transform: [{ rotate: '45deg' }] }]} />
      <View style={[styles.bar, { backgroundColor: color, transform: [{ rotate: '-45deg' }] }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center' },
  knob: { width: STROKE + 1, height: STROKE + 1, borderRadius: 2, marginBottom: -1 },
  // The bell's dome: an outline with a rounded top and straight sides, open at the bottom where the rim closes it.
  dome: { width: 15, height: 12, borderWidth: STROKE, borderBottomWidth: 0, borderTopLeftRadius: 7.5, borderTopRightRadius: 7.5 },
  rim: { width: 19, height: STROKE, borderRadius: 1 },
  clapper: { width: 6, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, marginTop: 1 },
  bar: { position: 'absolute', width: 18, height: STROKE, borderRadius: 1 },
});
