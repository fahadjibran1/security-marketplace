import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';

const IS_WEB = typeof document !== 'undefined';

// ── Type exports ──────────────────────────────────────────────────────────────

export type PlannerRow = {
  localId: string;
  date: string;
  startTime: string;
  endTime: string;
  guardsRequired: string;
  assignedGuardId: string;
  status: string;
  instructions: string;
  sourceShiftIds: number[];
};

export type PlannerWeekDay = {
  date: string;
  label: string;
  shortLabel: string;
};

// ── Static data ───────────────────────────────────────────────────────────────

const SHIFT_STATUS_OPTIONS = [
  { label: 'Unfilled',    value: 'unfilled' },
  { label: 'Offered',     value: 'offered' },
  { label: 'Ready',       value: 'ready' },
  { label: 'Missed',      value: 'missed' },
  { label: 'Cancelled',   value: 'cancelled' },
  { label: 'Rejected',    value: 'rejected' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed',   value: 'completed' },
];

// ── Status badge tokens ───────────────────────────────────────────────────────

function statusTokens(status: string): { bg: string; fg: string; label: string } {
  switch (status) {
    case 'unfilled':    return { bg: colors.dangerSurface,  fg: colors.danger,   label: 'Unfilled' };
    case 'offered':     return { bg: colors.infoSurface,    fg: colors.info,     label: 'Offered' };
    case 'ready':       return { bg: colors.successSurface, fg: colors.success,  label: 'Ready' };
    case 'in_progress': return { bg: colors.successSurface, fg: colors.success,  label: 'On Shift' };
    case 'completed':   return { bg: colors.pendingSurface, fg: colors.pending,  label: 'Done' };
    case 'missed':      return { bg: colors.warningSurface, fg: colors.warning,  label: 'Missed' };
    case 'cancelled':   return { bg: colors.pendingSurface, fg: colors.pending,  label: 'Cancelled' };
    case 'rejected':    return { bg: colors.warningSurface, fg: colors.warning,  label: 'Rejected' };
    default:            return { bg: colors.pendingSurface, fg: colors.pending,  label: status || 'Unknown' };
  }
}

// ── Inline form controls ──────────────────────────────────────────────────────

const CTRL_STYLE_BASE = {
  height: 42,
  borderWidth: 1.5,
  borderColor: colors.fieldBorder,
  borderRadius: radii.sm,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  fontSize: 16,
  color: colors.textPrimary,
  backgroundColor: colors.card,
  outlineStyle: 'none',
} as const;

const CTRL_STYLE_WEB = {
  ...CTRL_STYLE_BASE,
  width: '100%',
  boxSizing: 'border-box',
} as const;

function PlannerSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
}) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => { setMounted(IS_WEB); }, []);

  if (mounted) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';
    return (
      <SelectTag
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
        style={CTRL_STYLE_WEB}
        aria-label={placeholder ?? 'Select'}
      >
        <OptionTag value="">{placeholder ?? 'Select'}</OptionTag>
        {options.map((opt) => (
          <OptionTag key={opt.value} value={opt.value}>{opt.label}</OptionTag>
        ))}
      </SelectTag>
    );
  }
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      style={CTRL_STYLE_BASE as any}
      placeholderTextColor={colors.fieldPlaceholder}
    />
  );
}

function PlannerTimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  if (IS_WEB) {
    const InputTag: any = 'input';
    return (
      <InputTag
        type="time"
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
        style={CTRL_STYLE_WEB}
      />
    );
  }
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder="HH:MM"
      style={CTRL_STYLE_BASE as any}
      placeholderTextColor={colors.fieldPlaceholder}
    />
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

type CompanyRotaPlannerWorkspaceProps = {
  plannerClientId: string;
  plannerSiteId: string;
  plannerRows: PlannerRow[];
  plannerRowsByDate: Map<string, PlannerRow[]>;
  plannerWeekDays: PlannerWeekDay[];
  savingRota: boolean;
  siteClientOptions: Array<{ label: string; value: string }>;
  plannerSiteOptions: Array<{ label: string; value: string }>;
  linkedGuardOptions: Array<{ label: string; value: string }>;
  guardNameById: Map<string, string>;
  setPlannerClientId: (v: string) => void;
  setPlannerSiteId: (v: string) => void;
  onAddRow: (date: string) => void;
  onRowChange: (localId: string, patch: Partial<PlannerRow>) => void;
  onRemoveRow: (localId: string) => void;
  onCopyToNextWeek: () => void;
  onSaveRota: () => void;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onTodayWeek: () => void;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function CompanyRotaPlannerWorkspace({
  plannerClientId,
  plannerSiteId,
  plannerRowsByDate,
  plannerWeekDays,
  savingRota,
  siteClientOptions,
  plannerSiteOptions,
  linkedGuardOptions,
  guardNameById,
  setPlannerClientId,
  setPlannerSiteId,
  onAddRow,
  onRowChange,
  onRemoveRow,
  onCopyToNextWeek,
  onSaveRota,
  onPrevWeek,
  onNextWeek,
  onTodayWeek,
}: CompanyRotaPlannerWorkspaceProps) {
  const [removeTarget, setRemoveTarget] = React.useState<string | null>(null);
  const [expandedNotes, setExpandedNotes] = React.useState<Set<string>>(new Set());

  const weekLabel = plannerWeekDays.length >= 7
    ? `${plannerWeekDays[0].shortLabel} – ${plannerWeekDays[6].shortLabel}`
    : '';

  const toggleNotes = (localId: string) => {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(localId)) { next.delete(localId); } else { next.add(localId); }
      return next;
    });
  };

  const handleConfirmRemove = () => {
    if (removeTarget) {
      onRemoveRow(removeTarget);
      setRemoveTarget(null);
    }
  };

  return (
    <View style={styles.workspace}>
      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <View style={styles.toolbar}>
        <View style={styles.filterGroup}>
          <View style={styles.filterCell}>
            <PlannerSelect
              value={plannerClientId}
              onChange={setPlannerClientId}
              options={siteClientOptions}
              placeholder="All clients"
            />
          </View>
          <View style={styles.filterCell}>
            <PlannerSelect
              value={plannerSiteId}
              onChange={setPlannerSiteId}
              options={plannerSiteOptions}
              placeholder="Select site"
            />
          </View>
        </View>

        <View style={styles.weekNav}>
          <Pressable
            onPress={onPrevWeek}
            style={({ pressed }: any) => [styles.navBtn, pressed && styles.navBtnPressed]}
            accessibilityLabel="Previous week"
            accessibilityRole="button"
          >
            <Text style={styles.navBtnText}>‹</Text>
          </Pressable>
          <Text style={styles.weekLabel} numberOfLines={1}>{weekLabel}</Text>
          <Pressable
            onPress={onNextWeek}
            style={({ pressed }: any) => [styles.navBtn, pressed && styles.navBtnPressed]}
            accessibilityLabel="Next week"
            accessibilityRole="button"
          >
            <Text style={styles.navBtnText}>›</Text>
          </Pressable>
          <Button label="Today" variant="secondary" size="sm" onPress={onTodayWeek} />
        </View>

        <View style={styles.actionGroup}>
          <Button label="Copy to Next Week" variant="secondary" size="sm" onPress={onCopyToNextWeek} />
          <Button
            label={savingRota ? 'Saving…' : 'Save Rota'}
            variant="primary"
            size="sm"
            loading={savingRota}
            onPress={onSaveRota}
          />
        </View>
      </View>

      {/* ── Week grid ─────────────────────────────────────────────────────── */}
      <View style={styles.weekGrid}>
        {plannerWeekDays.map((day) => {
          const rows = plannerRowsByDate.get(day.date) ?? [];
          const openCount = rows.filter((r) => !r.status || r.status === 'unfilled').length;

          return (
            <View key={day.date} style={styles.dayCard}>
              {/* Day header */}
              <View style={styles.dayCardHeader}>
                <View style={styles.dayTitleBlock}>
                  <Text style={styles.dayName}>{day.label}</Text>
                  <Text style={styles.dayDate}>{day.shortLabel}</Text>
                </View>
                <View style={styles.dayStats}>
                  {rows.length > 0 ? (
                    <Text style={styles.shiftCount}>
                      {rows.length} shift{rows.length !== 1 ? 's' : ''}
                    </Text>
                  ) : null}
                  {openCount > 0 ? (
                    <View style={styles.openChip}>
                      <Text style={styles.openChipText}>{openCount} open</Text>
                    </View>
                  ) : null}
                </View>
                <Button label="+ Add" variant="secondary" size="sm" onPress={() => onAddRow(day.date)} />
              </View>

              {/* Empty day */}
              {rows.length === 0 ? (
                <Text style={styles.emptyDay}>No cover planned for this day.</Text>
              ) : null}

              {/* Shift rows */}
              {rows.map((row) => {
                const tok = statusTokens(row.status);
                const guardName = row.assignedGuardId ? (guardNameById.get(row.assignedGuardId) ?? null) : null;
                const notesOpen = expandedNotes.has(row.localId);

                return (
                  <View key={row.localId} style={[styles.shiftRow, { borderLeftColor: tok.fg }]}>
                    {/* Summary header */}
                    <View style={styles.shiftRowHead}>
                      <View style={styles.shiftRowInfo}>
                        <View style={[styles.statusBadge, { backgroundColor: tok.bg }]}>
                          <Text style={[styles.statusBadgeText, { color: tok.fg }]}>{tok.label}</Text>
                        </View>
                        <Text style={styles.shiftTime}>
                          {row.startTime || '––'} – {row.endTime || '––'}
                        </Text>
                        {row.guardsRequired && row.guardsRequired !== '1' ? (
                          <View style={styles.guardsChip}>
                            <Text style={styles.guardsChipText}>×{row.guardsRequired}</Text>
                          </View>
                        ) : null}
                        {guardName ? (
                          <Text style={styles.guardName} numberOfLines={1}>{guardName}</Text>
                        ) : null}
                      </View>
                      <Pressable
                        onPress={() => setRemoveTarget(row.localId)}
                        style={({ pressed }: any) => [styles.removeBtn, pressed && styles.removeBtnPressed]}
                        accessibilityLabel="Remove shift"
                        accessibilityRole="button"
                      >
                        <Text style={styles.removeBtnIcon}>✕</Text>
                      </Pressable>
                    </View>

                    {/* Time + guards controls */}
                    <View style={styles.ctrlRow}>
                      <View style={[styles.ctrlCell, { flex: 2 }]}>
                        <Text style={styles.ctrlLabel}>Start</Text>
                        <PlannerTimeInput
                          value={row.startTime}
                          onChange={(v) => onRowChange(row.localId, { startTime: v })}
                        />
                      </View>
                      <View style={[styles.ctrlCell, { flex: 2 }]}>
                        <Text style={styles.ctrlLabel}>End</Text>
                        <PlannerTimeInput
                          value={row.endTime}
                          onChange={(v) => onRowChange(row.localId, { endTime: v })}
                        />
                      </View>
                      <View style={styles.ctrlCell}>
                        <Text style={styles.ctrlLabel}>Guards</Text>
                        <TextInput
                          value={row.guardsRequired}
                          onChangeText={(v: string) => onRowChange(row.localId, { guardsRequired: v })}
                          keyboardType="numeric"
                          style={styles.ctrlInput}
                          placeholderTextColor={colors.fieldPlaceholder}
                          textAlign="center"
                        />
                      </View>
                    </View>

                    {/* Guard + status controls */}
                    <View style={styles.ctrlRow}>
                      <View style={[styles.ctrlCell, { flex: 3 }]}>
                        <Text style={styles.ctrlLabel}>Guard</Text>
                        <PlannerSelect
                          value={row.assignedGuardId}
                          onChange={(v) => onRowChange(row.localId, { assignedGuardId: v })}
                          options={linkedGuardOptions}
                          placeholder="Unassigned"
                        />
                      </View>
                      <View style={[styles.ctrlCell, { flex: 2 }]}>
                        <Text style={styles.ctrlLabel}>Status</Text>
                        <PlannerSelect
                          value={row.status}
                          onChange={(v) => onRowChange(row.localId, { status: v })}
                          options={SHIFT_STATUS_OPTIONS}
                          placeholder="Status"
                        />
                      </View>
                    </View>

                    {/* Notes disclosure */}
                    <Pressable
                      onPress={() => toggleNotes(row.localId)}
                      style={({ pressed }: any) => [styles.notesToggle, pressed && styles.notesTogglePressed]}
                      accessibilityRole="button"
                    >
                      <Text style={styles.notesToggleIcon}>{notesOpen ? '▾' : '▸'}</Text>
                      <Text style={styles.notesToggleLabel}>Notes</Text>
                      {!notesOpen && row.instructions ? (
                        <Text style={styles.notesPreview} numberOfLines={1}>{row.instructions}</Text>
                      ) : null}
                    </Pressable>
                    {notesOpen ? (
                      <TextInput
                        multiline
                        value={row.instructions}
                        onChangeText={(v: string) => onRowChange(row.localId, { instructions: v })}
                        placeholder="Instructions shown to the guard…"
                        style={styles.notesInput}
                        placeholderTextColor={colors.fieldPlaceholder}
                        textAlignVertical="top"
                      />
                    ) : null}
                  </View>
                );
              })}
            </View>
          );
        })}
      </View>

      {/* ── Remove confirmation ────────────────────────────────────────────── */}
      <ConfirmationDialog
        visible={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={handleConfirmRemove}
        title="Remove shift?"
        message="This shift will be removed from the rota. Any existing booking will be cancelled when you save."
        confirmLabel="Remove"
        cancelLabel="Keep"
        variant="danger"
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  workspace: {
    gap: spacing.lg,
  },

  // Toolbar
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
  },
  filterGroup: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexShrink: 1,
  },
  filterCell: {
    minWidth: 148,
    maxWidth: 220,
    flex: 1,
  },
  weekNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
    justifyContent: 'center',
    minWidth: 280,
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    flexShrink: 0,
  },
  navBtnPressed: {
    backgroundColor: colors.surfaceSubtle,
  },
  navBtnText: {
    fontSize: 22,
    lineHeight: 26,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  weekLabel: {
    ...typography.label,
    color: colors.textPrimary,
    flex: 1,
    textAlign: 'center',
  },
  actionGroup: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexShrink: 0,
  },

  // Week grid
  weekGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
  },
  dayCard: {
    width: '48%',
    minWidth: 300,
    flexGrow: 1,
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },

  // Day card header
  dayCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dayTitleBlock: {
    flex: 1,
    gap: 2,
  },
  dayName: {
    ...typography.panelHeading,
    color: colors.textPrimary,
  },
  dayDate: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  dayStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  shiftCount: {
    ...typography.caption,
    color: colors.textMuted,
  },
  openChip: {
    backgroundColor: colors.dangerSurface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  openChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.danger,
  },
  emptyDay: {
    ...typography.caption,
    color: colors.textMuted,
    paddingVertical: spacing.sm,
    fontStyle: 'italic',
  } as any,

  // Shift row card
  shiftRow: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.background,
  },

  // Shift row header
  shiftRowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  shiftRowInfo: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    minWidth: 0,
  },
  statusBadge: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    flexShrink: 0,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  } as any,
  shiftTime: {
    ...typography.label,
    color: colors.textPrimary,
    flexShrink: 0,
  },
  guardsChip: {
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    flexShrink: 0,
  },
  guardsChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  guardName: {
    ...typography.caption,
    color: colors.textSecondary,
    minWidth: 0,
    flexShrink: 1,
  },
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.dangerSurface,
    flexShrink: 0,
  },
  removeBtnPressed: {
    backgroundColor: colors.dangerBorder,
  },
  removeBtnIcon: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.danger,
  },

  // Edit control rows
  ctrlRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  ctrlCell: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  ctrlLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  } as any,
  ctrlInput: {
    height: 42,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.card,
  },

  // Notes
  notesToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 4,
  },
  notesTogglePressed: {
    opacity: 0.7,
  },
  notesToggleIcon: {
    fontSize: 12,
    color: colors.accentTeal,
    fontWeight: '700',
    width: 14,
  },
  notesToggleLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accentTeal,
  },
  notesPreview: {
    ...typography.caption,
    color: colors.textMuted,
    flex: 1,
    minWidth: 0,
  },
  notesInput: {
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.card,
    minHeight: 72,
    textAlignVertical: 'top',
  } as any,
});
