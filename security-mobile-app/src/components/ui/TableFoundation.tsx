/**
 * TableFoundation — reusable table row, header, and cell primitives.
 *
 * These are presentation-only components. Data sourcing and pagination are
 * wired up by individual workspace screens in later phases.
 *
 * Usage pattern:
 *   <TableHeader>
 *     <TableHeaderCell label="Guard" flex={2} />
 *     <TableHeaderCell label="Site" flex={2} />
 *     <TableHeaderCell label="Status" flex={1} />
 *     <TableHeaderCell label="" width={52} />
 *   </TableHeader>
 *   {rows.map(row => (
 *     <TableRow key={row.id} onPress={() => openDetail(row.id)}>
 *       <PrimaryCell label={row.name} subtitle={row.ref} flex={2} />
 *       <MetaCell value={row.site} flex={2} />
 *       <StatusCell label={row.status} flex={1} />
 *       <ActionCell><IconButton icon="›" accessibilityLabel="View" onPress={...} /></ActionCell>
 *     </TableRow>
 *   ))}
 */

import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../../theme';
import { StatusBadge, StatusTone } from '../StatusBadge';

const IS_WEB = typeof document !== 'undefined';

// ─── TableHeader ──────────────────────────────────────────────────────────────

type TableHeaderProps = React.PropsWithChildren<{
  style?: any;
}>;

export function TableHeader({ children, style }: TableHeaderProps) {
  return <View style={[styles.header, style]}>{children}</View>;
}

// ─── TableHeaderCell ─────────────────────────────────────────────────────────

type TableHeaderCellProps = {
  label: string;
  flex?: number;
  align?: 'left' | 'right' | 'center';
  width?: number;
  style?: any;
};

export function TableHeaderCell({ label, flex = 1, align = 'left', width, style }: TableHeaderCellProps) {
  return (
    <View style={[styles.headerCell, width ? null : (flex ? { flex } : null), width ? { flexBasis: width, flexShrink: 0, flexGrow: 0 } : null, style]}>
      {label ? (
        <Text style={[styles.headerCellText, align !== 'left' ? { textAlign: align } : null]} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

// ─── TableRow ─────────────────────────────────────────────────────────────────

type TableRowProps = React.PropsWithChildren<{
  onPress?: () => void;
  selected?: boolean;
  style?: any;
}>;

export function TableRow({ children, onPress, selected, style }: TableRowProps) {
  const baseStyle = [styles.row, selected ? styles.rowSelected : null, style];

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={({ hovered, pressed }: any) => [
          ...baseStyle,
          IS_WEB && hovered && !pressed ? styles.rowHover   : null,
          IS_WEB && pressed             ? styles.rowPressed : null,
          IS_WEB ? (styles.rowCursor as any) : null,
        ]}
      >
        {children}
      </Pressable>
    );
  }

  return <View style={baseStyle}>{children}</View>;
}

// ─── TableCell ────────────────────────────────────────────────────────────────

type TableCellProps = React.PropsWithChildren<{
  flex?: number;
  width?: number;
  align?: 'left' | 'right' | 'center';
  style?: any;
}>;

export function TableCell({ children, flex = 1, width, align = 'left', style }: TableCellProps) {
  return (
    <View
      style={[
        styles.cell,
        width ? null : (flex ? { flex } : null),
        width ? { flexBasis: width, flexShrink: 0, flexGrow: 0 } : null,
        align === 'right'  ? styles.cellRight  : null,
        align === 'center' ? styles.cellCenter : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ─── PrimaryCell ─────────────────────────────────────────────────────────────

type PrimaryCellProps = {
  label: string;
  subtitle?: string;
  flex?: number;
  style?: any;
};

/** Entity name cell — receives enough flex to prevent wrapping before secondary columns collapse. */
export function PrimaryCell({ label, subtitle, flex = 2, style }: PrimaryCellProps) {
  return (
    <TableCell flex={flex} style={style}>
      <Text style={styles.primaryLabel} numberOfLines={1}>{label}</Text>
      {subtitle ? <Text style={styles.primarySubtitle} numberOfLines={1}>{subtitle}</Text> : null}
    </TableCell>
  );
}

// ─── MetaCell ─────────────────────────────────────────────────────────────────

type MetaCellProps = {
  value: string;
  flex?: number;
  align?: 'left' | 'right';
  style?: any;
};

export function MetaCell({ value, flex = 1, align = 'left', style }: MetaCellProps) {
  return (
    <TableCell flex={flex} align={align} style={style}>
      <Text style={styles.metaValue} numberOfLines={1}>{value}</Text>
    </TableCell>
  );
}

// ─── StatusCell ───────────────────────────────────────────────────────────────

type StatusCellProps = {
  label: string;
  tone?: StatusTone;
  flex?: number;
  style?: any;
};

export function StatusCell({ label, tone, flex = 1, style }: StatusCellProps) {
  return (
    <TableCell flex={flex} style={style}>
      <StatusBadge label={label} tone={tone} size="small" />
    </TableCell>
  );
}

// ─── ActionCell ───────────────────────────────────────────────────────────────

type ActionCellProps = React.PropsWithChildren<{
  width?: number;
  style?: any;
}>;

/** Fixed-width right-aligned cell for row action controls. */
export function ActionCell({ children, width = 52, style }: ActionCellProps) {
  return (
    <View style={[styles.cell, styles.actionCell, { flexBasis: width, flexShrink: 0, flexGrow: 0 }, style]}>
      {children}
    </View>
  );
}

// ─── TableEmptyState ─────────────────────────────────────────────────────────

type TableEmptyStateProps = {
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
};

export function TableEmptyState({ message, actionLabel, onAction }: TableEmptyStateProps) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>{message ?? 'No records found.'}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} style={styles.emptyAction} accessibilityRole="button">
          <Text style={styles.emptyActionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSubtle,
  },
  headerCell: {
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
  },
  headerCellText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    lineHeight: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
    minHeight: 52,
  },
  rowSelected: {
    backgroundColor: colors.accentTealSoft,
  },
  rowHover:   { backgroundColor: colors.surfaceSubtle } as any,
  rowPressed: { backgroundColor: colors.border        } as any,
  rowCursor:  { cursor: 'pointer'                      } as any,
  cell: {
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  cellRight:  { alignItems: 'flex-end' },
  cellCenter: { alignItems: 'center'   },
  primaryLabel: {
    ...typography.label,
    fontSize: 13,
    color: colors.textPrimary,
  },
  primarySubtitle: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
    marginTop: 1,
  },
  metaValue: {
    ...typography.tableRow,
    color: colors.textSecondary,
  },
  actionCell: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
  },
  emptyState: {
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  emptyText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  emptyAction: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  emptyActionText: {
    ...typography.label,
    color: colors.accentTeal,
  },
});
