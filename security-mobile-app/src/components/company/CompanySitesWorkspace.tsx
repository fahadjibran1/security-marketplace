import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Client, Site } from '../../types/models';
import { colors, radii, spacing, typography } from '../../theme';
import { Drawer } from '../ui/Drawer';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { FormField, FieldInput, FieldTextarea } from '../ui/FormField';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import {
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableCell,
  ActionCell,
} from '../ui/TableFoundation';

const IS_WEB = typeof document !== 'undefined';

// ─── Exported types ───────────────────────────────────────────────────────────

export type SiteFormState = {
  id?: number;
  clientId: string;
  name: string;
  address: string;
  contactDetails: string;
  status: string;
  requiredGuardCount: string;
  operatingDays: string;
  operatingStartTime: string;
  operatingEndTime: string;
  checkCallIntervalMinutes: string;
  specialInstructions: string;
  latitude: string;
  longitude: string;
  geofenceRadiusMeters: string;
  requireGpsCheckIn: boolean;
  timezone: string;
  initialShiftDate: string;
  initialShiftStartTime: string;
  initialShiftEndTime: string;
};

export const SITE_FORM_EMPTY: SiteFormState = {
  clientId: '',
  name: '',
  address: '',
  contactDetails: '',
  status: 'active',
  requiredGuardCount: '1',
  operatingDays: 'Mon-Fri',
  operatingStartTime: '08:00',
  operatingEndTime: '18:00',
  checkCallIntervalMinutes: '60',
  specialInstructions: '',
  latitude: '',
  longitude: '',
  geofenceRadiusMeters: '150',
  requireGpsCheckIn: false,
  timezone: 'Europe/London',
  initialShiftDate: '',
  initialShiftStartTime: '',
  initialShiftEndTime: '',
};

// ─── Internal types ───────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'active' | 'inactive' | 'archived';

type Props = {
  sites: Site[];
  clients: Client[];
  siteForm: SiteFormState;
  setSiteForm: React.Dispatch<React.SetStateAction<SiteFormState>>;
  savingSite: boolean;
  onSaveSite: () => Promise<void>;
  onArchiveSite: (site: Site) => Promise<void>;
  onPlanCover: (site: Site) => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtStatus(value?: string | null): string {
  if (!value) return 'Active';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function getSiteStatusBadge(status?: string | null): { label: string; color: string; bg: string } {
  switch ((status || 'active').toLowerCase()) {
    case 'active':   return { label: 'Active',   color: colors.success,    bg: colors.successSurface };
    case 'inactive': return { label: 'Inactive', color: colors.warning,    bg: colors.warningSurface };
    case 'archived': return { label: 'Archived', color: colors.textMuted,  bg: colors.pendingSurface };
    default:         return { label: fmtStatus(status), color: colors.textSecondary, bg: colors.surfaceSubtle };
  }
}

function fmtHours(start?: string | null, end?: string | null): string {
  if (!start && !end) return '—';
  return `${start || '?'}–${end || '?'}`;
}

function fmtCoord(value: number | null | undefined): string {
  if (value == null) return '';
  return value.toFixed(5);
}

function fmtCheckCall(minutes?: number | null): string {
  const m = minutes ?? 60;
  return `Every ${m} minute${m === 1 ? '' : 's'}`;
}

function toNumber(value?: string | number | null): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function isValidDateInput(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isValidTimeInput(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function validateSameDayShiftTiming(date: string, startTime: string, endTime: string): string | null {
  if (!date || !startTime || !endTime) return 'Date, start time, and end time are required.';
  if (!isValidDateInput(date)) return 'Use a valid date.';
  if (!isValidTimeInput(startTime) || !isValidTimeInput(endTime)) return 'Use valid 24-hour times.';
  return null;
}

function validateGpsForm(form: SiteFormState): string | null {
  const latStr = form.latitude.trim();
  const lonStr = form.longitude.trim();
  const radiusStr = form.geofenceRadiusMeters.trim();

  if (latStr !== '') {
    const lat = Number(latStr);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return 'Latitude must be a number between −90 and 90.';
    }
  }
  if (lonStr !== '') {
    const lon = Number(lonStr);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      return 'Longitude must be a number between −180 and 180.';
    }
  }
  if (radiusStr !== '') {
    const radius = Number(radiusStr);
    if (!Number.isFinite(radius) || !Number.isInteger(radius) || radius < 25 || radius > 5000) {
      return 'Geofence radius must be a whole number between 25 and 5000 metres.';
    }
  }
  if (form.requireGpsCheckIn && (latStr === '' || lonStr === '')) {
    return 'Set the site latitude and longitude before requiring GPS verification.';
  }
  return null;
}

// ─── SiteStatusBadge ──────────────────────────────────────────────────────────

function SiteStatusBadge({ status }: { status?: string | null }) {
  const b = getSiteStatusBadge(status);
  return (
    <View style={[styles.badge, { backgroundColor: b.bg, borderColor: b.color }]}>
      <Text style={[styles.badgeText, { color: b.color }]}>{b.label}</Text>
    </View>
  );
}

// ─── FormSelect ───────────────────────────────────────────────────────────────

function FormSelect({
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
        style={formSelectStyle}
        aria-label={placeholder || 'Select an option'}
      >
        {placeholder ? <OptionTag value="">{placeholder}</OptionTag> : null}
        {options.map((opt) => (
          <OptionTag key={opt.value} value={opt.value}>{opt.label}</OptionTag>
        ))}
      </SelectTag>
    );
  }

  return (
    <View style={styles.nativeSelectFallback}>
      <Text style={styles.nativeSelectText}>
        {options.find((o) => o.value === value)?.label || placeholder || 'Select…'}
      </Text>
    </View>
  );
}

// ─── ToggleRow ────────────────────────────────────────────────────────────────

function ToggleRow({
  value,
  onChange,
  label,
  helper,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
  helper?: string;
}) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      style={[styles.toggleRow, IS_WEB ? ({ cursor: 'pointer' } as any) : null]}
    >
      <View style={[styles.toggleBox, value && styles.toggleBoxActive]}>
        {value ? <Text accessible={false} style={styles.toggleCheck}>✓</Text> : null}
      </View>
      <View style={styles.toggleContent}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {helper ? <Text style={styles.toggleHelper}>{helper}</Text> : null}
      </View>
    </Pressable>
  );
}

// ─── ControlledDateInput ──────────────────────────────────────────────────────

function ControlledDateInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  if (!IS_WEB) {
    return (
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="YYYY-MM-DD"
        style={formSelectStyle as any}
        placeholderTextColor={colors.fieldPlaceholder}
      />
    );
  }
  const InputTag: any = 'input';
  return (
    <InputTag
      type="date"
      value={value}
      onChange={(e: any) => onChange(e.target.value)}
      style={{ ...formSelectStyle, paddingRight: spacing.xxl }}
    />
  );
}

// ─── ControlledTimeInput ──────────────────────────────────────────────────────

function ControlledTimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  if (!IS_WEB) {
    return (
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="HH:MM"
        style={formSelectStyle as any}
        placeholderTextColor={colors.fieldPlaceholder}
      />
    );
  }
  const InputTag: any = 'input';
  return (
    <InputTag
      type="time"
      value={value}
      onChange={(e: any) => onChange(e.target.value)}
      style={{ ...formSelectStyle, paddingRight: spacing.xxl }}
    />
  );
}

// ─── Column constants ─────────────────────────────────────────────────────────

const COL_STATUS_W  = 100;
const COL_GUARDS_W  = 84;
const COL_VERIF_W   = 120;
const COL_HOURS_W   = 108;
const COL_ACTION_W  = 52;

const TABLE_BODY_MAX_HEIGHT: any = IS_WEB ? 'calc(100vh - 322px)' : 468;

// ─── Main component ───────────────────────────────────────────────────────────

export function CompanySitesWorkspace({
  sites,
  clients,
  siteForm,
  setSiteForm,
  savingSite,
  onSaveSite,
  onArchiveSite,
  onPlanCover,
}: Props) {
  const [searchQuery,        setSearchQuery]        = React.useState('');
  const [statusFilter,       setStatusFilter]       = React.useState<StatusFilter>('all');
  const [quickViewSite,      setQuickViewSite]      = React.useState<Site | null>(null);
  const [formDrawerOpen,     setFormDrawerOpen]     = React.useState(false);
  const [formError,          setFormError]          = React.useState<string | null>(null);
  const [archivingSite,      setArchivingSite]      = React.useState<Site | null>(null);
  const [archivingProgress,  setArchivingProgress]  = React.useState(false);
  const [showStarterShift,   setShowStarterShift]   = React.useState(false);

  // ─── Derived ─────────────────────────────────────────────────────────────

  const activeClientOptions = React.useMemo(
    () =>
      clients
        .filter((c) => (c.status || 'active').toLowerCase() !== 'archived')
        .map((c) => ({ label: c.name, value: String(c.id) })),
    [clients],
  );

  const stats = React.useMemo(() => {
    const active = sites.filter((s) => (s.status || 'active').toLowerCase() === 'active').length;
    const clientIds = new Set(
      sites
        .map((s) => s.client?.id ?? s.clientId)
        .filter((id): id is number => id != null),
    );
    return { total: sites.length, active, clients: clientIds.size };
  }, [sites]);

  const filteredSites = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sites.filter((site) => {
      const status = (site.status || 'active').toLowerCase();
      if (statusFilter === 'all' && status === 'archived') return false;
      if (statusFilter !== 'all' && status !== statusFilter) return false;
      if (!q) return true;
      const clientName = (site.client?.name || site.clientName || '').toLowerCase();
      return (
        site.name.toLowerCase().includes(q) ||
        (site.address || '').toLowerCase().includes(q) ||
        clientName.includes(q)
      );
    });
  }, [sites, searchQuery, statusFilter]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleOpenAdd = () => {
    setSiteForm(SITE_FORM_EMPTY);
    setFormError(null);
    setShowStarterShift(false);
    setFormDrawerOpen(true);
  };

  const handleOpenEdit = (site: Site) => {
    setSiteForm({
      id: site.id,
      clientId: String(site.client?.id ?? site.clientId ?? ''),
      name: site.name,
      address: site.address,
      contactDetails: site.contactDetails || '',
      status: site.status || 'active',
      requiredGuardCount: String(site.requiredGuardCount || 1),
      operatingDays: site.operatingDays || '',
      operatingStartTime: site.operatingStartTime || '',
      operatingEndTime: site.operatingEndTime || '',
      checkCallIntervalMinutes: String(site.welfareCheckIntervalMinutes || 60),
      specialInstructions: site.specialInstructions || '',
      latitude: site.latitude != null ? String(site.latitude) : '',
      longitude: site.longitude != null ? String(site.longitude) : '',
      geofenceRadiusMeters: String(site.geofenceRadiusMeters ?? 150),
      requireGpsCheckIn: site.requireGpsCheckIn ?? false,
      timezone: site.timezone || 'Europe/London',
      initialShiftDate: '',
      initialShiftStartTime: '',
      initialShiftEndTime: '',
    });
    setFormError(null);
    setQuickViewSite(null);
    setFormDrawerOpen(true);
  };

  const handleCloseForm = () => {
    if (savingSite) return;
    setFormDrawerOpen(false);
    setFormError(null);
  };

  const handleSave = async () => {
    const gpsError = validateGpsForm(siteForm);
    if (gpsError) { setFormError(gpsError); return; }
    setFormError(null);
    try {
      await onSaveSite();
      setFormDrawerOpen(false);
    } catch (err: any) {
      setFormError(err?.message || 'Unable to save this site right now.');
    }
  };

  const handleArchiveRequest = (site: Site) => setArchivingSite(site);

  const handleConfirmArchive = async () => {
    if (!archivingSite) return;
    setArchivingProgress(true);
    try {
      await onArchiveSite(archivingSite);
      if (quickViewSite?.id === archivingSite.id) setQuickViewSite(null);
      setArchivingSite(null);
    } catch {
      // parent surfaces the error via global banner
    } finally {
      setArchivingProgress(false);
    }
  };

  // ─── QV helpers ───────────────────────────────────────────────────────────

  const qv = quickViewSite;
  const canArchiveQV = qv && (qv.status || 'active').toLowerCase() !== 'archived';
  const qvHasCoords  = qv != null && (qv.latitude != null || qv.longitude != null);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <View style={styles.root}>

      {/* ── Action strip ──────────────────────────────────────────────────── */}
      <View style={styles.actionStrip}>
        <Text style={styles.statsText}>
          <Text style={styles.statsNum}>{stats.total}</Text>
          {stats.total === 1 ? ' site' : ' sites'}
          <Text style={styles.statsDot}> · </Text>
          <Text style={[styles.statsNum, { color: colors.success }]}>{stats.active}</Text>
          <Text style={{ color: colors.success }}> active</Text>
          <Text style={styles.statsDot}> · </Text>
          <Text style={styles.statsNum}>{stats.clients}</Text>
          {stats.clients === 1 ? ' client' : ' clients'}
        </Text>
        <Button label="+ Add Site" onPress={handleOpenAdd} variant="primary" size="sm" />
      </View>

      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <View style={styles.toolbar}>
        <View style={styles.searchBox}>
          <Text accessible={false} style={styles.searchIcon}>⌕</Text>
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search sites, address, client…"
            placeholderTextColor={colors.fieldPlaceholder}
            accessibilityLabel="Search sites"
          />
          {searchQuery.length > 0 ? (
            <IconButton
              icon="✕"
              accessibilityLabel="Clear search"
              onPress={() => setSearchQuery('')}
              variant="ghost"
              size="sm"
            />
          ) : null}
        </View>
        <View style={styles.filterChips}>
          {(['all', 'active', 'inactive', 'archived'] as StatusFilter[]).map((f) => (
            <Pressable
              key={f}
              onPress={() => setStatusFilter(f)}
              style={[styles.filterChip, statusFilter === f && styles.filterChipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: statusFilter === f }}
            >
              <Text style={[styles.filterChipText, statusFilter === f && styles.filterChipTextActive]}>
                {f === 'all' ? 'All active' : fmtStatus(f)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* ── Table ─────────────────────────────────────────────────────────── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={IS_WEB}
        contentContainerStyle={styles.tableHScrollContent}
      >
        <View style={styles.tableContainer}>
          <TableHeader>
            <TableHeaderCell label="Site / Address" flex={2}   style={styles.colSite} />
            <TableHeaderCell label="Client"         flex={1.5} style={styles.colClient} />
            <TableHeaderCell label="Status"      width={COL_STATUS_W} />
            <TableHeaderCell label="Guards"      width={COL_GUARDS_W} align="center" />
            <TableHeaderCell label="Verification" width={COL_VERIF_W} />
            <TableHeaderCell label="Hours"       width={COL_HOURS_W} />
            <TableHeaderCell label=""            width={COL_ACTION_W} />
          </TableHeader>

          <ScrollView
            style={{ maxHeight: TABLE_BODY_MAX_HEIGHT }}
            showsVerticalScrollIndicator={IS_WEB}
            nestedScrollEnabled
          >
            {filteredSites.length === 0 && sites.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No sites yet</Text>
                <Text style={styles.emptyCaption}>
                  Add your first Site to start planning operational coverage.
                </Text>
                <Button label="+ Add Site" onPress={handleOpenAdd} variant="primary" size="sm" />
              </View>
            ) : filteredSites.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No sites match these filters.</Text>
                <Button
                  label="Clear filters"
                  onPress={() => { setSearchQuery(''); setStatusFilter('all'); }}
                  variant="secondary"
                  size="sm"
                />
              </View>
            ) : (
              filteredSites.map((site) => {
                const clientName = site.client?.name || site.clientName || '—';
                return (
                  <Fragment key={site.id}>
                    <TableRow
                      onPress={() => setQuickViewSite(site)}
                      selected={quickViewSite?.id === site.id}
                      style={quickViewSite?.id === site.id ? styles.rowAccent : undefined}
                    >
                      <TableCell flex={2} style={styles.colSite}>
                        <Text style={styles.siteName} numberOfLines={1}>{site.name}</Text>
                        <Text style={styles.siteAddress} numberOfLines={1}>{site.address}</Text>
                      </TableCell>

                      <TableCell flex={1.5} style={styles.colClient}>
                        <Text style={styles.clientName} numberOfLines={1}>{clientName}</Text>
                      </TableCell>

                      <TableCell width={COL_STATUS_W}>
                        <SiteStatusBadge status={site.status} />
                      </TableCell>

                      <TableCell width={COL_GUARDS_W} align="center">
                        <Text style={styles.guardsCount}>{site.requiredGuardCount ?? 1}</Text>
                      </TableCell>

                      <TableCell width={COL_VERIF_W}>
                        <Text
                          style={[styles.verifLabel, site.requireGpsCheckIn ? styles.verifGps : null]}
                          numberOfLines={1}
                        >
                          {site.requireGpsCheckIn ? 'GPS required' : 'Standard'}
                        </Text>
                      </TableCell>

                      <TableCell width={COL_HOURS_W}>
                        <Text style={styles.hoursText} numberOfLines={1}>
                          {fmtHours(site.operatingStartTime, site.operatingEndTime)}
                        </Text>
                      </TableCell>

                      <ActionCell width={COL_ACTION_W}>
                        <IconButton
                          icon="✎"
                          accessibilityLabel={`Edit ${site.name}`}
                          onPress={() => handleOpenEdit(site)}
                          variant="ghost"
                          size="sm"
                        />
                      </ActionCell>
                    </TableRow>
                  </Fragment>
                );
              })
            )}
          </ScrollView>
        </View>
      </ScrollView>

      {/* ── Quick View Drawer ─────────────────────────────────────────────── */}
      <Drawer
        visible={qv !== null}
        onClose={() => setQuickViewSite(null)}
        title={qv?.name ?? ''}
        subtitle={qv?.client?.name ?? qv?.clientName ?? 'Site overview'}
        compact
        width={500}
        footer={
          qv ? (
            <View style={styles.qvFooter}>
              <View style={styles.qvFooterLeft}>
                <Button label="Edit Site" onPress={() => handleOpenEdit(qv)} variant="primary" size="sm" />
                <Button label="Close" onPress={() => setQuickViewSite(null)} variant="secondary" size="sm" />
              </View>
              <View style={styles.qvFooterRight}>
                <Button
                  label="Plan Cover"
                  onPress={() => { setQuickViewSite(null); onPlanCover(qv); }}
                  variant="secondary"
                  size="sm"
                />
                {canArchiveQV ? (
                  <Button
                    label="Archive"
                    onPress={() => handleArchiveRequest(qv)}
                    variant="danger"
                    size="sm"
                  />
                ) : null}
              </View>
            </View>
          ) : undefined
        }
      >
        {qv ? (
          <View style={styles.qvBody}>
            {/* IDENTITY */}
            <View style={styles.qvSection}>
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Status</Text>
                <SiteStatusBadge status={qv.status} />
              </View>
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Address</Text>
                <Text style={styles.qvValue}>{qv.address}</Text>
              </View>
            </View>

            <View style={styles.qvSeparator} />

            {/* LOCATION & ATTENDANCE */}
            <View style={styles.qvSection}>
              <Text style={styles.qvSectionTitle}>Location & Attendance</Text>

              {qvHasCoords ? (
                <>
                  <View style={styles.qvRow}>
                    <Text style={styles.qvLabel}>Coordinates</Text>
                    <Text style={styles.qvValue}>
                      {fmtCoord(qv.latitude)}, {fmtCoord(qv.longitude)}
                    </Text>
                  </View>
                  <View style={styles.qvRow}>
                    <Text style={styles.qvLabel}>Geofence</Text>
                    <Text style={styles.qvValue}>{qv.geofenceRadiusMeters ?? 150} m radius</Text>
                  </View>
                  <View style={styles.qvRow}>
                    <Text style={styles.qvLabel}>GPS Book On</Text>
                    <Text style={[styles.qvValue, qv.requireGpsCheckIn ? styles.qvValueGps : null]}>
                      {qv.requireGpsCheckIn ? 'Required' : 'Standard'}
                    </Text>
                  </View>
                </>
              ) : (
                <View style={styles.qvRow}>
                  <Text style={styles.qvLabel}>Location</Text>
                  <Text style={[styles.qvValue, styles.qvValueMuted]}>Not configured</Text>
                </View>
              )}

              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Timezone</Text>
                <Text style={styles.qvValue}>{qv.timezone || 'Europe/London'}</Text>
              </View>
            </View>

            <View style={styles.qvSeparator} />

            {/* OPERATIONS */}
            <View style={styles.qvSection}>
              <Text style={styles.qvSectionTitle}>Operations</Text>
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Guards</Text>
                <Text style={styles.qvValue}>{qv.requiredGuardCount ?? 1} required</Text>
              </View>
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Days</Text>
                <Text style={styles.qvValue}>{qv.operatingDays || '—'}</Text>
              </View>
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Hours</Text>
                <Text style={styles.qvValue}>
                  {fmtHours(qv.operatingStartTime, qv.operatingEndTime)}
                </Text>
              </View>
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Check calls</Text>
                <Text style={styles.qvValue}>{fmtCheckCall(qv.welfareCheckIntervalMinutes)}</Text>
              </View>
            </View>

            {qv.contactDetails ? (
              <>
                <View style={styles.qvSeparator} />
                <View style={styles.qvSection}>
                  <Text style={styles.qvSectionTitle}>Contact Details</Text>
                  <Text style={[styles.qvValue, styles.qvValueFreeText]}>{qv.contactDetails}</Text>
                </View>
              </>
            ) : null}

            {qv.specialInstructions ? (
              <>
                <View style={styles.qvSeparator} />
                <View style={styles.qvSection}>
                  <Text style={styles.qvSectionTitle}>Instructions</Text>
                  <Text style={[styles.qvValue, styles.qvValueFreeText]}>{qv.specialInstructions}</Text>
                </View>
              </>
            ) : null}
          </View>
        ) : null}
      </Drawer>

      {/* ── Form Drawer ───────────────────────────────────────────────────── */}
      <Drawer
        visible={formDrawerOpen}
        onClose={handleCloseForm}
        title={siteForm.id ? 'Edit Site' : 'Add Site'}
        subtitle={siteForm.id ? 'Update site configuration' : 'Create a new operational site'}
        compact
        width={500}
        footer={
          <View style={styles.formFooter}>
            <Button
              label={siteForm.id ? 'Save Changes' : 'Create Site'}
              onPress={handleSave}
              variant="primary"
              size="md"
              loading={savingSite}
            />
            <Button
              label="Cancel"
              onPress={handleCloseForm}
              variant="secondary"
              size="md"
              disabled={savingSite}
            />
          </View>
        }
      >
        <View style={styles.formBody}>
          {formError ? (
            <View style={styles.formErrorBanner}>
              <Text style={styles.formErrorText}>{formError}</Text>
            </View>
          ) : null}

          {/* SITE DETAILS */}
          <View style={styles.formSection}>
            <Text style={styles.formSectionLabel}>Site Details</Text>

            <FormField label="Client" required>
              <FormSelect
                value={siteForm.clientId}
                onChange={(v) => setSiteForm((c) => ({ ...c, clientId: v }))}
                options={activeClientOptions}
                placeholder="Select client…"
              />
            </FormField>

            <FormField label="Site name" required>
              <FieldInput
                value={siteForm.name}
                onChangeText={(v: string) => setSiteForm((c) => ({ ...c, name: v }))}
                placeholder="e.g. Westgate Industrial Park"
                hasError={!!formError && !siteForm.name.trim()}
                autoCapitalize="words"
                style={COMPACT_INPUT}
              />
            </FormField>

            <FormField label="Address" required>
              <FieldInput
                value={siteForm.address}
                onChangeText={(v: string) => setSiteForm((c) => ({ ...c, address: v }))}
                placeholder="e.g. 12 Park Lane, Leeds, LS1 1AB"
                hasError={!!formError && !siteForm.address.trim()}
                style={COMPACT_INPUT}
              />
            </FormField>

            <FormField label="Status">
              <FormSelect
                value={siteForm.status || 'active'}
                onChange={(v) => setSiteForm((c) => ({ ...c, status: v || 'active' }))}
                options={[
                  { label: 'Active',   value: 'active' },
                  { label: 'Inactive', value: 'inactive' },
                  { label: 'Archived', value: 'archived' },
                ]}
              />
            </FormField>
          </View>

          <View style={styles.formDivider} />

          {/* OPERATIONS */}
          <View style={styles.formSection}>
            <Text style={styles.formSectionLabel}>Operations</Text>

            <View style={styles.formRow}>
              <View style={styles.formCell}>
                <FormField label="Guards required">
                  <FieldInput
                    value={siteForm.requiredGuardCount}
                    onChangeText={(v: string) => setSiteForm((c) => ({ ...c, requiredGuardCount: v }))}
                    placeholder="1"
                    keyboardType="numeric"
                    style={COMPACT_INPUT}
                  />
                </FormField>
              </View>
              <View style={styles.formCell}>
                <FormField label="Check-call interval (min)">
                  <FieldInput
                    value={siteForm.checkCallIntervalMinutes}
                    onChangeText={(v: string) => setSiteForm((c) => ({ ...c, checkCallIntervalMinutes: v }))}
                    placeholder="60"
                    keyboardType="numeric"
                    style={COMPACT_INPUT}
                  />
                </FormField>
              </View>
            </View>

            <FormField label="Operating days">
              <FieldInput
                value={siteForm.operatingDays}
                onChangeText={(v: string) => setSiteForm((c) => ({ ...c, operatingDays: v }))}
                placeholder="e.g. Mon-Fri"
                style={COMPACT_INPUT}
              />
            </FormField>

            <View style={styles.formRow}>
              <View style={styles.formCell}>
                <FormField label="Start time">
                  <ControlledTimeInput
                    value={siteForm.operatingStartTime}
                    onChange={(v) => setSiteForm((c) => ({ ...c, operatingStartTime: v }))}
                  />
                </FormField>
              </View>
              <View style={styles.formCell}>
                <FormField label="End time">
                  <ControlledTimeInput
                    value={siteForm.operatingEndTime}
                    onChange={(v) => setSiteForm((c) => ({ ...c, operatingEndTime: v }))}
                  />
                </FormField>
              </View>
            </View>
          </View>

          <View style={styles.formDivider} />

          {/* LOCATION & ATTENDANCE VERIFICATION */}
          <View style={styles.formSection}>
            <Text style={styles.formSectionLabel}>Location & Attendance Verification</Text>

            <View style={styles.formRow}>
              <View style={styles.formCell}>
                <FormField label="Latitude" helperText="−90 to 90">
                  <FieldInput
                    value={siteForm.latitude}
                    onChangeText={(v: string) => setSiteForm((c) => ({ ...c, latitude: v }))}
                    placeholder="e.g. 53.79845"
                    keyboardType="numbers-and-punctuation"
                    style={COMPACT_INPUT}
                  />
                </FormField>
              </View>
              <View style={styles.formCell}>
                <FormField label="Longitude" helperText="−180 to 180">
                  <FieldInput
                    value={siteForm.longitude}
                    onChangeText={(v: string) => setSiteForm((c) => ({ ...c, longitude: v }))}
                    placeholder="e.g. −1.75432"
                    keyboardType="numbers-and-punctuation"
                    style={COMPACT_INPUT}
                  />
                </FormField>
              </View>
            </View>

            <FormField label="Geofence radius (metres)" helperText="25 – 5000 m. Default 150 m.">
              <FieldInput
                value={siteForm.geofenceRadiusMeters}
                onChangeText={(v: string) => setSiteForm((c) => ({ ...c, geofenceRadiusMeters: v }))}
                placeholder="150"
                keyboardType="numeric"
                style={COMPACT_INPUT}
              />
            </FormField>

            <ToggleRow
              value={siteForm.requireGpsCheckIn}
              onChange={(v) => setSiteForm((c) => ({ ...c, requireGpsCheckIn: v }))}
              label="Require GPS verification at Book On"
              helper="The Guard must provide location evidence and be within the permitted radius to Book On to a shift at this site."
            />

            <FormField label="Timezone" helperText="IANA timezone, e.g. Europe/London">
              <FieldInput
                value={siteForm.timezone}
                onChangeText={(v: string) => setSiteForm((c) => ({ ...c, timezone: v }))}
                placeholder="Europe/London"
                autoCapitalize="none"
                autoCorrect={false}
                style={COMPACT_INPUT}
              />
            </FormField>
          </View>

          <View style={styles.formDivider} />

          {/* INSTRUCTIONS */}
          <View style={styles.formSection}>
            <View style={styles.formSectionHead}>
              <Text style={styles.formSectionLabel}>Instructions</Text>
              <Text style={styles.formSectionCaption}>
                Shown to Guards assigned to this site.
              </Text>
            </View>
            <FieldTextarea
              value={siteForm.specialInstructions}
              onChangeText={(v: string) => setSiteForm((c) => ({ ...c, specialInstructions: v }))}
              placeholder="Special instructions for Guards assigned to this site…"
              minLines={3}
              style={{ minHeight: 86 }}
            />
          </View>

          <View style={styles.formDivider} />

          {/* CONTACT */}
          <View style={styles.formSection}>
            <View style={styles.formSectionHead}>
              <Text style={styles.formSectionLabel}>Contact</Text>
              <Text style={styles.formSectionCaption}>
                On-site contact information for assigned Guards.
              </Text>
            </View>
            <FieldTextarea
              value={siteForm.contactDetails}
              onChangeText={(v: string) => setSiteForm((c) => ({ ...c, contactDetails: v }))}
              placeholder="Contact details for this site…"
              minLines={2}
              style={{ minHeight: 86 }}
            />
          </View>

          {/* OPTIONAL STARTER SHIFT — create only */}
          {!siteForm.id ? (
            <>
              <View style={styles.formDivider} />
              <View style={styles.formSection}>
                <View style={styles.formSectionHead}>
                  <Text style={styles.formSectionLabel}>Optional Starter Shift</Text>
                  <Text style={styles.formSectionCaption}>
                    Create an initial unfilled shift for this site.
                  </Text>
                </View>

                {!showStarterShift ? (
                  <Pressable
                    onPress={() => setShowStarterShift(true)}
                    style={[styles.addStarterShiftBtn, IS_WEB ? ({ cursor: 'pointer' } as any) : null]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.addStarterShiftText}>+ Add starter shift</Text>
                  </Pressable>
                ) : (
                  <>
                    <View style={styles.formRow}>
                      <View style={[styles.formCell, { flex: 1.5 }]}>
                        <FormField label="Date">
                          <ControlledDateInput
                            value={siteForm.initialShiftDate}
                            onChange={(v) => setSiteForm((c) => ({ ...c, initialShiftDate: v }))}
                          />
                        </FormField>
                      </View>
                      <View style={styles.formCell}>
                        <FormField label="Start">
                          <ControlledTimeInput
                            value={siteForm.initialShiftStartTime}
                            onChange={(v) => setSiteForm((c) => ({ ...c, initialShiftStartTime: v }))}
                          />
                        </FormField>
                      </View>
                      <View style={styles.formCell}>
                        <FormField label="End">
                          <ControlledTimeInput
                            value={siteForm.initialShiftEndTime}
                            onChange={(v) => setSiteForm((c) => ({ ...c, initialShiftEndTime: v }))}
                          />
                        </FormField>
                      </View>
                    </View>
                    <Pressable
                      onPress={() => {
                        setSiteForm((c) => ({
                          ...c,
                          initialShiftDate: '',
                          initialShiftStartTime: '',
                          initialShiftEndTime: '',
                        }));
                        setShowStarterShift(false);
                      }}
                      style={[styles.removeStarterShiftBtn, IS_WEB ? ({ cursor: 'pointer' } as any) : null]}
                      accessibilityRole="button"
                    >
                      <Text style={styles.removeStarterShiftText}>Remove starter shift</Text>
                    </Pressable>
                  </>
                )}
              </View>
            </>
          ) : null}
        </View>
      </Drawer>

      {/* ── Archive confirmation ───────────────────────────────────────────── */}
      <ConfirmationDialog
        visible={archivingSite !== null}
        onClose={() => setArchivingSite(null)}
        onConfirm={handleConfirmArchive}
        title={archivingSite ? `Archive ${archivingSite.name}?` : 'Archive site?'}
        message={
          archivingSite
            ? `${archivingSite.name} will be set to Archived and hidden from the default view. The record is not deleted and can be restored using the Archived filter.`
            : ''
        }
        confirmLabel="Archive Site"
        cancelLabel="Cancel"
        variant="danger"
        loading={archivingProgress}
      />
    </View>
  );
}

// ─── Compact input height constant ───────────────────────────────────────────

const COMPACT_INPUT = { height: 42, minHeight: 42 } as const;

// ─── FormSelect web style object ─────────────────────────────────────────────

const formSelectStyle = {
  height: 42,
  borderWidth: 1.5,
  borderColor: colors.fieldBorder,
  borderRadius: radii.sm,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  fontSize: 16,
  lineHeight: 24,
  color: colors.textPrimary,
  backgroundColor: colors.card,
  width: '100%',
  outlineStyle: 'none',
} as const;

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flexDirection: 'column',
    backgroundColor: colors.background,
  },

  // ── Action strip ────────────────────────────────────────────────────────
  actionStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.lg,
  },
  statsText: {
    ...typography.caption,
    color: colors.textSecondary,
  } as any,
  statsNum: {
    fontWeight: '600',
    color: colors.textPrimary,
  },
  statsDot: {
    color: colors.border,
  },

  // ── Toolbar ─────────────────────────────────────────────────────────────
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  searchBox: {
    flex: 1,
    minWidth: 180,
    flexDirection: 'row',
    alignItems: 'center',
    height: 36,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.background,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    gap: spacing.xs,
  },
  searchIcon: {
    fontSize: 16,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary,
    height: 36,
    ...(IS_WEB ? { outlineStyle: 'none' } : null),
  } as any,
  filterChips: {
    flexDirection: 'row',
    gap: 4,
  },
  filterChip: {
    height: 28,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipActive: {
    borderColor: colors.accentTeal,
    backgroundColor: colors.accentTealSoft,
  },
  filterChipText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  filterChipTextActive: {
    color: colors.accentTealStrong,
    fontWeight: '700',
  },

  // ── Table ────────────────────────────────────────────────────────────────
  tableHScrollContent: {
    flexGrow: 1,
    minWidth: 780,
  },
  tableContainer: {
    backgroundColor: colors.card,
    flex: 1,
  },
  colSite: {
    minWidth: 160,
  },
  colClient: {
    minWidth: 120,
  },

  // Cell content
  siteName: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
    color: colors.textPrimary,
  },
  siteAddress: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
    marginTop: 1,
  },
  clientName: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  guardsCount: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  verifLabel: {
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
  },
  verifGps: {
    color: colors.accentTealStrong,
    fontWeight: '600',
  },
  hoursText: {
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
  },

  // Badge
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
    lineHeight: 16,
  },

  // Empty states
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.section,
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  emptyTitle: {
    ...typography.panelHeading,
    color: colors.textPrimary,
    textAlign: 'center',
  } as any,
  emptyCaption: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 360,
  } as any,

  // ── Quick View Drawer ────────────────────────────────────────────────────
  qvFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flex: 1,
    gap: spacing.sm,
  },
  qvFooterLeft: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  qvFooterRight: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  qvBody: {
    flex: 1,
  },
  qvSection: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    gap: 6,
  },
  qvSectionTitle: {
    ...typography.panelHeading,
    color: colors.textPrimary,
    marginBottom: 4,
  } as any,
  qvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 28,
  },
  qvLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    color: colors.textSecondary,
    width: 88,
    flexShrink: 0,
  },
  qvValue: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary,
    flex: 1,
  },
  qvValueMuted: {
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  qvValueGps: {
    color: colors.accentTealStrong,
    fontWeight: '600',
  },
  qvValueFreeText: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  qvSeparator: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.xl,
  },

  // ── Form Drawer ──────────────────────────────────────────────────────────
  formFooter: {
    flexDirection: 'row',
    gap: spacing.sm,
    flex: 1,
  },
  formBody: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: 16,
  },
  formSection: {
    gap: 10,
  },
  formSectionLabel: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    color: colors.textMuted,
  },
  formSectionCaption: {
    ...typography.caption,
    color: colors.textSecondary,
  } as any,
  formSectionHead: {
    gap: 4,
  },
  formDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 2,
  },
  formErrorBanner: {
    backgroundColor: colors.dangerSurface,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  formErrorText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.danger,
  },
  formRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  formCell: {
    flex: 1,
  },

  // ── Toggle row (GPS requirement) ─────────────────────────────────────────
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  toggleBox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 2,
  },
  toggleBoxActive: {
    backgroundColor: colors.accentTeal,
    borderColor: colors.accentTeal,
  },
  toggleCheck: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.card,
    lineHeight: 14,
  },
  toggleContent: {
    flex: 1,
    gap: spacing.xs,
  },
  toggleLabel: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  toggleHelper: {
    ...typography.caption,
    color: colors.textSecondary,
  } as any,

  // ── Row selection accent ─────────────────────────────────────────────────
  rowAccent: {
    borderLeftWidth: 3,
    borderLeftColor: colors.accentTeal,
  },

  // ── Starter shift disclosure ─────────────────────────────────────────────
  addStarterShiftBtn: {
    paddingVertical: spacing.xs,
    alignSelf: 'flex-start',
  },
  addStarterShiftText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.accentTealStrong,
  },
  removeStarterShiftBtn: {
    paddingVertical: spacing.xs,
    alignSelf: 'flex-start',
  },
  removeStarterShiftText: {
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
    textDecorationLine: 'underline',
  },

  // Native select fallback (mobile)
  nativeSelectFallback: {
    height: 42,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.disabledSurface,
    justifyContent: 'center',
  },
  nativeSelectText: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textPrimary,
  },
});
