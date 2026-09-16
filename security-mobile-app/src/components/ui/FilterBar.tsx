import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, control, radii, spacing, typography } from '../../theme';

const IS_WEB = typeof document !== 'undefined';

export type FilterChip = {
  id: string;
  label: string;
  active: boolean;
  onToggle: () => void;
};

type FilterBarProps = {
  /** Controlled search value. Omit to hide the search input. */
  searchValue?: string;
  searchPlaceholder?: string;
  onSearchChange?: (value: string) => void;
  /** Status / category filter chips. */
  filters?: FilterChip[];
  /** Called when the user taps "Clear all". Only shown when ≥1 filter is active. */
  onClearAll?: () => void;
  /** Slot for a primary action button (e.g. "Add Guard") aligned to the right. */
  right?: any;
  style?: any;
};

/**
 * FilterBar — search input + filter chips + optional primary action.
 *
 * This is a presentation primitive. Connect it to page business logic in
 * individual workspace screens.
 */
export function FilterBar({
  searchValue,
  searchPlaceholder,
  onSearchChange,
  filters = [],
  onClearAll,
  right,
  style,
}: FilterBarProps) {
  const hasActiveFilters = filters.some((f) => f.active);
  const showSearch = onSearchChange !== undefined;
  const showChips  = filters.length > 0;

  return (
    <View style={[styles.container, style]}>
      <View style={styles.row}>
        {showSearch ? (
          <View style={styles.searchWrap}>
            <Text accessible={false} style={styles.searchIcon}>🔍</Text>
            <TextInput
              value={searchValue}
              onChangeText={onSearchChange}
              placeholder={searchPlaceholder ?? 'Search…'}
              placeholderTextColor={colors.fieldPlaceholder}
              returnKeyType="search"
              clearButtonMode="while-editing"
              style={[styles.searchInput, IS_WEB ? (styles.searchInputWeb as any) : null]}
            />
          </View>
        ) : null}

        {right ? <View style={styles.rightSlot}>{right}</View> : null}
      </View>

      {showChips ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsContent}
          keyboardShouldPersistTaps="handled"
        >
          {filters.map((f) => (
            <Pressable
              key={f.id}
              onPress={f.onToggle}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: f.active }}
              accessibilityLabel={f.label}
              style={({ pressed }: any) => [
                styles.chip,
                f.active  ? styles.chipActive  : null,
                pressed   ? styles.chipPressed : null,
                IS_WEB    ? (styles.chipCursor as any) : null,
              ]}
            >
              <Text style={[styles.chipLabel, f.active ? styles.chipLabelActive : null]}>
                {f.label}
              </Text>
            </Pressable>
          ))}

          {hasActiveFilters && onClearAll ? (
            <Pressable
              onPress={onClearAll}
              accessibilityRole="button"
              accessibilityLabel="Clear all filters"
              style={[styles.chip, styles.clearChip, IS_WEB ? (styles.chipCursor as any) : null]}
            >
              <Text style={styles.clearChipLabel}>✕ Clear</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    minHeight: control.buttonHeightMd,
    gap: spacing.sm,
  },
  searchIcon: {
    fontSize: 13,
    lineHeight: 20,
  },
  searchInput: {
    flex: 1,
    ...typography.body,
    color: colors.textPrimary,
    paddingVertical: 0,
  },
  searchInputWeb: {
    outlineStyle: 'none',
  } as any,
  rightSlot: {
    flexShrink: 0,
  },
  chipsContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.xs,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
    minHeight: 32,
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: colors.primaryNavy,
    borderColor: colors.primaryNavy,
  },
  chipPressed: {
    opacity: 0.8,
  },
  chipCursor: { cursor: 'pointer' } as any,
  chipLabel: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
    color: colors.textSecondary,
  },
  chipLabelActive: {
    color: colors.textOnBrand,
  },
  clearChip: {
    borderColor: 'transparent',
    backgroundColor: 'transparent',
  },
  clearChipLabel: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
    color: colors.danger,
  },
});
