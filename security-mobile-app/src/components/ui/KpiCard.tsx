import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export type KpiTone = 'neutral' | 'good' | 'warning' | 'attention';

type KpiCardProps = {
  label: string;
  value: string;
  icon: string;
  tone?: KpiTone;
  onPress?: () => void;
};

const TONE: Record<KpiTone, { pillBg: string; pillText: string; iconBg: string; value: string; border: string }> = {
  neutral: {
    pillBg: 'rgba(15, 23, 42, 0.06)',
    pillText: '#0f172a',
    iconBg: 'rgba(37, 99, 235, 0.10)',
    value: '#0f172a',
    border: '#e5e7eb',
  },
  good: {
    pillBg: 'rgba(16, 185, 129, 0.12)',
    pillText: '#065f46',
    iconBg: 'rgba(16, 185, 129, 0.14)',
    value: '#064e3b',
    border: 'rgba(16, 185, 129, 0.26)',
  },
  warning: {
    pillBg: 'rgba(249, 115, 22, 0.12)',
    pillText: '#9a3412',
    iconBg: 'rgba(249, 115, 22, 0.14)',
    value: '#7c2d12',
    border: 'rgba(249, 115, 22, 0.26)',
  },
  attention: {
    pillBg: 'rgba(239, 68, 68, 0.12)',
    pillText: '#991b1b',
    iconBg: 'rgba(239, 68, 68, 0.14)',
    value: '#7f1d1d',
    border: 'rgba(239, 68, 68, 0.26)',
  },
};

export function KpiCard({ label, value, icon, tone = 'neutral', onPress }: KpiCardProps) {
  const toneStyle = TONE[tone] || TONE.neutral;
  const Container: any = onPress ? Pressable : View;

  return (
    <Container
      {...(onPress ? ({ onPress, onClick: onPress } as const) : {})}
      style={({ hovered, pressed }: any) => [
        styles.card,
        { borderColor: toneStyle.border },
        hovered && onPress ? styles.cardHover : null,
        pressed && onPress ? styles.cardPressed : null,
      ]}
    >
      <View style={styles.topRow}>
        <View style={[styles.iconPuck, { backgroundColor: toneStyle.iconBg }]}>
          <Text style={styles.iconText}>{icon}</Text>
        </View>
        <View style={[styles.tonePill, { backgroundColor: toneStyle.pillBg }]}>
          <Text style={[styles.tonePillText, { color: toneStyle.pillText }]}>{label}</Text>
        </View>
      </View>
      <Text style={[styles.value, { color: toneStyle.value }]}>{value}</Text>
    </Container>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    shadowColor: '#0f172a',
    shadowOpacity: 0.06,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    gap: 12,
    minHeight: 96,
  },
  cardHover: {
    shadowOpacity: 0.12,
    transform: [{ translateY: -1 }],
  },
  cardPressed: {
    transform: [{ translateY: 0 }],
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  iconPuck: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: {
    fontSize: 16,
    fontWeight: '700',
  },
  tonePill: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  tonePillText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  value: {
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
});

