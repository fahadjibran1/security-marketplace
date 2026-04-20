import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type CardTone = 'default' | 'success' | 'warning' | 'danger';

type CardProps = React.PropsWithChildren<{
  title?: string;
  subtitle?: string;
  tone?: CardTone;
  right?: any;
  onPress?: () => void;
  style?: any;
}>;

const TONE_STYLES: Record<CardTone, { borderColor: string; headerColor: string; wash: string }> = {
  default: { borderColor: '#e5e7eb', headerColor: '#111827', wash: '#ffffff' },
  success: { borderColor: 'rgba(16, 185, 129, 0.35)', headerColor: '#064e3b', wash: '#ffffff' },
  warning: { borderColor: 'rgba(249, 115, 22, 0.35)', headerColor: '#7c2d12', wash: '#ffffff' },
  danger: { borderColor: 'rgba(239, 68, 68, 0.35)', headerColor: '#7f1d1d', wash: '#ffffff' },
};

export function Card({ title, subtitle, tone = 'default', right, onPress, children, style }: CardProps) {
  const toneStyle = TONE_STYLES[tone] || TONE_STYLES.default;
  const Container: any = onPress ? Pressable : View;

  return (
    <Container
      {...(onPress ? ({ onPress, onClick: onPress } as const) : {})}
      style={({ hovered, pressed }: any) => [
        styles.card,
        { borderColor: toneStyle.borderColor, backgroundColor: toneStyle.wash },
        hovered && onPress ? styles.cardHover : null,
        pressed && onPress ? styles.cardPressed : null,
        style,
      ]}
    >
      {title || subtitle || right ? (
        <View style={styles.header}>
          <View style={styles.headerText}>
            {title ? <Text style={[styles.title, { color: toneStyle.headerColor }]}>{title}</Text> : null}
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          {right ? <View style={styles.headerRight}>{right}</View> : null}
        </View>
      ) : null}
      {children ? <View style={styles.body}>{children}</View> : null}
    </Container>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    shadowColor: '#0f172a',
    shadowOpacity: 0.06,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  cardHover: {
    shadowOpacity: 0.1,
    transform: [{ translateY: -1 }],
  },
  cardPressed: {
    transform: [{ translateY: 0 }],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  headerRight: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  title: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  subtitle: {
    fontSize: 12,
    color: '#64748b',
    lineHeight: 16,
  },
  body: {
    marginTop: 12,
    gap: 10,
  },
});

