import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../../theme';

type PageHeaderProps = React.PropsWithChildren<{
  title: string;
  description?: string;
  meta?: string;
  style?: any;
}>;

/**
 * PageHeader — lightweight page-level title block.
 *
 * Place at the top of the scrollable content area for each section.
 * Pass action buttons (e.g. "+ Add Client") as children — they align right.
 *
 * Phase 1E+ will add section-specific actions here.
 */
export function PageHeader({ title, description, meta, children, style }: PageHeaderProps) {
  return (
    <View style={[styles.header, style]}>
      <View style={styles.copy}>
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        {description ? <Text style={styles.description} numberOfLines={2}>{description}</Text> : null}
      </View>
      {children ? <View style={styles.actions}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingBottom: spacing.lg,
    marginBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.lg,
  },
  copy: {
    flex: 1,
    gap: spacing.xs,
    minWidth: 0,
  },
  meta: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  title: {
    ...typography.pageTitle,
    color: colors.primaryNavy,
    letterSpacing: -0.5,
  },
  description: {
    ...typography.body,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 0,
    paddingTop: spacing.xs,
  },
});
