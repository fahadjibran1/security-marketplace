import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';

const IS_WEB = typeof document !== 'undefined';

type CardTone = 'default' | 'success' | 'warning' | 'danger';

type CardProps = React.PropsWithChildren<{
  title?: string;
  subtitle?: string;
  tone?: CardTone;
  right?: any;
  onPress?: () => void;
  style?: any;
  webSurfaceHover?: boolean;
  /** When set, the title is exposed to assistive technology as a heading of this level. */
  headingLevel?: 2 | 3;
  /** Desktop control-room density: 16px padding and tighter body spacing. Default keeps 24px. */
  density?: 'default' | 'compact';
}>;

const TONE_STYLES: Record<CardTone, { borderColor: string; headerColor: string; wash: string }> = {
  default: { borderColor: colors.border,                      headerColor: colors.primaryNavy,  wash: colors.card },
  success: { borderColor: colors.successBorder,               headerColor: colors.success,       wash: colors.card },
  warning: { borderColor: colors.warningBorder,               headerColor: colors.warning,       wash: colors.card },
  danger:  { borderColor: colors.dangerBorder,                headerColor: colors.danger,        wash: colors.card },
};

export function Card({ title, subtitle, tone = 'default', right, onPress, children, style, webSurfaceHover, headingLevel, density = 'default' }: CardProps) {
  const compact = density === 'compact';
  const toneStyle = TONE_STYLES[tone] || TONE_STYLES.default;
  const [surfaceHovered, setSurfaceHovered] = React.useState(false);
  const headingProps = headingLevel
    ? ({ accessibilityRole: 'header', 'aria-level': headingLevel } as any)
    : null;

  const headerBlock =
    title || subtitle || right ? (
      <View style={styles.header}>
        <View style={styles.headerText}>
          {title    ? <Text {...headingProps} style={[styles.title, compact ? styles.titleCompact : null, { color: toneStyle.headerColor }]}>{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text>                                      : null}
        </View>
        {right ? <View style={styles.headerRight}>{right}</View> : null}
      </View>
    ) : null;

  const bodyBlock = children ? <View style={[styles.body, compact ? styles.bodyCompact : null]}>{children}</View> : null;

  const baseStyle = [
    styles.card,
    compact ? styles.cardCompact : null,
    { borderColor: toneStyle.borderColor, backgroundColor: toneStyle.wash },
    style,
  ];

  if (onPress) {
    return (
      <Pressable
        {...({ onPress, onClick: onPress } as const)}
        style={({ hovered, pressed }: any) => [
          ...baseStyle,
          hovered  && !pressed ? styles.cardHover   : null,
          pressed              ? styles.cardPressed  : null,
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
    borderRadius: radii.card,
    padding: spacing.xl,
    borderWidth: 1,
    shadowColor: colors.primaryNavy,
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  cardHover: {
    shadowOpacity: 0.07,
    transform: [{ translateY: -1 }],
  },
  cardPressed: {
    transform: [{ translateY: 0 }],
  },
  cardSurfaceHoverWeb: {
    shadowOpacity: 0.08,
    borderColor: colors.fieldBorder,
    transform: [{ translateY: -1 }],
  } as any,
  cardCursorPointer: { cursor: 'pointer'  } as any,
  cardCursorDefault: { cursor: 'default'  } as any,
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  headerText: { flex: 1, gap: 2 },
  headerRight: { alignItems: 'flex-end', justifyContent: 'center' },
  title: {
    ...typography.panelHeading,
    letterSpacing: 0.1,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
    fontWeight: '500',
  },
  body: {
    marginTop: spacing.md,
    gap: spacing.md,
  },
  cardCompact: { padding: spacing.lg },
  titleCompact: { fontSize: 16, lineHeight: 21 },
  bodyCompact: { marginTop: spacing.sm, gap: spacing.sm },
});
