import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { type LogBookPeriod, type LogBookRow } from './logBookRegister';
import { colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

export type LogBookFilterOption = { label: string; value: string };

export type LogBookDayPeriod = LogBookPeriod & {
  /** The site and shift the period belongs to, already resolved for display. */
  siteName: string;
  shiftId: number;
  startLabel: string;
  endLabel: string;
  /** The entry that satisfied it, already formatted. Empty when none did. */
  completedLabel: string;
};

/**
 * Management → Log Book: the company's occurrence register. (Phase 4B.)
 *
 * An operational register, not an editable notes page. It reads oldest → newest within the chosen
 * day because that is how an occurrence book is read: a controller reconstructing a night starts at
 * the beginning of it.
 *
 * The register row abbreviates a long entry so the table stays scannable, and the row opens the full
 * entry — the abbreviation is never the only copy a reader can reach.
 */
export function CompanyLogBookWorkspace({
  rows,
  periods,
  date,
  onDateChange,
  search,
  onSearchChange,
  clientOptions,
  siteOptions,
  guardOptions,
  clientFilter,
  siteFilter,
  guardFilter,
  onClientFilter,
  onSiteFilter,
  onGuardFilter,
  onOpenEntry,
  onOpenDailySiteLog,
  dailySiteLogEnabled,
  timeLabel,
}: {
  rows: LogBookRow[];
  /** Required periods for the selected day. Empty for an "as required" site. */
  periods: LogBookDayPeriod[];
  date: string;
  onDateChange: (value: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  clientOptions: LogBookFilterOption[];
  siteOptions: LogBookFilterOption[];
  guardOptions: LogBookFilterOption[];
  clientFilter: string;
  siteFilter: string;
  guardFilter: string;
  onClientFilter: (value: string) => void;
  onSiteFilter: (value: string) => void;
  onGuardFilter: (value: string) => void;
  onOpenEntry: (entryId: number) => void;
  onOpenDailySiteLog: () => void;
  /** A Daily Site Log needs one site and one date; the control says so rather than failing. */
  dailySiteLogEnabled: boolean;
  timeLabel: (iso: string) => string;
}) {
  return (
    <View style={styles.shell}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Log Book</Text>
          <Text style={styles.subtitle}>
            The site occurrence record, in the order it happened.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Daily Site Log"
          accessibilityState={{ disabled: !dailySiteLogEnabled }}
          style={[
            styles.primaryBtn,
            !dailySiteLogEnabled ? styles.primaryBtnDisabled : null,
            IS_WEB ? (WEB_PTR as any) : null,
          ]}
          onPress={onOpenDailySiteLog}
          disabled={!dailySiteLogEnabled}
        >
          <Text style={styles.primaryBtnText}>Daily Site Log</Text>
        </Pressable>
      </View>
      {!dailySiteLogEnabled ? (
        <Text style={styles.hint}>Choose one site and one date to produce a Daily Site Log.</Text>
      ) : null}

      {/* Filters */}
      <View style={styles.filters}>
        <Field label="Date">
          <TextInput
            style={styles.input}
            value={date}
            onChangeText={onDateChange}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.fieldPlaceholder}
            accessibilityLabel="Log Book date"
          />
        </Field>
        <Field label="Client">
          <Picker options={clientOptions} value={clientFilter} onChange={onClientFilter} label="Client" />
        </Field>
        <Field label="Site">
          <Picker options={siteOptions} value={siteFilter} onChange={onSiteFilter} label="Site" />
        </Field>
        <Field label="Guard">
          <Picker options={guardOptions} value={guardFilter} onChange={onGuardFilter} label="Guard" />
        </Field>
        <Field label="Search" grow>
          <TextInput
            style={styles.input}
            value={search}
            onChangeText={onSearchChange}
            placeholder="Search entries, site or guard"
            placeholderTextColor={colors.fieldPlaceholder}
            accessibilityLabel="Search Log Book entries"
          />
        </Field>
      </View>

      {/* Required periods, when the site has an interval. */}
      {periods.length ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Required periods</Text>
          <View style={styles.periodWrap}>
            {periods.map((period) => (
              <View
                key={`${period.shiftId}-${period.index}`}
                style={[styles.period, PERIOD_STYLE[period.status] ?? null]}
              >
                <Text style={styles.periodTime}>{period.startLabel}–{period.endLabel}</Text>
                <Text style={[styles.periodState, PERIOD_TEXT[period.status] ?? null]}>
                  {PERIOD_LABEL[period.status] ?? 'Not required'}
                </Text>
                {period.completedLabel ? (
                  <Text style={styles.periodMeta}>{period.completedLabel} entry</Text>
                ) : null}
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* The register */}
      <View style={styles.panel}>
        <View style={styles.tableHead}>
          <Text style={[styles.cell, styles.colTime, styles.headCell]}>Time</Text>
          <Text style={[styles.cell, styles.colSite, styles.headCell]}>Site</Text>
          <Text style={[styles.cell, styles.colGuard, styles.headCell]}>Guard</Text>
          <Text style={[styles.cell, styles.colShift, styles.headCell]}>Shift</Text>
          <Text style={[styles.cell, styles.colEntry, styles.headCell]}>Entry</Text>
        </View>

        {rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No Log Book entries</Text>
            <Text style={styles.emptyDesc}>
              Nothing was recorded for this day and filter.
            </Text>
          </View>
        ) : (
          <ScrollView style={styles.tableScroll} nestedScrollEnabled showsVerticalScrollIndicator={IS_WEB}>
            {rows.map((row) => (
              <Pressable
                key={row.id}
                accessibilityRole="button"
                accessibilityLabel={`Open Log Book entry ${row.id}`}
                style={[styles.tableRow, IS_WEB ? (WEB_PTR as any) : null]}
                onPress={() => onOpenEntry(row.id)}
              >
                <Text style={[styles.cell, styles.colTime, styles.cellStrong]}>{timeLabel(row.at)}</Text>
                <Text style={[styles.cell, styles.colSite]} numberOfLines={1}>{row.siteName || '—'}</Text>
                <Text style={[styles.cell, styles.colGuard]} numberOfLines={1}>{row.guardName || '—'}</Text>
                <Text style={[styles.cell, styles.colShift]}>{row.shiftId ? `#${row.shiftId}` : '—'}</Text>
                {/* Abbreviated for the table; the full text opens from the row. */}
                <Text style={[styles.cell, styles.colEntry]} numberOfLines={2}>{row.message}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

function Field({ label, children, grow }: React.PropsWithChildren<{ label: string; grow?: boolean }>) {
  return (
    <View style={[styles.field, grow ? styles.fieldGrow : null]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

/** A small option list. Native has no <select>, so the same control serves both platforms. */
function Picker({
  options, value, onChange, label,
}: { options: LogBookFilterOption[]; value: string; onChange: (value: string) => void; label: string }) {
  return (
    <View style={styles.pickerRow}>
      {[{ label: 'All', value: '' }, ...options].map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value || 'all'}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`${label}: ${option.label}`}
            style={[styles.chip, selected ? styles.chipSelected : null, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={() => onChange(option.value)}
          >
            <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const PERIOD_LABEL: Record<string, string> = {
  completed: 'Completed',
  due: 'Due now',
  missing: 'Missing',
  not_applicable: 'Not required',
};
const PERIOD_STYLE: Record<string, any> = {
  completed: { borderColor: colors.successBorder, backgroundColor: colors.successSurface },
  due: { borderColor: colors.accentTeal, backgroundColor: colors.accentTealSoft },
  missing: { borderColor: colors.warningBorder, backgroundColor: colors.warningSurface },
};
/** Missing is amber, never red: a missing written entry is an operational exception, not a breach. */
const PERIOD_TEXT: Record<string, any> = {
  completed: { color: colors.success },
  due: { color: colors.accentTealStrong },
  missing: { color: colors.warning },
};

const styles = StyleSheet.create({
  shell: { gap: spacing.sm },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  headerText: { flex: 1, gap: 2 },
  title: { fontSize: 18, fontWeight: '800', color: colors.textPrimary },
  subtitle: { fontSize: 12, color: colors.textSecondary },
  hint: { fontSize: 11, color: colors.textSecondary, fontStyle: 'italic' },

  primaryBtn: {
    paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: radii.sm,
    backgroundColor: colors.primaryNavy,
  },
  primaryBtnDisabled: { opacity: 0.45 },
  primaryBtnText: { fontSize: 13, fontWeight: '800', color: colors.textOnBrand },

  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'flex-start' },
  field: { gap: 3, minWidth: 150 },
  fieldGrow: { flexGrow: 1, flexBasis: 220 },
  fieldLabel: {
    fontSize: 9, fontWeight: '800', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.7,
  },
  input: {
    borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 7, fontSize: 12,
    color: colors.textPrimary, backgroundColor: colors.card, minWidth: 150,
  },
  pickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, maxWidth: 360 },
  chip: {
    paddingHorizontal: 9, paddingVertical: 6, borderRadius: radii.sm,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, maxWidth: 170,
  },
  chipSelected: { borderColor: colors.accentTeal, backgroundColor: colors.accentTealSoft },
  chipText: { fontSize: 11, color: colors.textSecondary, fontWeight: '600' },
  chipTextSelected: { color: colors.accentTealStrong, fontWeight: '800' },

  panel: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    backgroundColor: colors.card, padding: spacing.md, gap: spacing.sm,
  },
  panelTitle: {
    fontSize: 10, fontWeight: '800', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },
  periodWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  period: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 6, minWidth: 128, gap: 1,
  },
  periodTime: { fontSize: 12, fontWeight: '800', color: colors.textPrimary },
  periodState: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  periodMeta: { fontSize: 10, color: colors.textSecondary },

  tableScroll: { maxHeight: 520 },
  tableHead: {
    flexDirection: 'row', paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  tableRow: {
    flexDirection: 'row', paddingVertical: 9, alignItems: 'flex-start',
    borderBottomWidth: 1, borderBottomColor: colors.surfaceSubtle,
  },
  cell: { fontSize: 12, color: colors.textPrimary, paddingRight: spacing.sm },
  cellStrong: { fontWeight: '800' },
  headCell: {
    fontSize: 9, fontWeight: '800', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.7,
  },
  colTime: { width: 62 },
  colSite: { flex: 3, minWidth: 90 },
  colGuard: { flex: 3, minWidth: 90 },
  colShift: { width: 54 },
  colEntry: { flex: 8, minWidth: 180 },

  empty: { paddingVertical: spacing.lg, alignItems: 'center', gap: 3 },
  emptyTitle: { fontSize: 13, fontWeight: '800', color: colors.textPrimary },
  emptyDesc: { fontSize: 12, color: colors.textSecondary },
});
