import { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type FeatureCardProps = PropsWithChildren<{
  title: string;
  subtitle: string;
  ctaLabel?: string;
  onPress?: () => void;
  style?: any;
}>;

export function FeatureCard({ title, subtitle, ctaLabel, onPress, children, style }: FeatureCardProps) {
  return (
    <View style={[styles.card, style]}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
      {children}
      {ctaLabel && onPress ? (
        <Pressable onPress={onPress} style={styles.button}>
          <Text style={styles.buttonText}>{ctaLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 8,
  },
  title: { fontWeight: '700', fontSize: 16, color: '#111827' },
  subtitle: { color: '#374151' },
  button: {
    backgroundColor: '#111827',
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
