import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { Drawer } from '../ui/Drawer';

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

// ── Status tokens ─────────────────────────────────────────────────────────────

function statusTokens(status: string): { bg: string; fg: string; label: string; problem: boolean } {
  switch (status) {
    case 'unfilled':    return { bg: colors.dangerSurface,  fg: colors.danger,   label: 'Unfilled',   problem: true };
    case 'offered':     return { bg: colors.infoSurface,    fg: colors.info,     label: 'Offered',    problem: false };
    case 'ready':       return { bg: colors.successSurface, fg: colors.success,  label: 'Ready',      problem: false };
    case 'in_progress': return { bg: colors.successSurface, fg: colors.success,  label: 'On Shift',   problem: false };
    case 'completed':   return { bg: colors.pendingSurface, fg: colors.pending,  label: 'Done',       problem: false };
    case 'missed':      return { bg: colors.warningSurface, fg: colors.warning,  label: 'Missed',     problem: true };
    case 'cancelled':   return { bg: colors.pendingSurface, fg: colors.pending,  label: 'Cancelled',  problem: false };
    case 'rejected':    return { bg: colors.warningSurface, fg: colors.warning,  label: 'Rejected',   problem: true };
    default:            return { bg: colors.pendingSurface, fg: colors.pending,  label: status || '—', problem: false };
  }
}

// ── Drawer form controls ──────────────────────────────────────────────────────

const CTRL: any = {
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
};

const CTRL_WEB: any = { ...CTRL, width: '100%', boxSizing: 'border-box' };

function DrawerSelect({
  value, onChange, options, placeholder,
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
      <SelectTag value={value} onChange={(e: any) => onChange(e.target.value)}
        style={CTRL_WEB} aria-label={placeholder ?? 'Select'}>
        <OptionTag value="">{placeholder ?? 'Select'}</OptionTag>
        {options.map((opt) => (
          <OptionTag key={opt.value} value={opt.value}>{opt.label}</OptionTag>
        ))}
      </SelectTag>
    );
  }
  return (
    <TextInput value={value} onChangeText={onChange} placeholder={placeholder}
      style={CTRL} placeholderTextColor={colors.fieldPlaceholder} />
  );
}

function DrawerTimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  if (IS_WEB) {
    const InputTag: any = 'input';
    return <InputTag type="time" value={value} onChange={(e: any) => onChange(e.target.value)} style={CTRL_WEB} />;
  }
  return <TextInput value={value} onChangeText={onChange} placeholder="HH:MM" style={CTRL} placeholderTextColor={colors.fieldPlaceholder} />;
}

function DrawerDateInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  if (IS_WEB) {
    const InputTag: any = 'input';
    return <InputTag type="date" value={value} onChange={(e: any) => onChange(e.target.value)} style={CTRL_WEB} />;
  }
  return <TextInput value={value} onChangeText={onChange} placeholder="YYYY-MM-DD" style={CTRL} placeholderTextColor={colors.fieldPlaceholder} />;
}

// ── Drawer state type ─────────────────────────────────────────────────────────

type DrawerState =
  | { kind: 'edit';   row: PlannerRow }
  | { kind: 'create'; date: string }
  | null;

function buildDraftDefaults(date: string): Partial<PlannerRow> {
  return { date, startTime: '08:00', endTime: '18:00', guardsRequired: '1', assignedGuardId: '', status: 'unfilled', instructions: '' };
}

function buildNewRow(draft: Partial<PlannerRow>): PlannerRow {
  const date = draft.date ?? '';
  return {
    localId: `${date}-${Math.random().toString(36).slice(2, 8)}`,
    date,
    startTime: draft.startTime ?? '08:00',
    endTime:   draft.endTime   ?? '18:00',
    guardsRequired:  draft.guardsRequired  ?? '1',
    assignedGuardId: draft.assignedGuardId ?? '',
    status:       draft.status       ?? 'unfilled',
    instructions: draft.instructions ?? '',
    sourceShiftIds: [],
  };
}

// ── Props ─────────────────────────────────────────────────────────────────────

type CompanyRotaPlannerWorkspaceProps = {
  plannerClientId: string;
  plannerSiteId: string;
  plannerSiteName: string;
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
  onAddRow: (row: PlannerRow) => void;
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
  plannerSiteName,
  plannerRows,
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

  // ── Local state ─────────────────────────────────────────────────────────────
  const [drawerState, setDrawerState] = React.useState<DrawerState>(null);
  const [draft, setDraft]             = React.useState<Partial<PlannerRow>>({});
  const [removeTarget, setRemoveTarget] = React.useState<string | null>(null);

  // ── Drawer helpers ───────────────────────────────────────────────────────────
  const openEdit = (row: PlannerRow) => {
    setDraft({ ...row });
    setDrawerState({ kind: 'edit', row });
  };

  const openCreate = (date: string) => {
    setDraft(buildDraftDefaults(date));
    setDrawerState({ kind: 'create', date });
  };

  const closeDrawer = () => {
    setDrawerState(null);
    setDraft({});
  };

  const patchDraft = (patch: Partial<PlannerRow>) =>
    setDraft((prev) => ({ ...prev, ...patch }));

  const handleDrawerSave = () => {
    if (!drawerState) return;
    if (drawerState.kind === 'edit') {
      onRowChange(drawerState.row.localId, draft);
    } else {
      onAddRow(buildNewRow(draft));
    }
    closeDrawer();
  };

  const handleConfirmRemove = () => {
    if (removeTarget) {
      onRemoveRow(removeTarget);
      setRemoveTarget(null);
      setDrawerState(null);
    }
  };

  // ── Derived ─────────────────────────────────────────────────────────────────
  const weekLabel = plannerWeekDays.length >= 7
    ? `${plannerWeekDays[0].shortLabel} – ${plannerWeekDays[6].shortLabel}`
    : '';

  const totalShifts  = plannerRows.length;
  const coveredCount = plannerRows.filter((r) => ['ready', 'in_progress', 'completed'].includes(r.status)).length;
  const openCount    = plannerRows.filter((r) => !r.status || r.status === 'unfilled').length;
  const offeredCount = plannerRows.filter((r) => r.status === 'offered').length;
  const problemCount = plannerRows.filter((r) => ['missed', 'rejected'].includes(r.status)).length;

  // ── Drawer header subtitle ───────────────────────────────────────────────────
  const drawerSubtitle = React.useMemo(() => {
    if (!drawerState) return '';
    const date = drawerState.kind === 'edit' ? drawerState.row.date : drawerState.date;
    const dayEntry = plannerWeekDays.find((d) => d.date === date);
    const dayLabel = dayEntry ? dayEntry.shortLabel : date;
    return plannerSiteName ? `${plannerSiteName} · ${dayLabel}` : dayLabel;
  }, [drawerState, plannerWeekDays, plannerSiteName]);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <View style={styles.workspace}>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <View style={styles.toolbar}>
        <View style={styles.filterGroup}>
          <View style={styles.filterCell}>
            <DrawerSelect value={plannerClientId} onChange={setPlannerClientId}
              options={siteClientOptions} placeholder="All clients" />
          </View>
          <View style={styles.filterCell}>
            <DrawerSelect value={plannerSiteId} onChange={setPlannerSiteId}
              options={plannerSiteOptions} placeholder="Select site" />
          </View>
        </View>

        <View style={styles.weekNav}>
          <Pressable onPress={onPrevWeek}
            style={({ pressed }: any) => [styles.navBtn, pressed && styles.navBtnPressed]}
            accessibilityLabel="Previous week" accessibilityRole="button">
            <Text style={styles.navBtnText}>‹</Text>
          </Pressable>
          <Text style={styles.weekLabel} numberOfLines={1}>{weekLabel}</Text>
          <Pressable onPress={onNextWeek}
            style={({ pressed }: any) => [styles.navBtn, pressed && styles.navBtnPressed]}
            accessibilityLabel="Next week" accessibilityRole="button">
            <Text style={styles.navBtnText}>›</Text>
          </Pressable>
          <Button label="Today" variant="secondary" size="sm" onPress={onTodayWeek} />
        </View>

        <View style={styles.actionGroup}>
          <Button label="Copy to Next Week" variant="secondary" size="sm" onPress={onCopyToNextWeek} />
          <Button label={savingRota ? 'Saving…' : 'Save Rota'} variant="primary" size="sm"
            loading={savingRota} onPress={onSaveRota} />
        </View>
      </View>

      {/* ── Week summary strip ───────────────────────────────────────────────── */}
      <View style={styles.summaryStrip}>
        <SummaryStat value={totalShifts} label="Shifts" />
        <View style={styles.summaryDivider} />
        <SummaryStat value={coveredCount} label="Covered" />
        <View style={styles.summaryDivider} />
        <SummaryStat value={openCount} label="Open" highlight={openCount > 0 ? 'danger' : undefined} />
        <View style={styles.summaryDivider} />
        <SummaryStat value={offeredCount} label="Offered" highlight={offeredCount > 0 ? 'info' : undefined} />
        <View style={styles.summaryDivider} />
        <SummaryStat value={problemCount} label="Problems" highlight={problemCount > 0 ? 'warning' : undefined} />
      </View>

      {/* ── Day sections ─────────────────────────────────────────────────────── */}
      <View style={styles.daySections}>
        {plannerWeekDays.map((day) => {
          const rows = plannerRowsByDate.get(day.date) ?? [];
          const dayOpenCount = rows.filter((r) => !r.status || r.status === 'unfilled').length;

          return (
            <View key={day.date} style={styles.daySection}>
              {/* Day header */}
              <View style={styles.dayHeader}>
                <View style={styles.dayHeaderTitle}>
                  <Text style={styles.dayName}>{day.label}</Text>
                  <Text style={styles.dayShortLabel}>{day.shortLabel}</Text>
                </View>
                <View style={styles.dayHeaderMeta}>
                  {rows.length > 0 ? (
                    <Text style={styles.dayShiftCount}>
                      {rows.length} shift{rows.length !== 1 ? 's' : ''}
                    </Text>
                  ) : null}
                  {dayOpenCount > 0 ? (
                    <View style={styles.openChip}>
                      <Text style={styles.openChipText}>{dayOpenCount} open</Text>
                    </View>
                  ) : null}
                </View>
                <Button label="+ Add Shift" variant="secondary" size="sm"
                  onPress={() => openCreate(day.date)} />
              </View>

              {/* Shift rows */}
              {rows.length === 0 ? (
                <View style={styles.emptyDayRow}>
                  <Text style={styles.emptyDayText}>No cover planned.</Text>
                </View>
              ) : (
                rows.map((row, index) => {
                  const tok = statusTokens(row.status);
                  const guardName = row.assignedGuardId
                    ? (guardNameById.get(row.assignedGuardId) ?? null)
                    : null;
                  const guardsNum = parseInt(row.guardsRequired, 10) || 1;
                  const isLast = index === rows.length - 1;

                  return (
                    <Pressable
                      key={row.localId}
                      onPress={() => openEdit(row)}
                      style={({ pressed, hovered }: any) => [
                        styles.shiftRow,
                        !isLast && styles.shiftRowDivider,
                        (pressed || hovered) && styles.shiftRowHovered,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`${row.startTime}–${row.endTime} ${guardName ?? 'Unassigned'} ${tok.label}`}
                    >
                      {/* Problem accent bar */}
                      <View style={[
                        styles.accentBar,
                        tok.problem ? { backgroundColor: tok.fg } : { backgroundColor: 'transparent' },
                      ]} />

                      <View style={styles.rowContent}>
                        {/* Time */}
                        <Text style={styles.colTime} numberOfLines={1}>
                          {row.startTime || '––'}–{row.endTime || '––'}
                        </Text>

                        {/* Site */}
                        <Text style={styles.colSite} numberOfLines={1}>
                          {plannerSiteName || '—'}
                        </Text>

                        {/* Guard / cover */}
                        <Text
                          style={[styles.colGuard, !guardName && styles.colGuardEmpty]}
                          numberOfLines={1}
                        >
                          {guardName ?? 'Unassigned'}
                        </Text>

                        {/* Required count */}
                        <Text style={styles.colRequired}>{guardsNum}</Text>

                        {/* Status badge */}
                        <View style={[styles.statusBadge, { backgroundColor: tok.bg }]}>
                          <Text style={[styles.statusBadgeText, { color: tok.fg }]}>{tok.label}</Text>
                        </View>

                        {/* Chevron */}
                        <Text style={styles.chevron}>›</Text>
                      </View>
                    </Pressable>
                  );
                })
              )}
            </View>
          );
        })}
      </View>

      {/* ── Shift drawer ─────────────────────────────────────────────────────── */}
      <Drawer
        visible={drawerState !== null}
        onClose={closeDrawer}
        title={drawerState?.kind === 'create' ? 'Add Shift' : 'Edit Shift'}
        subtitle={drawerSubtitle}
        compact
        width={480}
        footer={
          <View style={styles.drawerFooterRow}>
            {drawerState?.kind === 'edit' ? (
              <Button
                label="Remove Shift"
                variant="danger"
                size="sm"
                onPress={() => drawerState && setRemoveTarget(drawerState.row.localId)}
              />
            ) : <View />}
            <View style={styles.drawerFooterActions}>
              <Button label="Cancel" variant="secondary" size="sm" onPress={closeDrawer} />
              <Button
                label={drawerState?.kind === 'create' ? 'Add Shift' : 'Save Changes'}
                variant="primary"
                size="sm"
                onPress={handleDrawerSave}
              />
            </View>
          </View>
        }
      >
        <View style={styles.drawerBody}>
          {/* Schedule section */}
          <Text style={styles.drawerSectionLabel}>Schedule</Text>
          <View style={styles.formField}>
            <Text style={styles.formLabel}>Date</Text>
            <DrawerDateInput value={draft.date ?? ''} onChange={(v) => patchDraft({ date: v })} />
          </View>
          <View style={styles.formRow}>
            <View style={[styles.formCell, styles.formCellHalf]}>
              <Text style={styles.formLabel}>Start time</Text>
              <DrawerTimeInput value={draft.startTime ?? ''} onChange={(v) => patchDraft({ startTime: v })} />
            </View>
            <View style={[styles.formCell, styles.formCellHalf]}>
              <Text style={styles.formLabel}>End time</Text>
              <DrawerTimeInput value={draft.endTime ?? ''} onChange={(v) => patchDraft({ endTime: v })} />
            </View>
          </View>

          {/* Cover section */}
          <Text style={[styles.drawerSectionLabel, styles.sectionLabelSpaced]}>Cover</Text>
          <View style={styles.formRow}>
            <View style={[styles.formCell, { flex: 1 }]}>
              <Text style={styles.formLabel}>Guards required</Text>
              <TextInput
                value={draft.guardsRequired ?? '1'}
                onChangeText={(v: string) => patchDraft({ guardsRequired: v })}
                keyboardType="numeric"
                style={styles.formInput}
                placeholderTextColor={colors.fieldPlaceholder}
                textAlign="center"
              />
            </View>
            <View style={[styles.formCell, { flex: 3 }]}>
              <Text style={styles.formLabel}>Assigned guard</Text>
              <DrawerSelect
                value={draft.assignedGuardId ?? ''}
                onChange={(v) => patchDraft({ assignedGuardId: v })}
                options={linkedGuardOptions}
                placeholder="Unassigned"
              />
            </View>
          </View>

          {/* Status section */}
          <Text style={[styles.drawerSectionLabel, styles.sectionLabelSpaced]}>Status</Text>
          <View style={styles.formField}>
            <Text style={styles.formLabel}>Shift status</Text>
            <DrawerSelect
              value={draft.status ?? 'unfilled'}
              onChange={(v) => patchDraft({ status: v })}
              options={SHIFT_STATUS_OPTIONS}
              placeholder="Status"
            />
          </View>

          {/* Notes section */}
          <Text style={[styles.drawerSectionLabel, styles.sectionLabelSpaced]}>Notes</Text>
          <View style={styles.formField}>
            <Text style={styles.formLabel}>Instructions</Text>
            <TextInput
              multiline
              value={draft.instructions ?? ''}
              onChangeText={(v: string) => patchDraft({ instructions: v })}
              placeholder="Instructions shown to the assigned guard…"
              style={styles.notesInput}
              placeholderTextColor={colors.fieldPlaceholder}
              textAlignVertical="top"
            />
          </View>
        </View>
      </Drawer>

      {/* ── Remove confirmation ──────────────────────────────────────────────── */}
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

// ── Summary stat atom ─────────────────────────────────────────────────────────

function SummaryStat({
  value,
  label,
  highlight,
}: {
  value: number;
  label: string;
  highlight?: 'danger' | 'info' | 'warning';
}) {
  const numColor = highlight === 'danger'
    ? colors.danger
    : highlight === 'warning'
    ? colors.warning
    : highlight === 'info'
    ? colors.info
    : colors.textPrimary;

  return (
    <View style={summaryStyles.stat}>
      <Text style={[summaryStyles.value, { color: numColor }]}>{value}</Text>
      <Text style={summaryStyles.label}>{label}</Text>
    </View>
  );
}

const summaryStyles = StyleSheet.create({
  stat: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  value: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 28,
    color: colors.textPrimary,
  },
  label: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
});

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  workspace: {
    gap: spacing.md,
  },

  // Toolbar (unchanged)
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

  // Summary strip
  summaryStrip: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  } as any,
  summaryDivider: {
    width: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },

  // Day sections
  daySections: {
    gap: spacing.sm,
  },
  daySection: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  } as any,

  // Day header
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSubtle,
  },
  dayHeaderTitle: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    flex: 1,
  },
  dayName: {
    ...typography.panelHeading,
    color: colors.textPrimary,
  },
  dayShortLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  dayHeaderMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  dayShiftCount: {
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

  // Empty day
  emptyDayRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  emptyDayText: {
    ...typography.caption,
    color: colors.textMuted,
    fontStyle: 'italic',
  } as any,

  // Shift row
  shiftRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 48,
  },
  shiftRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  shiftRowHovered: {
    backgroundColor: colors.surfaceSubtle,
  },
  accentBar: {
    width: 3,
    alignSelf: 'stretch',
    flexShrink: 0,
  },
  rowContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    minHeight: 48,
  },
  colTime: {
    width: 114,
    flexShrink: 0,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  } as any,
  colSite: {
    flex: 2,
    fontSize: 13,
    color: colors.textPrimary,
    minWidth: 0,
  },
  colGuard: {
    flex: 2,
    fontSize: 13,
    color: colors.textSecondary,
    minWidth: 0,
  },
  colGuardEmpty: {
    color: colors.textMuted,
    fontStyle: 'italic',
  } as any,
  colRequired: {
    width: 28,
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
  } as any,
  statusBadge: {
    width: 86,
    flexShrink: 0,
    borderRadius: radii.pill,
    paddingVertical: 3,
    alignItems: 'center',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  } as any,
  chevron: {
    width: 20,
    flexShrink: 0,
    textAlign: 'center',
    fontSize: 16,
    color: colors.neutralSlate,
    fontWeight: '600',
  } as any,

  // Drawer footer
  drawerFooterRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  drawerFooterActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },

  // Drawer form body
  drawerBody: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    gap: spacing.sm,
  },
  drawerSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.xs,
  } as any,
  sectionLabelSpaced: {
    marginTop: spacing.md,
  },
  formField: {
    gap: spacing.xs,
  },
  formRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  formCell: {
    gap: spacing.xs,
    minWidth: 0,
  },
  formCellHalf: {
    flex: 1,
  },
  formLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  formInput: {
    height: 42,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.card,
  },
  notesInput: {
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textPrimary,
    backgroundColor: colors.card,
    minHeight: 86,
    textAlignVertical: 'top',
  } as any,
});
