import { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

type FeatureCardProps = PropsWithChildren<{
  title: string;
  subtitle: string;
  ctaLabel?: string;
  onPress?: () => void;
  style?: any;
}>;

export function FeatureCard({ title, subtitle, ctaLabel, onPress, children, style }: FeatureCardProps) {
  const pressHandlers = onPress
    ? ({
        onPress,
        onClick: onPress,
      } as const)
    : {};

  return (
    <View style={[styles.card, style]}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
      {children}
      {ctaLabel && onPress ? (
        <Pressable {...pressHandlers} style={styles.button}>
          <Text style={styles.buttonText}>{ctaLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  title: { fontWeight: '700', fontSize: 16, color: colors.textPrimary, lineHeight: 22, flexShrink: 1 },
  subtitle: { color: colors.textSecondary, lineHeight: 20, flexShrink: 1 },
  button: {
    backgroundColor: colors.primaryNavy,
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});
