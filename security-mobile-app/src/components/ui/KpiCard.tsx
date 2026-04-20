import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

const IS_WEB = typeof document !== 'undefined';

const WEB_POINTER = IS_WEB ? ({ cursor: 'pointer' } as const) : {};

export type KpiTone = 'neutral' | 'good' | 'warning' | 'attention';

type KpiCardProps = {
  label: string;
  value: string;
  icon: string;
  tone?: KpiTone;
  onPress?: () => void;
};

const TONE: Record<KpiTone, { iconBg: string; value: string; border: string }> = {
  neutral: {
    iconBg: 'rgba(37, 99, 235, 0.08)',
    value: '#0f172a',
    border: '#e8edf3',
  },
  good: {
    iconBg: 'rgba(16, 185, 129, 0.12)',
    value: '#064e3b',
    border: 'rgba(16, 185, 129, 0.22)',
  },
  warning: {
    iconBg: 'rgba(249, 115, 22, 0.12)',
    value: '#7c2d12',
    border: 'rgba(249, 115, 22, 0.22)',
  },
  attention: {
    iconBg: 'rgba(239, 68, 68, 0.12)',
    value: '#7f1d1d',
    border: 'rgba(239, 68, 68, 0.22)',
  },
};

export function KpiCard({ label, value, icon, tone = 'neutral', onPress }: KpiCardProps) {
  const toneStyle = TONE[tone] || TONE.neutral;
  const [surfaceHovered, setSurfaceHovered] = React.useState(false);

  const inner = (
    <View style={styles.cardInner}>
      <View style={styles.headerRow}>
        <Text style={styles.label} numberOfLines={2}>
          {label}
        </Text>
        <View style={[styles.iconPuck, { backgroundColor: toneStyle.iconBg }]}>
          <Text style={styles.iconText}>{icon}</Text>
        </View>
      </View>
      <Text
        style={[styles.value, { color: toneStyle.value }, IS_WEB ? (styles.valueWeb as any) : null]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
      >
        {value}
      </Text>
    </View>
  );

  const cardChrome = (hovered: boolean) => [
    styles.card,
    { borderColor: toneStyle.border },
    IS_WEB && hovered ? styles.kpiCardWebHover : null,
  ];

  if (onPress) {
    return (
      <Pressable
        {...({ onPress, onClick: onPress } as const)}
        style={({ hovered, pressed }: any) => [
          ...cardChrome(Boolean(hovered && !pressed)),
          hovered && !pressed ? styles.cardHover : null,
          pressed ? styles.cardPressed : null,
          WEB_POINTER as any,
        ]}
      >
        {inner}
      </Pressable>
    );
  }

  if (IS_WEB) {
    return (
      <View
        onPointerEnter={() => setSurfaceHovered(true)}
        onPointerLeave={() => setSurfaceHovered(false)}
        style={[...cardChrome(surfaceHovered), IS_WEB ? (styles.kpiCardWebCursor as any) : null]}
      >
        {inner}
      </View>
    );
  }

  return <View style={cardChrome(false)}>{inner}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 0,
    borderWidth: 1,
    shadowColor: '#0f172a',
    shadowOpacity: 0.045,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    minHeight: 118,
    flex: 1,
  },
  kpiCardWebHover: {
    shadowOpacity: 0.08,
    borderColor: 'rgba(15, 23, 42, 0.14)',
    transform: [{ translateY: -1 }],
  } as any,
  kpiCardWebCursor: {
    cursor: 'default',
  } as any,
  cardHover: {
    shadowOpacity: 0.08,
    transform: [{ translateY: -1 }],
  },
  cardPressed: {
    transform: [{ translateY: 0 }],
  },
  cardInner: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 18,
    justifyContent: 'space-between',
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  label: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    color: '#64748b',
    lineHeight: 16,
  },
  iconPuck: {
    width: 32,
    height: 32,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconText: {
    fontSize: 15,
    lineHeight: 18,
  },
  value: {
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -1,
    lineHeight: 40,
  },
  valueWeb: {
    fontVariantNumeric: 'tabular-nums',
  } as any,
});
