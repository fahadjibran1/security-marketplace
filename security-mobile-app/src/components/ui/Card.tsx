import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

const IS_WEB = typeof document !== 'undefined';

type CardTone = 'default' | 'success' | 'warning' | 'danger';

type CardProps = React.PropsWithChildren<{
  title?: string;
  subtitle?: string;
  tone?: CardTone;
  right?: any;
  onPress?: () => void;
  style?: any;
  /** Subtle hover lift on web for non-pressable cards (e.g. dashboard panels). */
  webSurfaceHover?: boolean;
}>;

const TONE_STYLES: Record<CardTone, { borderColor: string; headerColor: string; wash: string }> = {
  default: { borderColor: '#e8edf3', headerColor: '#111827', wash: '#ffffff' },
  success: { borderColor: 'rgba(16, 185, 129, 0.35)', headerColor: '#064e3b', wash: '#ffffff' },
  warning: { borderColor: 'rgba(249, 115, 22, 0.35)', headerColor: '#7c2d12', wash: '#ffffff' },
  danger: { borderColor: 'rgba(239, 68, 68, 0.35)', headerColor: '#7f1d1d', wash: '#ffffff' },
};

export function Card({ title, subtitle, tone = 'default', right, onPress, children, style, webSurfaceHover }: CardProps) {
  const toneStyle = TONE_STYLES[tone] || TONE_STYLES.default;
  const [surfaceHovered, setSurfaceHovered] = React.useState(false);

  const headerBlock =
    title || subtitle || right ? (
      <View style={styles.header}>
        <View style={styles.headerText}>
          {title ? <Text style={[styles.title, { color: toneStyle.headerColor }]}>{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        {right ? <View style={styles.headerRight}>{right}</View> : null}
      </View>
    ) : null;

  const bodyBlock = children ? <View style={styles.body}>{children}</View> : null;

  const baseStyle = [
    styles.card,
    { borderColor: toneStyle.borderColor, backgroundColor: toneStyle.wash },
    style,
  ];

  if (onPress) {
    return (
      <Pressable
        {...({ onPress, onClick: onPress } as const)}
        style={({ hovered, pressed }: any) => [
          ...baseStyle,
          hovered ? styles.cardHover : null,
          pressed ? styles.cardPressed : null,
          IS_WEB && webSurfaceHover && hovered && !pressed ? styles.cardSurfaceHoverWeb : null,
          IS_WEB ? (styles.cardCursorPointer as any) : null,
        ]}
      >
        {headerBlock}
        {bodyBlock}
      </Pressable>
    );
  }

  const viewStyle = [
    ...baseStyle,
    IS_WEB && webSurfaceHover && surfaceHovered ? styles.cardSurfaceHoverWeb : null,
    IS_WEB && webSurfaceHover ? (styles.cardCursorDefault as any) : null,
  ];

  if (IS_WEB && webSurfaceHover) {
    return (
      <View
        onPointerEnter={() => setSurfaceHovered(true)}
        onPointerLeave={() => setSurfaceHovered(false)}
        style={viewStyle}
      >
        {headerBlock}
        {bodyBlock}
      </View>
    );
  }

  return (
    <View style={viewStyle}>
      {headerBlock}
      {bodyBlock}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    shadowColor: '#0f172a',
    shadowOpacity: 0.045,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  cardHover: {
    shadowOpacity: 0.075,
    transform: [{ translateY: -1 }],
  },
  cardPressed: {
    transform: [{ translateY: 0 }],
  },
  cardSurfaceHoverWeb: {
    shadowOpacity: 0.09,
    borderColor: 'rgba(15, 23, 42, 0.12)',
    transform: [{ translateY: -1 }],
  } as any,
  cardCursorPointer: {
    cursor: 'pointer',
  } as any,
  cardCursorDefault: {
    cursor: 'default',
  } as any,
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
    letterSpacing: 0.12,
  },
  subtitle: {
    fontSize: 12,
    color: '#64748b',
    lineHeight: 18,
    fontWeight: '500',
  },
  body: {
    marginTop: 14,
    gap: 12,
  },
});
