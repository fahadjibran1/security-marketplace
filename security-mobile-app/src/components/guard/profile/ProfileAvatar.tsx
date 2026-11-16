import { Image, StyleSheet, Text, View } from 'react-native';
import { profileTokens } from './profileTheme';

/**
 * S4 Guard Profile — the circular profile avatar (Profile Phase 2C, approved decision 5).
 *
 * Initials only for now. `imageUri` reserves the place for an optional photo; nothing passes one yet, because photo
 * capture and upload are not built (approved decision 6) and the backend stores no Guard photo. The avatar is
 * decorative: the Guard's name is read out next to it, so screen readers skip it.
 */
export function ProfileAvatar({ initials, size = 56, imageUri = null }: { initials: string; size?: number; imageUri?: string | null }) {
  const box = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View
      style={[styles.avatar, box]}
      testID="guard-profile-avatar"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={box} testID="guard-profile-avatar-image" />
      ) : (
        // Initials scale only a little with large text: the circle is fixed, and the name beside it carries the meaning.
        <Text style={[styles.initials, { fontSize: Math.round(size * 0.36) }]} maxFontSizeMultiplier={1.2} testID="guard-profile-avatar-initials">
          {initials}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: profileTokens.colors.accent,
    flexShrink: 0,
  },
  initials: { ...profileTokens.type.button, color: profileTokens.colors.onAccent, lineHeight: undefined },
});
