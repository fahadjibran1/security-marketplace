import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, control, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { Drawer } from '../ui/Drawer';
import { FormField, FieldInput, FieldTextarea } from '../ui/FormField';
import type {
  EligibleGuardRow,
  RotaCoveragePhase,
  RotaCoverageState,
  RotaDayCells,
  RotaSlotDetail,
  RotaSlotCell,
  RotaSiteWeekRow,
  RotaWeekSnapshot,
  RotaCreatePayload,
  RotaSlotChanges,
  RotaAssignMultipleResult,
} from '../../types/models';

const IS_WEB = typeof document !== 'undefined';

// ── Exported types ────────────────────────────────────────────────────────────

export type PlannerWeekDay = {
  date: string;
  label: string;
  shortLabel: string;
};

/** A RotaSlotCell enriched with the site context from its parent SiteWeekRow. */
export type FlatSlotCell = RotaSlotCell & {
  siteId: number;
  siteName: string;
  clientId: number | null;
  clientName: string | null;
};

/** A legacy Shift (rotaSlotId=null) surfaced for backward-compatible display only. */
export type LegacyShiftRow = {
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  siteName: string;
  guardName: string | null;
  status: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUtcTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    });
  } catch {
    return iso.slice(11, 16);
  }
}

function formatUtcDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/** Build a naive ISO datetime (no Z) from a local date string + HH:MM time. */
function buildNaiveIso(date: string, time: string): string {
  return `${date}T${time}:00`;
}

/** Build endAt naive ISO, advancing the date by 1 day when end ≤ start (overnight shift). */
function buildNaiveIsoEnd(date: string, startTime: string, endTime: string): string {
  if (endTime <= startTime) {
    const [y, m, d] = date.split('-').map(Number);
    const next = new Date(y, m - 1, d + 1);
    const nd = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    return `${nd}T${endTime}:00`;
  }
  return `${date}T${endTime}:00`;
}

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
}

function isValidTime(s: string): boolean {
  return /^\d{2}:\d{2}$/.test(s);
}

/** Convert ISO timestamp to HH:MM for the time input (UTC display). */
function isoToTimeDisplay(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    });
  } catch {
    return '';
  }
}

/** Convert ISO timestamp to YYYY-MM-DD for the date input (UTC date). */
function isoToDateDisplay(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

// ── Coverage state tokens ─────────────────────────────────────────────────────

function slotStateTokens(state: RotaCoverageState): {
  bg: string; fg: string; label: string; problem: boolean;
} {
  switch (state) {
    // Future
    case 'fully_planned':       return { bg: colors.successSurface,  fg: colors.success,  label: 'Covered',   problem: false };
    case 'offered_pending':     return { bg: colors.infoSurface,     fg: colors.info,     label: '',          problem: false }; // "N Awaiting" chip communicates
    case 'under_planned':       return { bg: 'transparent',          fg: colors.danger,   label: '',          problem: true  }; // "N Open" chip communicates
    case 'fully_open':          return { bg: 'transparent',          fg: colors.danger,   label: '',          problem: true  }; // "N Open" chip communicates
    case 'has_problems':        return { bg: colors.warningSurface,  fg: colors.warning,  label: 'Attention', problem: true  };
    // Live
    case 'live_fully_staffed':  return { bg: colors.successSurface,  fg: colors.success,  label: 'On shift',  problem: false };
    case 'live_partial':        return { bg: colors.warningSurface,  fg: colors.warning,  label: 'On shift',  problem: true  }; // fraction shows partial
    case 'live_none_on_site':   return { bg: colors.dangerSurface,   fg: colors.danger,   label: 'Attention', problem: true  };
    case 'live_has_problems':   return { bg: colors.warningSurface,  fg: colors.warning,  label: 'Attention', problem: true  };
    // Past
    case 'outcome_completed':   return { bg: colors.pendingSurface,  fg: colors.pending,  label: 'Completed', problem: false };
    case 'outcome_shortfall':   return { bg: colors.warningSurface,  fg: colors.warning,  label: 'Attention', problem: true  };
    case 'outcome_failed':      return { bg: colors.dangerSurface,   fg: colors.danger,   label: 'Attention', problem: true  };
    case 'outcome_has_problems':return { bg: colors.warningSurface,  fg: colors.warning,  label: 'Attention', problem: true  };
    case 'outcome_cancelled':   return { bg: colors.pendingSurface,  fg: colors.pending,  label: 'Cancelled', problem: false };
    case 'cancelled':           return { bg: colors.pendingSurface,  fg: colors.pending,  label: 'Cancelled', problem: false };
    default:                    return { bg: colors.pendingSurface,  fg: colors.pending,  label: '',          problem: false };
  }
}

function positionStatusTokens(status: string): { fg: string; label: string } {
  switch (status) {
    case 'unfilled':    return { fg: colors.danger,    label: 'Open'        };
    case 'offered':     return { fg: colors.info,      label: 'Awaiting'    };
    case 'ready':       return { fg: colors.success,   label: 'Confirmed'   };
    case 'in_progress': return { fg: colors.success,   label: 'On shift'    };
    case 'completed':   return { fg: colors.pending,   label: 'Completed'   };
    case 'missed':      return { fg: colors.warning,   label: 'Missed'      };
    case 'rejected':    return { fg: colors.warning,   label: 'Rejected'    };
    case 'cancelled':   return { fg: colors.textMuted, label: 'Cancelled'   };
    default:            return { fg: colors.textMuted, label: status || '—' };
  }
}

function canCancelPosition(status: string): boolean {
  return ['unfilled', 'offered', 'ready', 'rejected'].includes(status);
}

function isPositionOpen(status: string): boolean {
  return status === 'unfilled';
}

// ── Web-native input components ───────────────────────────────────────────────

function NativeDateInput({ value, onChange, hasError }: {
  value: string; onChange: (v: string) => void; hasError?: boolean;
}) {
  if (IS_WEB) {
    const InputTag: any = 'input';
    return (
      <InputTag
        type="date"
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
        style={[nativeInputStyle, hasError && nativeInputErrorStyle]}
      />
    );
  }
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder="YYYY-MM-DD"
      placeholderTextColor={colors.fieldPlaceholder}
      style={[nativeInputStyle, hasError && nativeInputErrorStyle]}
    />
  );
}

function NativeTimeInput({ value, onChange, hasError }: {
  value: string; onChange: (v: string) => void; hasError?: boolean;
}) {
  if (IS_WEB) {
    const InputTag: any = 'input';
    return (
      <InputTag
        type="time"
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
        style={[nativeInputStyle, hasError && nativeInputErrorStyle]}
      />
    );
  }
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder="HH:MM"
      placeholderTextColor={colors.fieldPlaceholder}
      style={[nativeInputStyle, hasError && nativeInputErrorStyle]}
    />
  );
}

const nativeInputStyle: any = {
  height: control.inputHeight,
  borderWidth: 1.5,
  borderColor: colors.fieldBorder,
  borderRadius: radii.sm,
  paddingHorizontal: spacing.md,
  fontSize: 14,
  color: colors.textPrimary,
  backgroundColor: colors.card,
  outlineStyle: 'none',
};

const nativeInputErrorStyle: any = {
  borderColor: colors.danger,
  backgroundColor: colors.dangerSurface,
};

// ── Filter select ─────────────────────────────────────────────────────────────

function FilterSelect({
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
      <SelectTag
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
        style={filterSelectStyle}
        aria-label={placeholder ?? 'Select'}
      >
        <OptionTag value="">{placeholder ?? 'Select'}</OptionTag>
        {options.map((opt) => (
          <OptionTag key={opt.value} value={opt.value}>{opt.label}</OptionTag>
        ))}
      </SelectTag>
    );
  }
  return null;
}

const filterSelectStyle: any = {
  height: 38,
  borderWidth: 1.5,
  borderColor: colors.fieldBorder,
  borderRadius: radii.sm,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  fontSize: 14,
  color: colors.textPrimary,
  backgroundColor: colors.card,
  outlineStyle: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

// ── Props ─────────────────────────────────────────────────────────────────────

type CompanyRotaPlannerWorkspaceProps = {
  // Filters
  plannerClientId: string;
  plannerSiteId: string;
  setPlannerClientId: (v: string) => void;
  setPlannerSiteId: (v: string) => void;
  siteClientOptions: Array<{ label: string; value: string }>;
  plannerSiteOptions: Array<{ label: string; value: string }>;

  // Week navigation
  weekCommencing: string;
  weekEnding: string;
  plannerWeekDays: PlannerWeekDay[];
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onTodayWeek: () => void;

  // Week data
  sites: RotaSiteWeekRow[];
  slotsByDayName: Map<string, FlatSlotCell[]>;
  weekSnapshot: RotaWeekSnapshot | null;
  loadingRota: boolean;
  rotaError: string | null;
  onRetryLoadRota: () => void;
  onRefreshWeek: () => void;

  // Legacy shifts
  legacyShiftsByDate: Map<string, LegacyShiftRow[]>;

  // Write callbacks (return updated detail; throw on error with user-friendly message)
  onLoadSlot: (slotId: number) => Promise<RotaSlotDetail>;
  onCreateSlot: (data: RotaCreatePayload) => Promise<RotaSlotDetail>;
  onSaveSlotEdits: (slotId: number, changes: RotaSlotChanges) => Promise<RotaSlotDetail>;
  onAssignPosition: (slotId: number, shiftId: number, guardId: number) => Promise<RotaSlotDetail>;
  onAssignMultiple: (slotId: number, assignments: Array<{ shiftId: number; guardId: number }>) => Promise<{ result: RotaAssignMultipleResult; detail: RotaSlotDetail }>;
  onCancelPosition: (slotId: number, shiftId: number) => Promise<RotaSlotDetail>;
  onCancelSlot: (slotId: number) => Promise<void>;
  onGetEligibleGuards: (shiftId: number) => Promise<EligibleGuardRow[]>;
};

// ── Day name constants ─────────────────────────────────────────────────────────

const DAY_NAMES = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;

// ── Main component ────────────────────────────────────────────────────────────

export function CompanyRotaPlannerWorkspace({
  plannerClientId,
  plannerSiteId,
  setPlannerClientId,
  setPlannerSiteId,
  siteClientOptions,
  plannerSiteOptions,
  weekCommencing,
  weekEnding,
  plannerWeekDays,
  onPrevWeek,
  onNextWeek,
  onTodayWeek,
  sites,
  slotsByDayName,
  weekSnapshot,
  loadingRota,
  rotaError,
  onRetryLoadRota,
  onRefreshWeek,
  legacyShiftsByDate,
  onLoadSlot,
  onCreateSlot,
  onSaveSlotEdits,
  onAssignPosition,
  onAssignMultiple,
  onCancelPosition,
  onCancelSlot,
  onGetEligibleGuards,
}: CompanyRotaPlannerWorkspaceProps) {

  // ── Slot detail state ──────────────────────────────────────────────────────
  const [slotDetail, setSlotDetail]       = React.useState<RotaSlotDetail | null>(null);
  const [loadingSlot, setLoadingSlot]     = React.useState(false);
  const [slotDrawerOpen, setSlotDrawerOpen] = React.useState(false);

  // ── Create drawer state ────────────────────────────────────────────────────
  const [createOpen, setCreateOpen]       = React.useState(false);
  const [createDefaultDate, setCreateDefaultDate] = React.useState('');
  const [createSiteId, setCreateSiteId]   = React.useState('');
  const [createDate, setCreateDate]       = React.useState('');
  const [createStart, setCreateStart]     = React.useState('');
  const [createEnd, setCreateEnd]         = React.useState('');
  const [createGuards, setCreateGuards]   = React.useState('1');
  const [createCheckCall, setCreateCheckCall] = React.useState('');
  const [createTitle, setCreateTitle]     = React.useState('');
  const [createInstructions, setCreateInstructions] = React.useState('');
  const [createErrors, setCreateErrors]   = React.useState<Record<string, string>>({});
  const [creating, setCreating]           = React.useState(false);
  const [createError, setCreateError]     = React.useState<string | null>(null);

  // ── Slot edit state ────────────────────────────────────────────────────────
  const [editMode, setEditMode]           = React.useState(false);
  const [editDate, setEditDate]           = React.useState('');
  const [editStart, setEditStart]         = React.useState('');
  const [editEnd, setEditEnd]             = React.useState('');
  const [editGuards, setEditGuards]       = React.useState('');
  const [editCheckCall, setEditCheckCall] = React.useState('');
  const [editTitle, setEditTitle]         = React.useState('');
  const [editInstructions, setEditInstructions] = React.useState('');
  const [editSaving, setEditSaving]       = React.useState(false);
  const [editError, setEditError]         = React.useState<string | null>(null);

  // ── Assignment state ───────────────────────────────────────────────────────
  const [assignShiftId, setAssignShiftId] = React.useState<number | null>(null);
  const [eligibleGuards, setEligibleGuards] = React.useState<EligibleGuardRow[]>([]);
  const [loadingEligible, setLoadingEligible] = React.useState(false);
  const [guardSearch, setGuardSearch]     = React.useState('');
  const [selectedGuardId, setSelectedGuardId] = React.useState<number | null>(null);
  const [assigning, setAssigning]         = React.useState(false);
  const [assignError, setAssignError]     = React.useState<string | null>(null);

  // ── Bulk assign state ──────────────────────────────────────────────────────
  const [bulkOpen, setBulkOpen]           = React.useState(false);
  const [bulkMap, setBulkMap]             = React.useState<Map<number, number>>(new Map()); // shiftId → guardId
  const [bulkGuardSearch, setBulkGuardSearch] = React.useState<Record<number, string>>({});
  const [bulkGuards, setBulkGuards]       = React.useState<Map<number, EligibleGuardRow[]>>(new Map());
  const [bulkLoadingShiftId, setBulkLoadingShiftId] = React.useState<number | null>(null);
  const [bulkSaving, setBulkSaving]       = React.useState(false);
  const [bulkResult, setBulkResult]       = React.useState<RotaAssignMultipleResult | null>(null);

  // ── Cancel position state ──────────────────────────────────────────────────
  const [cancelPositionShiftId, setCancelPositionShiftId] = React.useState<number | null>(null);
  const [cancellingPosition, setCancellingPosition] = React.useState(false);

  // ── Cancel slot state ──────────────────────────────────────────────────────
  const [cancelSlotConfirm, setCancelSlotConfirm] = React.useState(false);
  const [cancellingSlot, setCancellingSlot]       = React.useState(false);
  const [cancelSlotError, setCancelSlotError]     = React.useState<string | null>(null);

  // ── View mode ─────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = React.useState<'site-week' | 'day-list'>('site-week');

  // ── Computed ───────────────────────────────────────────────────────────────
  const snap = weekSnapshot;

  const weekLabel = plannerWeekDays.length >= 7
    ? `${plannerWeekDays[0].shortLabel} – ${plannerWeekDays[6].shortLabel}`
    : `${weekCommencing} – ${weekEnding}`;

  // Editing is allowed only for future slots that are not cancelled
  const canEdit = slotDetail
    && slotDetail.coveragePhase === 'future'
    && slotDetail.status !== 'cancelled';

  const canCancelSlot = slotDetail
    && slotDetail.status !== 'cancelled'
    && slotDetail.coveragePhase !== 'past';

  // ── Handlers ──────────────────────────────────────────────────────────────

  const openSlot = React.useCallback(async (slotId: number) => {
    setSlotDetail(null);
    setLoadingSlot(true);
    setSlotDrawerOpen(true);
    setEditMode(false);
    setAssignShiftId(null);
    setBulkOpen(false);
    setBulkResult(null);
    try {
      const d = await onLoadSlot(slotId);
      setSlotDetail(d);
    } catch {
      setSlotDrawerOpen(false);
    } finally {
      setLoadingSlot(false);
    }
  }, [onLoadSlot]);

  const closeSlot = React.useCallback(() => {
    setSlotDrawerOpen(false);
    setSlotDetail(null);
    setEditMode(false);
    setAssignShiftId(null);
    setBulkOpen(false);
    setBulkResult(null);
    setEditError(null);
  }, []);

  const enterEditMode = React.useCallback(() => {
    if (!slotDetail) return;
    setEditDate(isoToDateDisplay(slotDetail.startAt));
    setEditStart(isoToTimeDisplay(slotDetail.startAt));
    setEditEnd(isoToTimeDisplay(slotDetail.endAt));
    setEditGuards(String(slotDetail.counts.required));
    setEditCheckCall(String(slotDetail.checkCallIntervalMinutes));
    setEditTitle(slotDetail.title ?? '');
    setEditInstructions(slotDetail.instructions ?? '');
    setEditError(null);
    setEditMode(true);
  }, [slotDetail]);

  const handleSaveEdits = React.useCallback(async () => {
    if (!slotDetail) return;
    const changes: RotaSlotChanges = {};
    const origDate  = isoToDateDisplay(slotDetail.startAt);
    const origStart = isoToTimeDisplay(slotDetail.startAt);
    const origEnd   = isoToTimeDisplay(slotDetail.endAt);

    if (editDate !== origDate || editStart !== origStart || editEnd !== origEnd) {
      if (!isValidDate(editDate) || !isValidTime(editStart) || !isValidTime(editEnd)) {
        setEditError('Date and times must be valid.');
        return;
      }
      changes.startAt = buildNaiveIso(editDate, editStart);
      changes.endAt   = buildNaiveIsoEnd(editDate, editStart, editEnd);
    }

    const newCount = parseInt(editGuards, 10);
    if (!isNaN(newCount) && newCount !== slotDetail.counts.required) {
      if (newCount < 1) { setEditError('Guards required must be at least 1.'); return; }
      changes.requiredGuardCount = newCount;
    }

    const newCheck = parseInt(editCheckCall, 10);
    if (!isNaN(newCheck) && newCheck !== slotDetail.checkCallIntervalMinutes) {
      if (newCheck < 5) { setEditError('Check-call interval must be at least 5 minutes.'); return; }
      changes.checkCallIntervalMinutes = newCheck;
    }

    const newTitle        = editTitle.trim() || null;
    const newInstructions = editInstructions.trim() || null;
    if (newTitle !== slotDetail.title) changes.title = newTitle;
    if (newInstructions !== slotDetail.instructions) changes.instructions = newInstructions;

    if (Object.keys(changes).length === 0) { setEditMode(false); return; }

    setEditSaving(true);
    setEditError(null);
    try {
      const updated = await onSaveSlotEdits(slotDetail.id, changes);
      setSlotDetail(updated);
      setEditMode(false);
      onRefreshWeek();
    } catch (err: any) {
      setEditError(err?.message ?? 'Unable to save changes.');
    } finally {
      setEditSaving(false);
    }
  }, [slotDetail, editDate, editStart, editEnd, editGuards, editCheckCall, editTitle, editInstructions, onSaveSlotEdits, onRefreshWeek]);

  // ── Create slot ────────────────────────────────────────────────────────────

  const legacyCount = React.useMemo(
    () => Array.from(legacyShiftsByDate.values()).reduce((sum, rows) => sum + rows.length, 0),
    [legacyShiftsByDate],
  );

  const openCreate = React.useCallback((defaultDate?: string, defaultSiteId?: string) => {
    setCreateDate(defaultDate ?? weekCommencing);
    setCreateDefaultDate(defaultDate ?? '');
    setCreateSiteId(defaultSiteId ?? plannerSiteId);
    setCreateStart('');
    setCreateEnd('');
    setCreateGuards('1');
    setCreateCheckCall('');
    setCreateTitle('');
    setCreateInstructions('');
    setCreateErrors({});
    setCreateError(null);
    setCreateOpen(true);
  }, [plannerSiteId, weekCommencing]);

  const handleCreate = React.useCallback(async () => {
    const errs: Record<string, string> = {};
    if (!createSiteId) errs.site = 'Site is required.';
    if (!isValidDate(createDate)) errs.date = 'Valid date required (YYYY-MM-DD).';
    if (!isValidTime(createStart)) errs.start = 'Valid start time required (HH:MM).';
    if (!isValidTime(createEnd))   errs.end   = 'Valid end time required (HH:MM).';
    const guardsNum = parseInt(createGuards, 10);
    if (isNaN(guardsNum) || guardsNum < 1) errs.guards = 'At least 1 guard required.';
    const checkNum = createCheckCall ? parseInt(createCheckCall, 10) : undefined;
    if (createCheckCall && (isNaN(checkNum!) || checkNum! < 5)) {
      errs.checkCall = 'Check-call interval must be at least 5 minutes.';
    }
    if (Object.keys(errs).length > 0) { setCreateErrors(errs); return; }

    setCreating(true);
    setCreateError(null);
    try {
      const payload: RotaCreatePayload = {
        siteId: parseInt(createSiteId, 10),
        startAt: buildNaiveIso(createDate, createStart),
        endAt: buildNaiveIsoEnd(createDate, createStart, createEnd),
        requiredGuardCount: guardsNum,
        ...(checkNum !== undefined ? { checkCallIntervalMinutes: checkNum } : {}),
        ...(createTitle.trim() ? { title: createTitle.trim() } : {}),
        ...(createInstructions.trim() ? { instructions: createInstructions.trim() } : {}),
      };
      const detail = await onCreateSlot(payload);
      setCreateOpen(false);
      onRefreshWeek();
      // Open the newly created slot
      setSlotDetail(detail);
      setSlotDrawerOpen(true);
      setEditMode(false);
    } catch (err: any) {
      setCreateError(err?.message ?? 'Unable to create shift.');
    } finally {
      setCreating(false);
    }
  }, [createSiteId, createDate, createStart, createEnd, createGuards, createCheckCall, createTitle, createInstructions, onCreateSlot, onRefreshWeek]);

  // ── Single assign ──────────────────────────────────────────────────────────

  const openAssign = React.useCallback(async (shiftId: number) => {
    setAssignShiftId(shiftId);
    setSelectedGuardId(null);
    setGuardSearch('');
    setAssignError(null);
    setEligibleGuards([]);
    setLoadingEligible(true);
    try {
      const guards = await onGetEligibleGuards(shiftId);
      setEligibleGuards(guards);
    } catch {
      setEligibleGuards([]);
    } finally {
      setLoadingEligible(false);
    }
  }, [onGetEligibleGuards]);

  const handleAssign = React.useCallback(async () => {
    if (!slotDetail || !assignShiftId || !selectedGuardId) return;
    setAssigning(true);
    setAssignError(null);
    try {
      const updated = await onAssignPosition(slotDetail.id, assignShiftId, selectedGuardId);
      setSlotDetail(updated);
      setAssignShiftId(null);
      setSelectedGuardId(null);
      onRefreshWeek();
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      setAssignError(
        msg.includes('already been filled') || msg.includes('no longer available')
          ? 'This position has already been filled or is no longer available.'
          : msg || 'Unable to assign guard.',
      );
    } finally {
      setAssigning(false);
    }
  }, [slotDetail, assignShiftId, selectedGuardId, onAssignPosition, onRefreshWeek]);

  // ── Bulk assign ────────────────────────────────────────────────────────────

  const openBulk = React.useCallback(async () => {
    if (!slotDetail) return;
    const openPositions = slotDetail.positions.filter((p) => isPositionOpen(p.status));
    setBulkMap(new Map());
    setBulkGuardSearch({});
    setBulkGuards(new Map());
    setBulkResult(null);
    setBulkOpen(true);
    // Pre-load eligible guards for first open position if just one
    if (openPositions.length > 0) {
      const shiftId = openPositions[0].shiftId;
      setBulkLoadingShiftId(shiftId);
      try {
        const guards = await onGetEligibleGuards(shiftId);
        setBulkGuards(new Map([[shiftId, guards]]));
      } catch { /* swallow */ }
      setBulkLoadingShiftId(null);
    }
  }, [slotDetail, onGetEligibleGuards]);

  const loadBulkGuardsFor = React.useCallback(async (shiftId: number) => {
    if (bulkGuards.has(shiftId)) return;
    setBulkLoadingShiftId(shiftId);
    try {
      const guards = await onGetEligibleGuards(shiftId);
      setBulkGuards((prev) => new Map([...prev, [shiftId, guards]]));
    } catch { /* swallow */ }
    setBulkLoadingShiftId(null);
  }, [bulkGuards, onGetEligibleGuards]);

  const handleBulkAssign = React.useCallback(async () => {
    if (!slotDetail || bulkMap.size === 0) return;
    const assignments = Array.from(bulkMap.entries()).map(([shiftId, guardId]) => ({ shiftId, guardId }));
    setBulkSaving(true);
    try {
      const { result, detail } = await onAssignMultiple(slotDetail.id, assignments);
      setSlotDetail(detail);
      setBulkResult(result);
      setBulkMap(new Map());
      onRefreshWeek();
    } catch (err: any) {
      // Show error inline
    } finally {
      setBulkSaving(false);
    }
  }, [slotDetail, bulkMap, onAssignMultiple, onRefreshWeek]);

  // ── Cancel position ────────────────────────────────────────────────────────

  const handleCancelPosition = React.useCallback(async () => {
    if (!slotDetail || !cancelPositionShiftId) return;
    setCancellingPosition(true);
    try {
      const updated = await onCancelPosition(slotDetail.id, cancelPositionShiftId);
      setSlotDetail(updated);
      onRefreshWeek();
    } catch { /* swallow — idempotent */ }
    finally {
      setCancellingPosition(false);
      setCancelPositionShiftId(null);
    }
  }, [slotDetail, cancelPositionShiftId, onCancelPosition, onRefreshWeek]);

  // ── Cancel slot ────────────────────────────────────────────────────────────

  const handleCancelSlot = React.useCallback(async () => {
    if (!slotDetail) return;
    setCancellingSlot(true);
    setCancelSlotError(null);
    try {
      await onCancelSlot(slotDetail.id);
      closeSlot();
      onRefreshWeek();
    } catch (err: any) {
      setCancelSlotError(err?.message ?? 'Unable to cancel this shift.');
    } finally {
      setCancellingSlot(false);
      setCancelSlotConfirm(false);
    }
  }, [slotDetail, onCancelSlot, closeSlot, onRefreshWeek]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <View style={styles.workspace}>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <View style={styles.toolbar}>
        <View style={styles.filterGroup}>
          <View style={styles.filterCell}>
            <FilterSelect
              value={plannerClientId}
              onChange={setPlannerClientId}
              options={siteClientOptions}
              placeholder="All clients"
            />
          </View>
          <View style={styles.filterCell}>
            <FilterSelect
              value={plannerSiteId}
              onChange={setPlannerSiteId}
              options={plannerSiteOptions}
              placeholder="All sites"
            />
          </View>
        </View>

        {/* View switcher */}
        <View style={styles.viewSwitcher}>
          <Pressable
            style={({ pressed }: any) => [styles.viewSwitcherBtn, viewMode === 'site-week' && styles.viewSwitcherBtnActive, pressed && styles.viewSwitcherBtnPressed]}
            onPress={() => setViewMode('site-week')}
            accessibilityRole="button"
            accessibilityLabel="Site Week view"
          >
            <Text style={[styles.viewSwitcherText, viewMode === 'site-week' && styles.viewSwitcherTextActive]}>Site Week</Text>
          </Pressable>
          <Pressable
            style={({ pressed }: any) => [styles.viewSwitcherBtn, viewMode === 'day-list' && styles.viewSwitcherBtnActive, pressed && styles.viewSwitcherBtnPressed]}
            onPress={() => setViewMode('day-list')}
            accessibilityRole="button"
            accessibilityLabel="Day List view"
          >
            <Text style={[styles.viewSwitcherText, viewMode === 'day-list' && styles.viewSwitcherTextActive]}>Day List</Text>
          </Pressable>
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

        <Button label="+ Add Shift" variant="primary" size="sm" onPress={() => openCreate()} />
      </View>

      {/* ── Summary strip ─────────────────────────────────────────────────── */}
      {snap && (
        <View style={styles.summaryStrip}>
          <SummaryStat value={snap.totalSlots}      label="Shifts" />
          <View style={styles.summaryDivider} />
          <SummaryStat value={snap.totalPositions}  label="Guard positions" />
          <View style={styles.summaryDivider} />
          <SummaryStat
            value={snap.openPositions}
            label="Open"
            highlight={snap.openPositions > 0 ? 'danger' : undefined}
          />
          <View style={styles.summaryDivider} />
          <SummaryStat
            value={snap.offeredPending}
            label="Awaiting"
            highlight={snap.offeredPending > 0 ? 'info' : undefined}
          />
          <View style={styles.summaryDivider} />
          <SummaryStat
            value={snap.onShiftNow}
            label="On shift"
            highlight={snap.onShiftNow > 0 ? 'success' : undefined}
          />
          <View style={styles.summaryDivider} />
          <SummaryStat
            value={snap.problems}
            label="Attention"
            highlight={snap.problems > 0 ? 'warning' : undefined}
          />
        </View>
      )}

      {/* ── Loading ───────────────────────────────────────────────────────── */}
      {loadingRota && (
        <View style={styles.centeredFeedback}>
          <ActivityIndicator color={colors.accentTeal} />
          <Text style={styles.feedbackText}>Loading rota…</Text>
        </View>
      )}

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {!loadingRota && rotaError && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{rotaError}</Text>
          <Button label="Retry" variant="secondary" size="sm" onPress={onRetryLoadRota} />
        </View>
      )}

      {/* ── Site Week matrix ──────────────────────────────────────────────── */}
      {!loadingRota && !rotaError && viewMode === 'site-week' && (
        <SiteWeekMatrix
          sites={sites}
          plannerWeekDays={plannerWeekDays}
          legacyCount={legacyCount}
          onSwitchToDayList={() => setViewMode('day-list')}
          onOpenSlot={openSlot}
          onOpenCreate={(sid, date) => openCreate(date, sid)}
        />
      )}

      {/* ── Day sections ──────────────────────────────────────────────────── */}
      {!loadingRota && !rotaError && viewMode === 'day-list' && (
        <View style={styles.daySections}>
          {plannerWeekDays.map((day, dayIdx) => {
            const dayName = DAY_NAMES[dayIdx];
            const slots = slotsByDayName.get(dayName) ?? [];
            const legacyRows = legacyShiftsByDate.get(day.date) ?? [];
            const totalRows = slots.length + legacyRows.length;
            const dayOpenCount = slots.reduce((acc, s) => acc + s.counts.open, 0);

            return (
              <View key={day.date} style={styles.daySection}>
                {/* Day header */}
                <View style={styles.dayHeader}>
                  <View style={styles.dayHeaderTitle}>
                    <Text style={styles.dayName}>{day.label}</Text>
                    <Text style={styles.dayShortLabel}>{day.shortLabel}</Text>
                  </View>
                  <View style={styles.dayHeaderMeta}>
                    {totalRows > 0 && (
                      <Text style={styles.daySlotCount}>
                        {slots.length} shift{slots.length !== 1 ? 's' : ''}
                        {legacyRows.length > 0 && ` · ${legacyRows.length} legacy`}
                      </Text>
                    )}
                    {dayOpenCount > 0 && (
                      <View style={styles.openChip}>
                        <Text style={styles.openChipText}>{dayOpenCount} Open</Text>
                      </View>
                    )}
                    <Pressable
                      onPress={() => openCreate(day.date)}
                      style={({ pressed }: any) => [styles.addDayBtn, pressed && styles.addDayBtnPressed]}
                      accessibilityRole="button"
                      accessibilityLabel={`Add shift on ${day.label}`}
                    >
                      <Text style={styles.addDayBtnText}>+</Text>
                    </Pressable>
                  </View>
                </View>

                {/* Slot rows */}
                {slots.length === 0 && legacyRows.length === 0 ? (
                  <View style={styles.emptyDayRow}>
                    <Text style={styles.emptyDayText}>No shifts planned.</Text>
                  </View>
                ) : (
                  <>
                    {slots.map((cell, idx) => (
                      <Fragment key={`slot-${cell.slotId}`}>
                        <RotaSlotRow
                          cell={cell}
                          isLast={idx === slots.length - 1 && legacyRows.length === 0}
                          onPress={() => openSlot(cell.slotId)}
                        />
                      </Fragment>
                    ))}
                    {legacyRows.map((legacy, idx) => (
                      <Fragment key={`legacy-${legacy.id}`}>
                        <LegacyRow
                          row={legacy}
                          isLast={idx === legacyRows.length - 1}
                        />
                      </Fragment>
                    ))}
                  </>
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* ── Create Slot drawer ─────────────────────────────────────────────── */}
      <Drawer
        visible={createOpen}
        onClose={() => !creating && setCreateOpen(false)}
        title="Add Shift"
        compact
        width={480}
        footer={
          <View style={styles.drawerFooterRow}>
            <Button label="Cancel" variant="secondary" size="sm" onPress={() => setCreateOpen(false)} disabled={creating} />
            <Button label="Create Shift" variant="primary" size="sm" onPress={handleCreate} loading={creating} />
          </View>
        }
      >
        <CreateSlotBody
          siteOptions={plannerSiteOptions}
          siteId={createSiteId} onSiteId={setCreateSiteId}
          date={createDate} onDate={setCreateDate}
          start={createStart} onStart={setCreateStart}
          end={createEnd} onEnd={setCreateEnd}
          guards={createGuards} onGuards={setCreateGuards}
          checkCall={createCheckCall} onCheckCall={setCreateCheckCall}
          title={createTitle} onTitle={setCreateTitle}
          instructions={createInstructions} onInstructions={setCreateInstructions}
          errors={createErrors}
          submitError={createError}
        />
      </Drawer>

      {/* ── Slot detail drawer ─────────────────────────────────────────────── */}
      <Drawer
        visible={slotDrawerOpen}
        onClose={closeSlot}
        title={slotDetail?.siteName ?? 'Loading…'}
        subtitle={
          slotDetail
            ? `${formatUtcDate(slotDetail.startAt)} · ${formatUtcTime(slotDetail.startAt)}–${formatUtcTime(slotDetail.endAt)}`
            : ''
        }
        compact
        width={520}
        footer={
          <View style={styles.drawerFooterRow}>
            {editMode ? (
              <>
                <Button label="Cancel" variant="secondary" size="sm" onPress={() => setEditMode(false)} disabled={editSaving} />
                <Button label="Save Changes" variant="primary" size="sm" onPress={handleSaveEdits} loading={editSaving} />
              </>
            ) : (
              <>
                {canCancelSlot && (
                  <Button label="Cancel Shift" variant="danger" size="sm" onPress={() => setCancelSlotConfirm(true)} />
                )}
                <View style={styles.drawerFooterSpacer} />
                {canEdit && !editMode && (
                  <Button label="Edit" variant="secondary" size="sm" onPress={enterEditMode} />
                )}
                <Button label="Close" variant="secondary" size="sm" onPress={closeSlot} />
              </>
            )}
          </View>
        }
      >
        <SlotDetailBody
          detail={slotDetail}
          loading={loadingSlot}
          editMode={editMode}
          canEdit={!!canEdit}
          editDate={editDate} onEditDate={setEditDate}
          editStart={editStart} onEditStart={setEditStart}
          editEnd={editEnd} onEditEnd={setEditEnd}
          editGuards={editGuards} onEditGuards={setEditGuards}
          editCheckCall={editCheckCall} onEditCheckCall={setEditCheckCall}
          editTitle={editTitle} onEditTitle={setEditTitle}
          editInstructions={editInstructions} onEditInstructions={setEditInstructions}
          editError={editError}
          cancelSlotError={cancelSlotError}
          assignShiftId={assignShiftId}
          onOpenAssign={openAssign}
          onCloseAssign={() => { setAssignShiftId(null); setAssignError(null); }}
          eligibleGuards={eligibleGuards}
          loadingEligible={loadingEligible}
          guardSearch={guardSearch}
          onGuardSearch={setGuardSearch}
          selectedGuardId={selectedGuardId}
          onSelectGuard={setSelectedGuardId}
          onConfirmAssign={handleAssign}
          assigning={assigning}
          assignError={assignError}
          bulkOpen={bulkOpen}
          onOpenBulk={openBulk}
          onCloseBulk={() => { setBulkOpen(false); setBulkResult(null); }}
          bulkMap={bulkMap}
          onBulkMapChange={setBulkMap}
          bulkGuards={bulkGuards}
          bulkGuardSearch={bulkGuardSearch}
          onBulkGuardSearch={setBulkGuardSearch}
          bulkLoadingShiftId={bulkLoadingShiftId}
          onLoadBulkGuards={loadBulkGuardsFor}
          onBulkAssign={handleBulkAssign}
          bulkSaving={bulkSaving}
          bulkResult={bulkResult}
          onRequestCancelPosition={setCancelPositionShiftId}
        />
      </Drawer>

      {/* ── Cancel position dialog ─────────────────────────────────────────── */}
      <ConfirmationDialog
        visible={cancelPositionShiftId !== null}
        onClose={() => setCancelPositionShiftId(null)}
        onConfirm={handleCancelPosition}
        title="Cancel Position"
        message="This guard position will be cancelled. The record is preserved. You can re-open a position by increasing the requirement."
        confirmLabel="Cancel Position"
        variant="danger"
        loading={cancellingPosition}
      />

      {/* ── Cancel slot dialog ─────────────────────────────────────────────── */}
      <ConfirmationDialog
        visible={cancelSlotConfirm}
        onClose={() => setCancelSlotConfirm(false)}
        onConfirm={handleCancelSlot}
        title="Cancel Shift"
        message="The shift requirement will be cancelled. Historical records are preserved. This cannot be undone for committed guard positions."
        confirmLabel="Cancel Shift"
        variant="danger"
        loading={cancellingSlot}
      />
    </View>
  );
}

// ── RotaSlot row ──────────────────────────────────────────────────────────────

function RotaSlotRow({
  cell, isLast, onPress,
}: {
  cell: FlatSlotCell;
  isLast: boolean;
  onPress: () => void;
}) {
  const tok     = slotStateTokens(cell.coverageState);
  const timeStr = `${formatUtcTime(cell.startAt)}–${formatUtcTime(cell.endAt)}`;

  // Awaiting is not covered — use phase-appropriate numerator
  const coverNum   = cell.coveragePhase === 'live' ? cell.counts.onShift
                   : cell.coveragePhase === 'past' ? cell.counts.completed
                   : cell.counts.confirmed;
  const coverVerb  = cell.coveragePhase === 'live' ? 'on shift'
                   : cell.coveragePhase === 'past' ? 'completed'
                   : 'covered';
  const coverStr   = `${coverNum} / ${cell.counts.required} ${coverVerb}`;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed, hovered }: any) => [
        styles.slotRow,
        !isLast && styles.slotRowDivider,
        (pressed || hovered) && styles.slotRowHovered,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${timeStr} ${cell.siteName} ${coverNum} of ${cell.counts.required} ${coverVerb}${tok.label ? ` ${tok.label}` : ''}`}
    >
      <View style={[styles.accentBar, { backgroundColor: tok.problem ? tok.fg : 'transparent' }]} />
      <View style={styles.rowContent}>
        <View style={styles.colTimeWrap}>
          <Text style={styles.colTime} numberOfLines={1}>{timeStr}</Text>
          {cell.isNightShift && <Text style={styles.nightDot}>●</Text>}
        </View>
        <Text style={styles.colSite} numberOfLines={1}>{cell.siteName || '—'}</Text>
        <View style={styles.colCoverWrap}>
          <Text style={styles.colCover}>{coverStr}</Text>
          {cell.counts.open > 0 && (
            <Text style={styles.colCoverOpen}>{cell.counts.open} Open</Text>
          )}
          {cell.counts.offered > 0 && cell.coveragePhase === 'future' && (
            <Text style={styles.colCoverAwaiting}>{cell.counts.offered} Awaiting</Text>
          )}
        </View>
        {tok.label !== '' && (
          <View style={[styles.stateBadge, { backgroundColor: tok.bg }]}>
            <Text style={[styles.stateBadgeText, { color: tok.fg }]} numberOfLines={1}>
              {tok.label}
            </Text>
          </View>
        )}
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

// ── Legacy row ────────────────────────────────────────────────────────────────

function LegacyRow({ row, isLast }: { row: LegacyShiftRow; isLast: boolean }) {
  return (
    <View style={[styles.slotRow, !isLast && styles.slotRowDivider, styles.legacyRow]}>
      <View style={styles.accentBar} />
      <View style={styles.rowContent}>
        <Text style={styles.colTime} numberOfLines={1}>
          {row.startTime}–{row.endTime}
        </Text>
        <Text style={styles.colSite} numberOfLines={1}>{row.siteName || '—'}</Text>
        <Text style={styles.colGuardLegacy} numberOfLines={1}>
          {row.guardName ?? 'Unassigned'}
        </Text>
        <View style={styles.legacyPill}>
          <Text style={styles.legacyPillText}>Legacy</Text>
        </View>
      </View>
    </View>
  );
}

// ── Create slot drawer body ───────────────────────────────────────────────────

function CreateSlotBody({
  siteOptions, siteId, onSiteId,
  date, onDate, start, onStart, end, onEnd,
  guards, onGuards, checkCall, onCheckCall,
  title, onTitle, instructions, onInstructions,
  errors, submitError,
}: {
  siteOptions: Array<{ label: string; value: string }>;
  siteId: string; onSiteId: (v: string) => void;
  date: string; onDate: (v: string) => void;
  start: string; onStart: (v: string) => void;
  end: string; onEnd: (v: string) => void;
  guards: string; onGuards: (v: string) => void;
  checkCall: string; onCheckCall: (v: string) => void;
  title: string; onTitle: (v: string) => void;
  instructions: string; onInstructions: (v: string) => void;
  errors: Record<string, string>;
  submitError: string | null;
}) {
  return (
    <ScrollView style={db.scroll} showsVerticalScrollIndicator={false}>
      <View style={db.body}>

        {submitError && (
          <View style={db.submitError}>
            <Text style={db.submitErrorText}>{submitError}</Text>
          </View>
        )}

        <SectionLabel label="Shift Details" />

        <FormField label="Site" required error={errors.site}>
          <FilterSelect
            value={siteId}
            onChange={onSiteId}
            options={siteOptions}
            placeholder="Select site…"
          />
        </FormField>

        <FormField label="Title" error={errors.title}>
          <FieldInput
            value={title}
            onChangeText={onTitle}
            placeholder="Optional label"
            hasError={!!errors.title}
          />
        </FormField>

        <SectionLabel label="Schedule" spaced />

        <FormField label="Date" required error={errors.date}>
          <NativeDateInput value={date} onChange={onDate} hasError={!!errors.date} />
        </FormField>

        <View style={db.timeRow}>
          <View style={db.timeCell}>
            <FormField label="Start" required error={errors.start}>
              <NativeTimeInput value={start} onChange={onStart} hasError={!!errors.start} />
            </FormField>
          </View>
          <View style={db.timeCell}>
            <FormField label="End" required error={errors.end}>
              <NativeTimeInput value={end} onChange={onEnd} hasError={!!errors.end} />
            </FormField>
          </View>
        </View>

        <SectionLabel label="Cover" spaced />

        <FormField label="Guards required" required error={errors.guards}
          helperText="Enter the total number of guards needed, e.g. 15 for a large event.">
          <FieldInput
            value={guards}
            onChangeText={onGuards}
            keyboardType="numeric"
            placeholder="1"
            hasError={!!errors.guards}
          />
        </FormField>

        <SectionLabel label="Check Calls" spaced />

        <FormField label="Interval (minutes)" error={errors.checkCall}
          helperText="Leave blank to use the site default.">
          <FieldInput
            value={checkCall}
            onChangeText={onCheckCall}
            keyboardType="numeric"
            placeholder="Site default"
            hasError={!!errors.checkCall}
          />
        </FormField>

        <SectionLabel label="Notes" spaced />

        <FormField label="Instructions" error={errors.instructions}>
          <FieldTextarea
            value={instructions}
            onChangeText={onInstructions}
            placeholder="Guard instructions…"
            minLines={3}
            hasError={!!errors.instructions}
          />
        </FormField>

      </View>
    </ScrollView>
  );
}

// ── Slot detail body ──────────────────────────────────────────────────────────

function SlotDetailBody({
  detail, loading, editMode, canEdit,
  editDate, onEditDate, editStart, onEditStart, editEnd, onEditEnd,
  editGuards, onEditGuards, editCheckCall, onEditCheckCall,
  editTitle, onEditTitle, editInstructions, onEditInstructions,
  editError, cancelSlotError,
  assignShiftId, onOpenAssign, onCloseAssign,
  eligibleGuards, loadingEligible, guardSearch, onGuardSearch,
  selectedGuardId, onSelectGuard, onConfirmAssign, assigning, assignError,
  bulkOpen, onOpenBulk, onCloseBulk,
  bulkMap, onBulkMapChange, bulkGuards, bulkGuardSearch, onBulkGuardSearch,
  bulkLoadingShiftId, onLoadBulkGuards, onBulkAssign, bulkSaving, bulkResult,
  onRequestCancelPosition,
}: {
  detail: RotaSlotDetail | null;
  loading: boolean;
  editMode: boolean;
  canEdit: boolean;
  editDate: string; onEditDate: (v: string) => void;
  editStart: string; onEditStart: (v: string) => void;
  editEnd: string; onEditEnd: (v: string) => void;
  editGuards: string; onEditGuards: (v: string) => void;
  editCheckCall: string; onEditCheckCall: (v: string) => void;
  editTitle: string; onEditTitle: (v: string) => void;
  editInstructions: string; onEditInstructions: (v: string) => void;
  editError: string | null;
  cancelSlotError: string | null;
  assignShiftId: number | null;
  onOpenAssign: (shiftId: number) => void;
  onCloseAssign: () => void;
  eligibleGuards: EligibleGuardRow[];
  loadingEligible: boolean;
  guardSearch: string;
  onGuardSearch: (v: string) => void;
  selectedGuardId: number | null;
  onSelectGuard: (id: number | null) => void;
  onConfirmAssign: () => void;
  assigning: boolean;
  assignError: string | null;
  bulkOpen: boolean;
  onOpenBulk: () => void;
  onCloseBulk: () => void;
  bulkMap: Map<number, number>;
  onBulkMapChange: (m: Map<number, number>) => void;
  bulkGuards: Map<number, EligibleGuardRow[]>;
  bulkGuardSearch: Record<number, string>;
  onBulkGuardSearch: (v: Record<number, string>) => void;
  bulkLoadingShiftId: number | null;
  onLoadBulkGuards: (shiftId: number) => void;
  onBulkAssign: () => void;
  bulkSaving: boolean;
  bulkResult: RotaAssignMultipleResult | null;
  onRequestCancelPosition: (shiftId: number) => void;
}) {
  if (loading) {
    return (
      <View style={db.centeredLoading}>
        <ActivityIndicator color={colors.accentTeal} />
        <Text style={db.loadingText}>Loading…</Text>
      </View>
    );
  }

  if (!detail) return null;

  const isLivePast = detail.coveragePhase !== 'future';
  const isCancelled = detail.status === 'cancelled';
  const openPositions = detail.positions.filter((p) => isPositionOpen(p.status));

  return (
    <ScrollView style={db.scroll} showsVerticalScrollIndicator={false}>
      <View style={db.body}>

        {/* Phase / status hint */}
        {isCancelled && (
          <View style={db.hintBox}>
            <Text style={db.hintText}>This shift has been cancelled. All records are preserved.</Text>
          </View>
        )}
        {!isCancelled && isLivePast && (
          <View style={[db.hintBox, db.hintBoxInfo]}>
            <Text style={db.hintText}>
              {detail.coveragePhase === 'live'
                ? 'Shift is underway. Time and requirement changes are locked.'
                : 'Shift has ended. All operational fields are read-only.'}
            </Text>
          </View>
        )}
        {cancelSlotError && (
          <View style={db.submitError}><Text style={db.submitErrorText}>{cancelSlotError}</Text></View>
        )}

        {/* Cover summary */}
        <CoverSummary counts={detail.counts} phase={detail.coveragePhase} />

        {/* Schedule */}
        <SectionLabel label="Schedule" spaced />

        {editMode ? (
          <>
            {editError && (
              <View style={db.submitError}><Text style={db.submitErrorText}>{editError}</Text></View>
            )}
            <FormField label="Date" required>
              <NativeDateInput value={editDate} onChange={onEditDate} />
            </FormField>
            <View style={db.timeRow}>
              <View style={db.timeCell}>
                <FormField label="Start" required>
                  <NativeTimeInput value={editStart} onChange={onEditStart} />
                </FormField>
              </View>
              <View style={db.timeCell}>
                <FormField label="End" required>
                  <NativeTimeInput value={editEnd} onChange={onEditEnd} />
                </FormField>
              </View>
            </View>
          </>
        ) : (
          <>
            <DetailRow label="Date"  value={formatUtcDate(detail.startAt)} />
            <DetailRow label="Start" value={formatUtcTime(detail.startAt)} />
            <DetailRow label="End"   value={formatUtcTime(detail.endAt)} />
            {detail.title && <DetailRow label="Title" value={detail.title} />}
          </>
        )}

        {/* Requirement */}
        <SectionLabel label="Guard requirement" spaced />
        {editMode && !isLivePast ? (
          <FormField label="Guards required" required>
            <FieldInput
              value={editGuards}
              onChangeText={onEditGuards}
              keyboardType="numeric"
            />
          </FormField>
        ) : (
          <DetailRow label="Required" value={String(detail.counts.required)} />
        )}

        {/* Check calls */}
        <SectionLabel label="Check calls" spaced />
        {editMode ? (
          <FormField label="Interval (minutes)" required>
            <FieldInput
              value={editCheckCall}
              onChangeText={onEditCheckCall}
              keyboardType="numeric"
            />
          </FormField>
        ) : (
          <DetailRow label="Interval" value={`${detail.checkCallIntervalMinutes} min`} />
        )}

        {/* Metadata */}
        {editMode ? (
          <>
            <SectionLabel label="Details" spaced />
            <FormField label="Title">
              <FieldInput value={editTitle} onChangeText={onEditTitle} placeholder="Optional label" />
            </FormField>
            <FormField label="Instructions">
              <FieldTextarea value={editInstructions} onChangeText={onEditInstructions} placeholder="Guard instructions…" minLines={3} />
            </FormField>
          </>
        ) : detail.instructions ? (
          <>
            <SectionLabel label="Instructions" spaced />
            <Text style={db.instructionsText}>{detail.instructions}</Text>
          </>
        ) : null}

        {/* Guard positions section */}
        {!editMode && (
          <>
            <View style={db.positionsSectionHeader}>
              <Text style={[db.sectionLabel, db.sectionLabelPositions]}>
                Guard positions ({detail.positions.length})
              </Text>
              {openPositions.length > 1 && !bulkOpen && (
                <Pressable
                  onPress={onOpenBulk}
                  style={({ pressed }: any) => [db.bulkAssignBtn, pressed && db.bulkAssignBtnPressed]}
                >
                  <Text style={db.bulkAssignBtnText}>Assign guards ({openPositions.length} open)</Text>
                </Pressable>
              )}
              {bulkOpen && (
                <Pressable onPress={onCloseBulk}>
                  <Text style={db.bulkAssignBtnText}>Done</Text>
                </Pressable>
              )}
            </View>

            {/* Bulk result banner */}
            {bulkResult && (
              <View style={[db.hintBox, bulkResult.failed.length > 0 ? db.hintBoxWarn : db.hintBoxInfo]}>
                <Text style={db.hintText}>
                  {bulkResult.assigned.length} guard{bulkResult.assigned.length !== 1 ? 's' : ''} assigned
                  {bulkResult.failed.length > 0 && `, ${bulkResult.failed.length} could not be assigned`}
                </Text>
                {bulkResult.failed.map((f, i) => (
                  <Fragment key={i}>
                    <Text style={db.hintSubText}>Position #{f.shiftId}: {f.reason}</Text>
                  </Fragment>
                ))}
              </View>
            )}

            {/* Bulk assign panel */}
            {bulkOpen && !bulkResult && (
              <BulkAssignPanel
                openPositions={openPositions}
                bulkMap={bulkMap}
                onBulkMapChange={onBulkMapChange}
                bulkGuards={bulkGuards}
                bulkGuardSearch={bulkGuardSearch}
                onBulkGuardSearch={onBulkGuardSearch}
                bulkLoadingShiftId={bulkLoadingShiftId}
                onLoadBulkGuards={onLoadBulkGuards}
                onBulkAssign={onBulkAssign}
                bulkSaving={bulkSaving}
              />
            )}

            {/* Position list */}
            {!bulkOpen && detail.positions.map((pos) => (
              <Fragment key={pos.shiftId}>
                <PositionRow
                  position={pos}
                  isAssigning={assignShiftId === pos.shiftId}
                  onOpenAssign={() => onOpenAssign(pos.shiftId)}
                  onCloseAssign={onCloseAssign}
                  eligibleGuards={eligibleGuards}
                  loadingEligible={loadingEligible}
                  guardSearch={guardSearch}
                  onGuardSearch={onGuardSearch}
                  selectedGuardId={selectedGuardId}
                  onSelectGuard={onSelectGuard}
                  onConfirmAssign={onConfirmAssign}
                  assigning={assigning}
                  assignError={assignError}
                  canAssign={!isCancelled && isPositionOpen(pos.status)}
                  canCancel={!isCancelled && canCancelPosition(pos.status)}
                  onRequestCancel={() => onRequestCancelPosition(pos.shiftId)}
                />
              </Fragment>
            ))}
            {detail.positions.length === 0 && (
              <Text style={db.noPositions}>No positions.</Text>
            )}
          </>
        )}

      </View>
    </ScrollView>
  );
}

// ── Position row ──────────────────────────────────────────────────────────────

function PositionRow({
  position, isAssigning,
  onOpenAssign, onCloseAssign,
  eligibleGuards, loadingEligible, guardSearch, onGuardSearch,
  selectedGuardId, onSelectGuard, onConfirmAssign, assigning, assignError,
  canAssign, canCancel, onRequestCancel,
}: {
  position: { shiftId: number; guardId: number | null; guardName: string | null; status: string };
  isAssigning: boolean;
  onOpenAssign: () => void;
  onCloseAssign: () => void;
  eligibleGuards: EligibleGuardRow[];
  loadingEligible: boolean;
  guardSearch: string;
  onGuardSearch: (v: string) => void;
  selectedGuardId: number | null;
  onSelectGuard: (id: number | null) => void;
  onConfirmAssign: () => void;
  assigning: boolean;
  assignError: string | null;
  canAssign: boolean;
  canCancel: boolean;
  onRequestCancel: () => void;
}) {
  const tok = positionStatusTokens(position.status);

  const filteredGuards = React.useMemo(() => {
    const q = guardSearch.toLowerCase();
    return eligibleGuards.filter((g) =>
      !q || (g.fullName ?? '').toLowerCase().includes(q),
    );
  }, [eligibleGuards, guardSearch]);

  return (
    <View style={db.positionBlock}>
      <View style={db.positionRow}>
        <Text style={db.positionName} numberOfLines={1}>
          {position.guardName ?? 'Open position'}
        </Text>
        <Text style={[db.positionStatus, { color: tok.fg }]}>{tok.label}</Text>
        <View style={db.positionActions}>
          {canAssign && !isAssigning && (
            <Pressable
              onPress={onOpenAssign}
              style={({ pressed }: any) => [db.actionBtn, pressed && db.actionBtnPressed]}
            >
              <Text style={[db.actionBtnText, { color: colors.accentTeal }]}>Assign</Text>
            </Pressable>
          )}
          {canCancel && !isAssigning && (
            <Pressable
              onPress={onRequestCancel}
              style={({ pressed }: any) => [db.actionBtn, pressed && db.actionBtnPressed]}
            >
              <Text style={[db.actionBtnText, { color: colors.danger }]}>Cancel</Text>
            </Pressable>
          )}
          {isAssigning && (
            <Pressable
              onPress={onCloseAssign}
              style={({ pressed }: any) => [db.actionBtn, pressed && db.actionBtnPressed]}
            >
              <Text style={[db.actionBtnText, { color: colors.textMuted }]}>✕</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Assign panel */}
      {isAssigning && (
        <View style={db.assignPanel}>
          {assignError && (
            <View style={db.assignError}>
              <Text style={db.assignErrorText}>{assignError}</Text>
            </View>
          )}
          <FieldInput
            value={guardSearch}
            onChangeText={onGuardSearch}
            placeholder="Search guards…"
            autoFocus
          />
          {loadingEligible ? (
            <ActivityIndicator color={colors.accentTeal} style={db.assignSpinner} />
          ) : (
            <ScrollView style={db.guardList} nestedScrollEnabled>
              {filteredGuards.length === 0 && (
                <Text style={db.noGuardsText}>
                  {guardSearch ? 'No guards match.' : 'No eligible guards available.'}
                </Text>
              )}
              {filteredGuards.map((g) => (
                <Pressable
                  key={g.guardId}
                  onPress={() => onSelectGuard(selectedGuardId === g.guardId ? null : g.guardId)}
                  style={({ pressed }: any) => [
                    db.guardItem,
                    selectedGuardId === g.guardId && db.guardItemSelected,
                    pressed && db.guardItemPressed,
                  ]}
                >
                  <View style={db.guardItemMain}>
                    <Text style={db.guardItemName} numberOfLines={1}>{g.fullName ?? `Guard #${g.guardId}`}</Text>
                    {!g.isEligible && (
                      <Text style={db.guardItemIneligible}>Ineligible</Text>
                    )}
                    {g.isEligible && g.availabilityStatus === 'available' && (
                      <Text style={db.guardItemAvail}>Available</Text>
                    )}
                    {g.isEligible && g.availabilityStatus !== 'available' && (
                      <Text style={db.guardItemUnavail}>{g.availabilityStatus}</Text>
                    )}
                  </View>
                  {g.reasons.length > 0 && (
                    <Text style={db.guardItemReason} numberOfLines={2}>{g.reasons.join(' · ')}</Text>
                  )}
                </Pressable>
              ))}
            </ScrollView>
          )}
          <View style={db.assignFooter}>
            <Button
              label="Assign"
              variant="primary"
              size="sm"
              onPress={onConfirmAssign}
              disabled={!selectedGuardId || assigning}
              loading={assigning}
            />
          </View>
        </View>
      )}
    </View>
  );
}

// ── Bulk assign panel ─────────────────────────────────────────────────────────

function BulkAssignPanel({
  openPositions, bulkMap, onBulkMapChange,
  bulkGuards, bulkGuardSearch, onBulkGuardSearch,
  bulkLoadingShiftId, onLoadBulkGuards, onBulkAssign, bulkSaving,
}: {
  openPositions: Array<{ shiftId: number; guardId: number | null; guardName: string | null; status: string }>;
  bulkMap: Map<number, number>;
  onBulkMapChange: (m: Map<number, number>) => void;
  bulkGuards: Map<number, EligibleGuardRow[]>;
  bulkGuardSearch: Record<number, string>;
  onBulkGuardSearch: (v: Record<number, string>) => void;
  bulkLoadingShiftId: number | null;
  onLoadBulkGuards: (shiftId: number) => void;
  onBulkAssign: () => void;
  bulkSaving: boolean;
}) {
  const alreadySelectedGuardIds = new Set(Array.from(bulkMap.values()));

  return (
    <View style={db.bulkPanel}>
      {openPositions.map((pos, idx) => {
        const search = bulkGuardSearch[pos.shiftId] ?? '';
        const guards = (bulkGuards.get(pos.shiftId) ?? []).filter((g) => {
          if (!search) return true;
          return (g.fullName ?? '').toLowerCase().includes(search.toLowerCase());
        });
        const selected = bulkMap.get(pos.shiftId) ?? null;
        const loading = bulkLoadingShiftId === pos.shiftId;
        const isLast = idx === openPositions.length - 1;

        return (
          <View key={pos.shiftId} style={[db.bulkPositionBlock, !isLast && db.bulkPositionDivider]}>
            <Text style={db.bulkPositionLabel}>Open position #{idx + 1}</Text>

            <FieldInput
              value={search}
              onChangeText={(v: string) => {
                onBulkGuardSearch({ ...bulkGuardSearch, [pos.shiftId]: v });
                onLoadBulkGuards(pos.shiftId);
              }}
              placeholder="Search guards…"
            />

            {loading ? (
              <ActivityIndicator color={colors.accentTeal} style={db.assignSpinner} />
            ) : (
              <ScrollView style={db.bulkGuardList} nestedScrollEnabled>
                {guards.slice(0, 12).map((g) => {
                  const isChosen = selected === g.guardId;
                  const usedElsewhere = !isChosen && alreadySelectedGuardIds.has(g.guardId);
                  return (
                    <Pressable
                      key={g.guardId}
                      onPress={() => {
                        const next = new Map(bulkMap);
                        if (isChosen) next.delete(pos.shiftId);
                        else next.set(pos.shiftId, g.guardId);
                        onBulkMapChange(next);
                      }}
                      disabled={usedElsewhere}
                      style={({ pressed }: any) => [
                        db.guardItem,
                        isChosen && db.guardItemSelected,
                        usedElsewhere && db.guardItemDimmed,
                        pressed && !usedElsewhere && db.guardItemPressed,
                      ]}
                    >
                      <Text style={db.guardItemName} numberOfLines={1}>
                        {g.fullName ?? `Guard #${g.guardId}`}
                        {usedElsewhere ? '  (assigned elsewhere)' : ''}
                      </Text>
                    </Pressable>
                  );
                })}
                {guards.length === 0 && (
                  <Text style={db.noGuardsText}>No eligible guards.</Text>
                )}
              </ScrollView>
            )}
          </View>
        );
      })}

      <View style={db.bulkFooter}>
        <Text style={db.bulkCount}>{bulkMap.size} of {openPositions.length} selected</Text>
        <Button
          label={bulkSaving ? 'Assigning…' : 'Assign Selected'}
          variant="primary"
          size="sm"
          onPress={onBulkAssign}
          disabled={bulkMap.size === 0 || bulkSaving}
          loading={bulkSaving}
        />
      </View>
    </View>
  );
}

// ── Cover summary ─────────────────────────────────────────────────────────────

function CoverSummary({
  counts, phase,
}: {
  counts: RotaSlotDetail['counts'];
  phase: RotaCoveragePhase;
}) {
  const { required, confirmed, offered, open, problem, onShift, completed } = counts;

  const primaryNum   = phase === 'live' ? onShift  :
                       phase === 'past' ? completed : confirmed;
  const primaryLabel = phase === 'live' ? 'on shift'  :
                       phase === 'past' ? 'completed' : 'covered'; // confirmed ≠ covered unless we name it right
  const primaryColor = phase === 'past' ? colors.pending : colors.success;

  // For live: guards confirmed/scheduled but not yet booked on
  const preShift = phase === 'live' ? Math.max(0, confirmed - onShift) : 0;

  return (
    <View style={db.coverSummary}>
      <Text style={[db.coverSummaryMain, { color: primaryColor }]}>
        {primaryNum} / {required}
        <Text style={db.coverSummaryLabel}> {primaryLabel}</Text>
      </Text>
      <View style={db.coverSummaryRow}>
        {phase === 'future' && open > 0 && (
          <Text style={[db.coverChip, db.coverChipOpen]}>{open} Open</Text>
        )}
        {phase === 'future' && offered > 0 && (
          <Text style={[db.coverChip, db.coverChipAwaiting]}>{offered} Awaiting</Text>
        )}
        {phase === 'live' && open > 0 && (
          <Text style={[db.coverChip, db.coverChipOpen]}>{open} Open</Text>
        )}
        {phase === 'live' && preShift > 0 && (
          <Text style={[db.coverChip, db.coverChipConfirmed]}>{preShift} confirmed</Text>
        )}
        {problem > 0 && (
          <Text style={[db.coverChip, db.coverChipProblem]}>{problem} Attention</Text>
        )}
      </View>
    </View>
  );
}

// ── Small shared atoms ────────────────────────────────────────────────────────

function SectionLabel({ label, spaced }: { label: string; spaced?: boolean }) {
  return (
    <Text style={[db.sectionLabel, spaced && db.sectionLabelSpaced]}>{label}</Text>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={db.detailRow}>
      <Text style={db.detailLabel}>{label}</Text>
      <Text style={db.detailValue}>{value}</Text>
    </View>
  );
}

function SummaryStat({
  value, label, highlight,
}: {
  value: number;
  label: string;
  highlight?: 'danger' | 'info' | 'warning' | 'success';
}) {
  const numColor =
    highlight === 'danger'  ? colors.danger  :
    highlight === 'warning' ? colors.warning :
    highlight === 'info'    ? colors.info    :
    highlight === 'success' ? colors.success :
    colors.textPrimary;

  return (
    <View style={summaryStyles.stat}>
      <Text style={[summaryStyles.value, { color: numColor }]}>{value}</Text>
      <Text style={summaryStyles.label}>{label}</Text>
    </View>
  );
}

// ── Summary stat styles ───────────────────────────────────────────────────────

const summaryStyles = StyleSheet.create({
  stat:  { flex: 1, alignItems: 'center', paddingVertical: spacing.sm },
  value: { fontSize: 22, fontWeight: '700', lineHeight: 28, color: colors.textPrimary },
  label: { ...typography.caption, color: colors.textSecondary, marginTop: 2 } as any,
});

// ── Drawer body styles ────────────────────────────────────────────────────────

const db = StyleSheet.create({
  scroll: { flex: 1 },
  body: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  centeredLoading: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    gap: spacing.sm, paddingVertical: spacing.xl,
  },
  loadingText: { ...typography.caption, color: colors.textSecondary } as any,

  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5,
  } as any,
  sectionLabelSpaced: { marginTop: spacing.md },
  sectionLabelPositions: { marginTop: spacing.md },

  submitError: {
    backgroundColor: colors.dangerSurface,
    borderRadius: radii.sm,
    borderWidth: 1, borderColor: colors.danger,
    padding: spacing.md,
    marginBottom: spacing.xs,
  },
  submitErrorText: { fontSize: 13, color: colors.danger, lineHeight: 18 },

  hintBox: {
    backgroundColor: colors.pendingSurface,
    borderRadius: radii.sm,
    padding: spacing.md,
    marginBottom: spacing.xs,
    gap: 2,
  },
  hintBoxInfo: { backgroundColor: colors.infoSurface },
  hintBoxWarn: { backgroundColor: colors.warningSurface },
  hintText: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  hintSubText: { fontSize: 12, color: colors.textMuted, lineHeight: 16 },

  timeRow: { flexDirection: 'row', gap: spacing.sm },
  timeCell: { flex: 1 },

  detailRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  detailLabel: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  detailValue: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },

  instructionsText: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },

  // Cover summary
  coverSummary: {
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radii.card,
    padding: spacing.md,
    marginBottom: spacing.xs,
    gap: spacing.xs,
  },
  coverSummaryMain: {
    fontSize: 20, fontWeight: '700', color: colors.success, lineHeight: 28,
  },
  coverSummaryLabel: {
    fontSize: 14, fontWeight: '500', color: colors.textSecondary,
  },
  coverSummaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  coverChip: {
    fontSize: 12, fontWeight: '600',
    paddingHorizontal: spacing.sm, paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.pendingSurface, color: colors.pending,
  },
  coverChipOpen:      { backgroundColor: colors.dangerSurface,   color: colors.danger   },
  coverChipAwaiting:  { backgroundColor: colors.infoSurface,     color: colors.info     },
  coverChipProblem:   { backgroundColor: colors.warningSurface,  color: colors.warning  },
  coverChipConfirmed: { backgroundColor: colors.successSurface,  color: colors.success  },

  // Positions section header
  positionsSectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  bulkAssignBtn: {
    paddingHorizontal: spacing.sm, paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.accentTealSoft,
  },
  bulkAssignBtnPressed: { opacity: 0.7 },
  bulkAssignBtnText: { fontSize: 12, fontWeight: '700', color: colors.accentTeal },

  // Position row
  positionBlock: { borderBottomWidth: 1, borderBottomColor: colors.border },
  positionRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 6,
  },
  positionName: { flex: 1, fontSize: 13, color: colors.textPrimary, fontWeight: '500' },
  positionStatus: { fontSize: 12, fontWeight: '700', marginLeft: spacing.sm, flexShrink: 0 },
  positionActions: { flexDirection: 'row', gap: spacing.xs, marginLeft: spacing.sm, flexShrink: 0 },
  actionBtn: { paddingHorizontal: spacing.xs, paddingVertical: 2 },
  actionBtnPressed: { opacity: 0.6 },
  actionBtnText: { fontSize: 12, fontWeight: '700' },
  noPositions: { ...typography.caption, color: colors.textMuted, fontStyle: 'italic' } as any,

  // Assign panel
  assignPanel: {
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radii.card,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  assignError: {
    backgroundColor: colors.dangerSurface,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  assignErrorText: { fontSize: 12, color: colors.danger },
  assignSpinner: { marginVertical: spacing.md },
  guardList: { maxHeight: 200 },
  guardItem: {
    paddingVertical: 6, paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1, borderColor: colors.border,
    marginBottom: 3,
    backgroundColor: colors.card,
  },
  guardItemSelected: {
    borderColor: colors.accentTeal, backgroundColor: colors.accentTealSoft,
  },
  guardItemPressed: { backgroundColor: colors.surfaceSubtle },
  guardItemDimmed: { opacity: 0.4 },
  guardItemMain: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  guardItemName: { flex: 1, fontSize: 13, color: colors.textPrimary, fontWeight: '500' },
  guardItemAvail: { fontSize: 11, color: colors.success, fontWeight: '600', marginLeft: spacing.xs },
  guardItemUnavail: { fontSize: 11, color: colors.warning, fontWeight: '600', marginLeft: spacing.xs },
  guardItemIneligible: { fontSize: 11, color: colors.danger, fontWeight: '600', marginLeft: spacing.xs },
  guardItemReason: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  assignFooter: { alignItems: 'flex-end' },
  noGuardsText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', paddingVertical: spacing.sm } as any,

  // Bulk assign panel
  bulkPanel: {
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radii.card,
    padding: spacing.md,
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  bulkPositionBlock: { gap: spacing.sm },
  bulkPositionDivider: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: spacing.md },
  bulkPositionLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  bulkGuardList: { maxHeight: 120 },
  bulkFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bulkCount: { fontSize: 12, color: colors.textSecondary },
});

// ── Site Week matrix ──────────────────────────────────────────────────────────

const SITE_COL_W = 210;
const DAY_COL_W  = 155;

/** Compact slot card rendered inside a matrix cell. */
function SlotMiniCard({
  cell, onPress,
}: {
  cell: RotaSlotCell;
  onPress: () => void;
}) {
  const tok = slotStateTokens(cell.coverageState);
  const timeStr = `${formatUtcTime(cell.startAt)}–${formatUtcTime(cell.endAt)}`;

  // Named positions: confirmed (ready / in_progress / completed)
  const confirmedPos = cell.positions.filter(
    (p) => ['ready', 'in_progress', 'completed'].includes(p.status) && p.guardName != null,
  );
  // Named positions: offered / awaiting
  const awaitingPos = cell.positions.filter(
    (p) => p.status === 'offered' && p.guardName != null,
  );

  const MAX_NAMES = 3;
  const shownConfirmed = confirmedPos.slice(0, MAX_NAMES);
  const moreConfirmed  = confirmedPos.length - shownConfirmed.length;

  // Show the single awaiting guard's name only when there is space below confirmed names
  const showSingleAwaitingName =
    awaitingPos.length === 1 && shownConfirmed.length < MAX_NAMES;
  const awaitingCountToShow = showSingleAwaitingName ? 0 : awaitingPos.length;

  const coverNum  = cell.coveragePhase === 'live' ? cell.counts.onShift
                  : cell.coveragePhase === 'past' ? cell.counts.completed
                  : cell.counts.confirmed;
  const isHealthy = coverNum === cell.counts.required
                 && cell.counts.open === 0
                 && cell.counts.offered === 0
                 && !tok.problem;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed, hovered }: any) => [
        mxStyles.slotCard,
        { borderLeftColor: tok.problem ? tok.fg : colors.accentTealSoft },
        cell.coveragePhase === 'past' && mxStyles.slotCardPast,
        (pressed || hovered) && mxStyles.slotCardHovered,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${timeStr} ${coverNum} of ${cell.counts.required}`}
    >
      {/* 1. TIME */}
      <Text style={mxStyles.slotCardTime}>{timeStr}</Text>
      {/* 2. TITLE (optional) */}
      {cell.title ? <Text style={mxStyles.slotCardTitle} numberOfLines={1}>{cell.title}</Text> : null}

      {cell.coveragePhase === 'past' ? (
        // Past: quiet state label — names are archived detail, keep it minimal
        <Text style={[mxStyles.slotCardState, { color: tok.fg || colors.textMuted }]}>
          {tok.label || 'Completed'}
        </Text>
      ) : (
        <>
          {/* 3. GUARD NAMES — confirmed first, up to MAX_NAMES */}
          {shownConfirmed.map((p) => (
            <Fragment key={p.shiftId}>
              <Text style={mxStyles.slotCardGuard}>{p.guardName}</Text>
            </Fragment>
          ))}
          {/* Overflow: "+ N Guards" */}
          {moreConfirmed > 0 && (
            <Text style={mxStyles.slotCardGuardMore}>
              + {moreConfirmed} Guard{moreConfirmed !== 1 ? 's' : ''}
            </Text>
          )}
          {/* Single awaiting guard with name */}
          {showSingleAwaitingName && awaitingPos[0].guardName != null && (
            <Text style={mxStyles.slotCardGuardAwaiting}>
              {awaitingPos[0].guardName} · Awaiting
            </Text>
          )}
          {/* 4. AWAITING count — multiple awaiting or no space for name */}
          {awaitingCountToShow > 0 && (
            <Text style={mxStyles.slotCardAwaiting}>{awaitingCountToShow} Awaiting</Text>
          )}
          {/* OPEN exception */}
          {cell.counts.open > 0 && (
            <Text style={mxStyles.slotCardOpen}>{cell.counts.open} Open</Text>
          )}
          {/* 5. HEALTH INDICATOR — calm ✓ when all positions filled */}
          {isHealthy && (
            <Text style={mxStyles.slotCardHealthy}>
              {cell.counts.required === 1 ? '✓' : `${coverNum}/${cell.counts.required} ✓`}
            </Text>
          )}
          {/* Live non-healthy: on-shift fraction */}
          {!isHealthy && cell.coveragePhase === 'live' && (
            <Text style={mxStyles.slotCardCover}>{coverNum}/{cell.counts.required} on shift</Text>
          )}
          {/* Attention when no open/awaiting already explains it */}
          {tok.label === 'Attention' && cell.counts.open === 0 && cell.counts.offered === 0 && (
            <Text style={mxStyles.slotCardAttention}>Attention</Text>
          )}
          {/* Cancelled */}
          {tok.label === 'Cancelled' && (
            <Text style={mxStyles.slotCardState}>Cancelled</Text>
          )}
        </>
      )}
    </Pressable>
  );
}

/** One cell of the Site Week matrix — empty or contains slot cards. */
function MatrixDayCell({
  slots, siteId, date, onOpenSlot, onOpenCreate, isLastCol,
}: {
  slots: RotaSlotCell[];
  siteId: number;
  date: string;
  onOpenSlot: (slotId: number) => void;
  onOpenCreate: (siteId: string, date: string) => void;
  isLastCol: boolean;
}) {
  const hasSlots = slots.length > 0;

  return (
    <View style={[mxStyles.cell, isLastCol && mxStyles.cellLast]}>
      {hasSlots ? (
        <>
          {slots.map((slot) => (
            <Fragment key={slot.slotId}>
              <SlotMiniCard
                cell={slot}
                onPress={() => onOpenSlot(slot.slotId)}
              />
            </Fragment>
          ))}
          <Pressable
            style={({ pressed, hovered }: any) => [mxStyles.cellAddMore, (pressed || hovered) && mxStyles.cellAddMoreHovered]}
            onPress={() => onOpenCreate(String(siteId), date)}
            accessibilityRole="button"
            accessibilityLabel="Add another shift"
          >
            <Text style={mxStyles.cellAddMoreText}>+</Text>
          </Pressable>
        </>
      ) : (
        <Pressable
          style={({ pressed, hovered }: any) => [mxStyles.cellEmptyBtn, (pressed || hovered) && mxStyles.cellEmptyBtnHovered]}
          onPress={() => onOpenCreate(String(siteId), date)}
          accessibilityRole="button"
          accessibilityLabel="Add shift"
        >
          {({ hovered, pressed }: any) => (
            hovered || pressed
              ? <Text style={mxStyles.cellEmptyAdd}>+ Add Shift</Text>
              : <Text style={mxStyles.cellEmptyDash}>—</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

/** The full Site × Week planning matrix. */
function SiteWeekMatrix({
  sites, plannerWeekDays, legacyCount, onSwitchToDayList, onOpenSlot, onOpenCreate,
}: {
  sites: RotaSiteWeekRow[];
  plannerWeekDays: PlannerWeekDay[];
  legacyCount: number;
  onSwitchToDayList: () => void;
  onOpenSlot: (slotId: number) => void;
  onOpenCreate: (siteId: string, date: string) => void;
}) {
  if (sites.length === 0) {
    return (
      <View style={mxStyles.emptyMatrix}>
        <Text style={mxStyles.emptyMatrixText}>No active sites found for this filter.</Text>
      </View>
    );
  }

  return (
    <View style={mxStyles.matrixOuter}>
      {legacyCount > 0 && (
        <Pressable onPress={onSwitchToDayList} style={mxStyles.legacyNotice} accessibilityRole="button">
          <Text style={mxStyles.legacyNoticeText}>
            {'ⓘ '}{legacyCount} legacy shift{legacyCount !== 1 ? 's' : ''}{' · '}
            <Text style={mxStyles.legacyNoticeLink}>View in Day List</Text>
          </Text>
        </Pressable>
      )}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={IS_WEB}
        contentContainerStyle={{ minWidth: SITE_COL_W + DAY_COL_W * 7 }}
        style={mxStyles.matrixScrollH}
      >
        <View style={mxStyles.matrixGrid}>
          {/* ── Column headers ──────────────────────────────────────────── */}
          <View style={mxStyles.headerRow}>
            <View style={[mxStyles.headerSiteCol, IS_WEB && (mxStyles.stickyLeft as any)]}>
              <Text style={mxStyles.headerSiteText}>Site</Text>
            </View>
            {plannerWeekDays.map((day, idx) => (
              <View key={day.date} style={[mxStyles.headerDayCol, idx === 6 && mxStyles.headerDayColLast]}>
                <Text style={mxStyles.headerDayName}>{day.label.slice(0, 3).toUpperCase()}</Text>
                <Text style={mxStyles.headerDayDate}>{day.shortLabel}</Text>
              </View>
            ))}
          </View>

          {/* ── Site rows ───────────────────────────────────────────────── */}
          {sites.map((site, siteIdx) => (
            <View key={site.siteId} style={[mxStyles.dataRow, siteIdx < sites.length - 1 && mxStyles.dataRowDivider]}>
              {/* Site name cell */}
              <View style={[mxStyles.siteCell, IS_WEB && (mxStyles.stickySiteCell as any)]}>
                <Text style={mxStyles.siteName} numberOfLines={2}>{site.siteName}</Text>
                {site.clientName ? (
                  <Text style={mxStyles.siteClient} numberOfLines={1}>{site.clientName}</Text>
                ) : null}
              </View>

              {/* Day cells */}
              {plannerWeekDays.map((day, dayIdx) => {
                const dayName = DAY_NAMES[dayIdx];
                const dayCells = (site.days as any)[dayName] as RotaDayCells | undefined;
                const slots = dayCells?.slots ?? [];
                return (
                  <Fragment key={day.date}>
                    <MatrixDayCell
                      slots={slots}
                      siteId={site.siteId}
                      date={day.date}
                      onOpenSlot={onOpenSlot}
                      onOpenCreate={onOpenCreate}
                      isLastCol={dayIdx === 6}
                    />
                  </Fragment>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const mxStyles = StyleSheet.create({
  // Outer container
  matrixOuter: { gap: spacing.sm },
  emptyMatrix: { paddingVertical: spacing.xl, alignItems: 'center' },
  emptyMatrixText: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic' } as any,

  // Compact legacy notice (inline, clickable)
  legacyNotice: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  legacyNoticeText: { fontSize: 12, color: colors.textMuted },
  legacyNoticeLink: { fontSize: 12, color: colors.accentTeal, textDecorationLine: 'underline' } as any,

  // Matrix scroll
  matrixScrollH: {},
  matrixGrid: {
    backgroundColor: colors.card,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  } as any,

  // Column header row
  headerRow: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSubtle,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerSiteCol: {
    width: SITE_COL_W,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    justifyContent: 'center',
    backgroundColor: colors.surfaceSubtle,
  },
  // Web-only sticky: applied via spread with IS_WEB check
  stickyLeft: {
    position: 'sticky',
    left: 0,
    zIndex: 3,
  } as any,
  stickySiteCell: {
    position: 'sticky',
    left: 0,
    zIndex: 2,
    backgroundColor: colors.card,
  } as any,
  headerSiteText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  } as any,
  headerDayCol: {
    width: DAY_COL_W,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    alignItems: 'center',
  },
  headerDayColLast: { borderRightWidth: 0 },
  headerDayName: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    letterSpacing: 0.4,
  } as any,
  headerDayDate: { fontSize: 11, color: colors.textMuted },

  // Data rows
  dataRow: { flexDirection: 'row' },
  dataRowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },

  // Site name cell
  siteCell: {
    width: SITE_COL_W,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  siteName: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, lineHeight: 18 },
  siteClient: { fontSize: 11, color: colors.textMuted, marginTop: 1 },

  // Day cell
  cell: {
    width: DAY_COL_W,
    minHeight: 64,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    padding: spacing.xs,
    gap: 4,
  },
  cellLast: { borderRightWidth: 0 },

  // Empty cell
  cellEmptyBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    gap: 2,
    borderRadius: radii.sm,
  },
  cellEmptyBtnHovered: { backgroundColor: colors.surfaceSubtle },
  cellEmptyDash: { fontSize: 14, color: colors.border },
  cellEmptyAdd: { fontSize: 10, color: colors.textSecondary, letterSpacing: 0.2 } as any,

  // Add-more (when cell already has slots) — small right-aligned "+" corner control
  cellAddMore: {
    alignSelf: 'flex-end',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
    marginTop: 2,
  },
  cellAddMoreHovered: { backgroundColor: colors.surfaceSubtle },
  cellAddMoreText: { fontSize: 13, fontWeight: '600', color: colors.textMuted, lineHeight: 18 },

  // Slot mini card
  slotCard: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    paddingHorizontal: spacing.xs,
    paddingVertical: 4,
    gap: 1,
    backgroundColor: colors.card,
  },
  slotCardHovered: { backgroundColor: colors.surfaceSubtle },
  // Past slots appear quieter than future/live planning work
  slotCardPast: { opacity: 0.75 },
  slotCardTime: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  } as any,
  slotCardTitle: { fontSize: 10, color: colors.textMuted, fontStyle: 'italic' } as any,

  // Guard name rows
  slotCardGuard:         { fontSize: 11, color: colors.textPrimary, lineHeight: 16 },
  // "+ N Guards" overflow line
  slotCardGuardMore:     { fontSize: 10, color: colors.textSecondary, fontStyle: 'italic' } as any,
  // Single awaiting guard: "Name · Awaiting" — visually distinct from confirmed
  slotCardGuardAwaiting: { fontSize: 11, color: colors.info, fontStyle: 'italic' } as any,

  slotCardHealthy: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.success,
    fontVariant: ['tabular-nums'],
  } as any,
  slotCardCover: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  } as any,
  slotCardOpen:      { fontSize: 11, fontWeight: '600', color: colors.danger },
  slotCardAwaiting:  { fontSize: 11, fontWeight: '600', color: colors.info },
  slotCardAttention: { fontSize: 11, fontWeight: '600', color: colors.warning },
  slotCardState:     { fontSize: 11, color: colors.textMuted },
});

// ── Main workspace styles ─────────────────────────────────────────────────────

const styles = StyleSheet.create({
  workspace: { gap: spacing.md },

  toolbar: {
    flexDirection: 'row', flexWrap: 'wrap',
    alignItems: 'center', gap: spacing.md,
  },
  filterGroup: { flexDirection: 'row', gap: spacing.sm, flexShrink: 1 },
  filterCell: { minWidth: 148, maxWidth: 220, flex: 1 },

  // View switcher (segmented control)
  viewSwitcher: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSubtle,
    borderRadius: radii.pill,
    padding: 2,
    borderWidth: 1,
    borderColor: colors.border,
    flexShrink: 0,
  },
  viewSwitcherBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radii.pill,
  },
  viewSwitcherBtnActive: {
    backgroundColor: colors.card,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
  },
  viewSwitcherBtnPressed: { opacity: 0.75 },
  viewSwitcherText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  viewSwitcherTextActive: { color: colors.textPrimary, fontWeight: '600' } as any,
  weekNav: {
    flexDirection: 'row', alignItems: 'center',
    gap: spacing.sm, flex: 1, justifyContent: 'center', minWidth: 280,
  },
  navBtn: {
    width: 32, height: 32,
    borderRadius: radii.sm, borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.card, flexShrink: 0,
  },
  navBtnPressed: { backgroundColor: colors.surfaceSubtle },
  navBtnText: { fontSize: 22, lineHeight: 26, color: colors.textPrimary, fontWeight: '600' },
  weekLabel: { ...typography.label, color: colors.textPrimary, flex: 1, textAlign: 'center' } as any,

  summaryStrip: {
    flexDirection: 'row', backgroundColor: colors.card,
    borderRadius: radii.card, borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  } as any,
  summaryDivider: { width: 1, backgroundColor: colors.border, marginVertical: spacing.sm },

  centeredFeedback: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: spacing.xl, gap: spacing.sm,
  },
  feedbackText: { ...typography.caption, color: colors.textSecondary } as any,
  errorBox: {
    backgroundColor: colors.dangerSurface, borderRadius: radii.card,
    borderWidth: 1, borderColor: colors.danger,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    gap: spacing.sm, alignItems: 'flex-start',
  },
  errorText: { fontSize: 14, color: colors.danger, lineHeight: 20 },

  daySections: { gap: spacing.sm },
  daySection: {
    backgroundColor: colors.card, borderRadius: radii.card,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  } as any,
  dayHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSubtle,
  },
  dayHeaderTitle: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, flex: 1 },
  dayName: { ...typography.panelHeading, color: colors.textPrimary } as any,
  dayShortLabel: { ...typography.caption, color: colors.textSecondary } as any,
  dayHeaderMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexShrink: 0 },
  daySlotCount: { ...typography.caption, color: colors.textMuted } as any,
  openChip: {
    backgroundColor: colors.dangerSurface, borderRadius: radii.pill,
    paddingHorizontal: spacing.sm, paddingVertical: 2,
  },
  openChipText: { fontSize: 11, fontWeight: '700', color: colors.danger },
  addDayBtn: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.accentTealSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  addDayBtnPressed: { opacity: 0.7 },
  addDayBtnText: { fontSize: 14, fontWeight: '700', color: colors.accentTeal, lineHeight: 20 },
  emptyDayRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  emptyDayText: { ...typography.caption, color: colors.textMuted, fontStyle: 'italic' } as any,

  slotRow: { flexDirection: 'row', alignItems: 'stretch', minHeight: 48 },
  slotRowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  slotRowHovered: { backgroundColor: colors.surfaceSubtle },
  legacyRow: { backgroundColor: colors.surfaceSubtle, opacity: 0.85 },
  accentBar: { width: 3, alignSelf: 'stretch', flexShrink: 0 },
  rowContent: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.md, gap: spacing.sm, minHeight: 48,
  },
  colTimeWrap: { width: 114, flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  colTime: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, fontVariant: ['tabular-nums'] } as any,
  nightDot: { fontSize: 7, color: colors.info, lineHeight: 14 },
  colSite: { flex: 2, fontSize: 13, color: colors.textPrimary, minWidth: 0 },
  colCoverWrap: { width: 110, flexShrink: 0, alignItems: 'flex-end', gap: 1 },
  colCover: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, fontVariant: ['tabular-nums'] } as any,
  colCoverOpen: { fontSize: 11, fontWeight: '600', color: colors.danger },
  colCoverAwaiting: { fontSize: 11, fontWeight: '600', color: colors.info },
  colGuardLegacy: { flex: 2, fontSize: 13, color: colors.textSecondary, minWidth: 0, fontStyle: 'italic' } as any,
  legacyPill: {
    backgroundColor: colors.pendingSurface, borderRadius: radii.pill,
    paddingHorizontal: spacing.sm, paddingVertical: 2, flexShrink: 0,
  },
  legacyPillText: {
    fontSize: 10, fontWeight: '700', color: colors.pending,
    textTransform: 'uppercase', letterSpacing: 0.3,
  } as any,
  stateBadge: {
    width: 108, flexShrink: 0, borderRadius: radii.pill,
    paddingVertical: 3, alignItems: 'center', paddingHorizontal: spacing.xs,
  },
  stateBadgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.2 } as any,
  chevron: {
    width: 20, flexShrink: 0, textAlign: 'center',
    fontSize: 16, color: colors.neutralSlate, fontWeight: '600',
  } as any,

  drawerFooterRow: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.sm },
  drawerFooterSpacer: { flex: 1 },
});
