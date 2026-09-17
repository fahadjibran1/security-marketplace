import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Client, Site } from '../../types/models';
import { colors, control, radii, spacing, typography } from '../../theme';
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

export type ClientFormState = {
  id?: number;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  status: string;
  notes: string;
};

export const CLIENT_FORM_EMPTY: ClientFormState = {
  name: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  status: 'active',
  notes: '',
};

// ─── Internal types ───────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'active' | 'inactive' | 'archived';

type Props = {
  clients: Client[];
  sites: Site[];
  clientForm: ClientFormState;
  setClientForm: React.Dispatch<React.SetStateAction<ClientFormState>>;
  savingClient: boolean;
  onSaveClient: () => Promise<void>;
  onArchiveClient: (client: Client) => Promise<void>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtStatus(value?: string | null): string {
  if (!value) return 'Active';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function getStatusBadge(status?: string | null): { label: string; color: string; bg: string } {
  switch ((status || 'active').toLowerCase()) {
    case 'active':
      return { label: 'Active', color: colors.success, bg: colors.successSurface };
    case 'inactive':
      return { label: 'Inactive', color: colors.warning, bg: colors.warningSurface };
    case 'archived':
      return { label: 'Archived', color: colors.textMuted, bg: colors.pendingSurface };
    default:
      return { label: fmtStatus(status), color: colors.textSecondary, bg: colors.surfaceSubtle };
  }
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

// ─── ClientStatusBadge ───────────────────────────────────────────────────────

function ClientStatusBadge({ status }: { status?: string | null }) {
  const b = getStatusBadge(status);
  return (
    <View style={[styles.badge, { backgroundColor: b.bg, borderColor: b.color }]}>
      <Text style={[styles.badgeText, { color: b.color }]}>{b.label}</Text>
    </View>
  );
}

// ─── FormSelect (web-native <select>) ────────────────────────────────────────

function FormSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ label: string; value: string }>;
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
        aria-label="Status"
      >
        {options.map((opt) => (
          <OptionTag key={opt.value} value={opt.value}>{opt.label}</OptionTag>
        ))}
      </SelectTag>
    );
  }

  return (
    <View style={styles.nativeSelectFallback}>
      <Text style={styles.nativeSelectText}>{fmtStatus(value)}</Text>
    </View>
  );
}

// ─── Column layout constants ──────────────────────────────────────────────────
// CLIENT and CONTACT use flex so they naturally fill available space — no
// onLayout measurement required. Fixed-width columns are protected from wrap.
// Both TableHeader cells and TableRow cells use the SAME values, so header/body
// alignment is guaranteed regardless of container width.

const COL_STATUS_W  = 108; // "Inactive" badge + cell padding
const COL_SITES_W   = 72;  // centered digit(s)
const COL_UPDATED_W = 120; // "20 Sep 2025"
const COL_ACTION_W  = 52;  // pencil icon button

// Body scroll height: ~9 rows at 52 px each fit at 1366×768.
// calc() value accounts for topbar (56) + pageHeader (~76) + gap/padding (72)
// + actionStrip (~34) + toolbar (~52) + column header (~32) = ~322px.
const TABLE_BODY_MAX_HEIGHT: number | string = IS_WEB
  ? ('calc(100vh - 322px)' as any)
  : 468;

// ─── Main component ───────────────────────────────────────────────────────────

export function CompanyClientsWorkspace({
  clients,
  sites,
  clientForm,
  setClientForm,
  savingClient,
  onSaveClient,
  onArchiveClient,
}: Props) {
  const [searchQuery, setSearchQuery]   = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const [quickViewClient, setQuickViewClient] = React.useState<Client | null>(null);
  const [formDrawerOpen, setFormDrawerOpen]   = React.useState(false);
  const [formError, setFormError]             = React.useState<string | null>(null);
  const [archivingClient, setArchivingClient]         = React.useState<Client | null>(null);
  const [archivingInProgress, setArchivingInProgress] = React.useState(false);

  // ─── Derived state ────────────────────────────────────────────────────────

  const siteCountByClientId = React.useMemo(() => {
    const map = new Map<number, number>();
    for (const site of sites) {
      const cid = site.client?.id ?? site.clientId;
      if (cid != null) map.set(cid, (map.get(cid) ?? 0) + 1);
    }
    return map;
  }, [sites]);

  const filteredClients = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return clients.filter((client) => {
      const status = (client.status || 'active').toLowerCase();
      if (statusFilter === 'all' && status === 'archived') return false;
      if (statusFilter !== 'all' && status !== statusFilter) return false;
      if (!q) return true;
      return (
        client.name.toLowerCase().includes(q) ||
        (client.contactName  || '').toLowerCase().includes(q) ||
        (client.contactEmail || '').toLowerCase().includes(q) ||
        (client.contactPhone || '').toLowerCase().includes(q)
      );
    });
  }, [clients, searchQuery, statusFilter]);

  const stats = React.useMemo(() => {
    const active = clients.filter((c) => (c.status || 'active').toLowerCase() === 'active').length;
    return { total: clients.length, active, totalSites: sites.length };
  }, [clients, sites]);

  const clientSites = React.useMemo(
    () =>
      quickViewClient
        ? sites.filter((s) => (s.client?.id ?? s.clientId) === quickViewClient.id)
        : [],
    [quickViewClient, sites],
  );

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleOpenAdd = () => {
    setClientForm(CLIENT_FORM_EMPTY);
    setFormError(null);
    setFormDrawerOpen(true);
  };

  const handleOpenEdit = (client: Client) => {
    setClientForm({
      id: client.id,
      name: client.name,
      contactName: client.contactName   || '',
      contactEmail: client.contactEmail || '',
      contactPhone: client.contactPhone || '',
      status: client.status || 'active',
      notes: client.contactDetails || '',
    });
    setFormError(null);
    setQuickViewClient(null);
    setFormDrawerOpen(true);
  };

  const handleCloseForm = () => {
    if (savingClient) return;
    setFormDrawerOpen(false);
    setFormError(null);
  };

  const handleSave = async () => {
    setFormError(null);
    try {
      await onSaveClient();
      setFormDrawerOpen(false);
    } catch (err: any) {
      setFormError(err?.message || 'Unable to save this client right now.');
    }
  };

  const handleArchiveRequest = (client: Client) => setArchivingClient(client);

  const handleConfirmArchive = async () => {
    if (!archivingClient) return;
    setArchivingInProgress(true);
    try {
      await onArchiveClient(archivingClient);
      if (quickViewClient?.id === archivingClient.id) setQuickViewClient(null);
      setArchivingClient(null);
    } catch {
      // parent surfaces error via global banner
    } finally {
      setArchivingInProgress(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const qvClient = quickViewClient;
  const canArchiveQV = qvClient && (qvClient.status || 'active').toLowerCase() !== 'archived';

  return (
    <View style={styles.root}>

      {/* ── Action strip (stats + add button) ────────────────────────────── */}
      <View style={styles.actionStrip}>
        <Text style={styles.statsText}>
          <Text style={styles.statsNum}>{stats.total}</Text>
          {' '}{stats.total === 1 ? 'client' : 'clients'}
          <Text style={styles.statsDot}> · </Text>
          <Text style={[styles.statsText, { color: colors.success }]}>
            <Text style={[styles.statsNum, { color: colors.success }]}>{stats.active}</Text>
            {' active'}
          </Text>
          <Text style={styles.statsDot}> · </Text>
          <Text style={styles.statsNum}>{stats.totalSites}</Text>
          {' '}{stats.totalSites === 1 ? 'site' : 'sites'}
        </Text>
        <Button label="+ Add Client" onPress={handleOpenAdd} variant="primary" size="sm" />
      </View>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <View style={styles.toolbar}>
        <View style={styles.searchBox}>
          <Text style={styles.searchIcon} accessible={false}>⌕</Text>
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search clients…"
            placeholderTextColor={colors.fieldPlaceholder}
            accessibilityLabel="Search clients"
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
            <View
              key={f}
              style={[styles.filterChip, statusFilter === f && styles.filterChipActive]}
            >
              <Text
                // @ts-ignore
                onPress={() => setStatusFilter(f)}
                style={[
                  styles.filterChipText,
                  statusFilter === f && styles.filterChipTextActive,
                  IS_WEB ? ({ cursor: 'pointer', userSelect: 'none' } as any) : null,
                ]}
              >
                {f === 'all' ? 'All active' : fmtStatus(f)}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <View style={styles.tableContainer}>

        {/* Fixed column header — never scrolls */}
        <TableHeader>
          <TableHeaderCell label="Client"  flex={3.5} style={styles.colClient} />
          <TableHeaderCell label="Contact" flex={2}   style={styles.colContact} />
          <TableHeaderCell label="Status"  width={COL_STATUS_W} />
          <TableHeaderCell label="Sites"   width={COL_SITES_W}  align="center" />
          <TableHeaderCell label="Updated" width={COL_UPDATED_W} />
          <TableHeaderCell label=""        width={COL_ACTION_W} />
        </TableHeader>

        {/* Vertically-scrollable row body */}
        <ScrollView
          style={[
            styles.tableBodyScroll,
            IS_WEB ? ({ scrollbarWidth: 'thin', scrollbarColor: `${colors.border} transparent` } as any) : null,
          ]}
          showsVerticalScrollIndicator={IS_WEB}
          nestedScrollEnabled
        >
          {/* Empty — no clients */}
          {filteredClients.length === 0 && clients.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No clients yet</Text>
              <Text style={styles.emptyCaption}>
                Add your first client to start managing contracts and sites.
              </Text>
              <Button label="+ Add Client" onPress={handleOpenAdd} variant="primary" size="sm" />
            </View>
          ) : filteredClients.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No clients match</Text>
              <Text style={styles.emptyCaption}>
                {statusFilter === 'all'
                  ? "Try adjusting your search, or switch to Archived to find hidden records."
                  : 'Try adjusting your search or selecting a different status filter.'}
              </Text>
              <Button
                label="Clear filters"
                onPress={() => { setSearchQuery(''); setStatusFilter('all'); }}
                variant="secondary"
                size="sm"
              />
            </View>
          ) : (
            filteredClients.map((client) => (
              <Fragment key={client.id}>
                <TableRow onPress={() => setQuickViewClient(client)}>

                  {/* CLIENT */}
                  <TableCell flex={3.5} style={styles.colClient}>
                    <Text style={styles.clientName} numberOfLines={1}>{client.name}</Text>
                    {client.contactName ? (
                      <Text style={styles.clientSubtitle} numberOfLines={1}>{client.contactName}</Text>
                    ) : null}
                  </TableCell>

                  {/* CONTACT */}
                  <TableCell flex={2} style={styles.colContact}>
                    {client.contactEmail ? (
                      <Text style={styles.contactEmail} numberOfLines={1}>{client.contactEmail}</Text>
                    ) : null}
                    {client.contactPhone ? (
                      <Text style={styles.contactPhone} numberOfLines={1}>{client.contactPhone}</Text>
                    ) : null}
                    {!client.contactEmail && !client.contactPhone ? (
                      <Text style={styles.contactPhone}>—</Text>
                    ) : null}
                  </TableCell>

                  {/* STATUS */}
                  <TableCell width={COL_STATUS_W}>
                    <ClientStatusBadge status={client.status} />
                  </TableCell>

                  {/* SITES */}
                  <TableCell width={COL_SITES_W} align="center">
                    <Text style={styles.siteCount}>
                      {siteCountByClientId.get(client.id) ?? 0}
                    </Text>
                  </TableCell>

                  {/* UPDATED */}
                  <TableCell width={COL_UPDATED_W}>
                    <Text style={styles.updatedText} numberOfLines={1}>
                      {fmtDate(client.updatedAt)}
                    </Text>
                  </TableCell>

                  {/* ACTION */}
                  <ActionCell width={COL_ACTION_W}>
                    <IconButton
                      icon="✎"
                      accessibilityLabel={`Edit ${client.name}`}
                      onPress={() => handleOpenEdit(client)}
                      variant="ghost"
                      size="sm"
                    />
                  </ActionCell>

                </TableRow>
              </Fragment>
            ))
          )}
        </ScrollView>
      </View>

      {/* ── Quick View Drawer ─────────────────────────────────────────────── */}
      <Drawer
        visible={qvClient !== null}
        onClose={() => setQuickViewClient(null)}
        title={qvClient?.name ?? ''}
        subtitle="Client overview"
        footer={
          qvClient ? (
            <View style={styles.qvFooter}>
              <View style={styles.qvFooterPrimary}>
                <Button
                  label="Edit Client"
                  onPress={() => handleOpenEdit(qvClient)}
                  variant="primary"
                  size="sm"
                />
                <Button
                  label="Close"
                  onPress={() => setQuickViewClient(null)}
                  variant="secondary"
                  size="sm"
                />
              </View>
              {canArchiveQV ? (
                <Button
                  label="Archive"
                  onPress={() => handleArchiveRequest(qvClient)}
                  variant="danger"
                  size="sm"
                />
              ) : null}
            </View>
          ) : undefined
        }
      >
        {qvClient ? (
          <View style={styles.qvBody}>

            {/* Detail rows */}
            <View style={styles.qvSection}>
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Status</Text>
                <ClientStatusBadge status={qvClient.status} />
              </View>
              {qvClient.contactName ? (
                <View style={styles.qvRow}>
                  <Text style={styles.qvLabel}>Contact</Text>
                  <Text style={styles.qvValue}>{qvClient.contactName}</Text>
                </View>
              ) : null}
              {qvClient.contactEmail ? (
                <View style={styles.qvRow}>
                  <Text style={styles.qvLabel}>Email</Text>
                  <Text style={styles.qvValue}>{qvClient.contactEmail}</Text>
                </View>
              ) : null}
              {qvClient.contactPhone ? (
                <View style={styles.qvRow}>
                  <Text style={styles.qvLabel}>Phone</Text>
                  <Text style={styles.qvValue}>{qvClient.contactPhone}</Text>
                </View>
              ) : null}
              {qvClient.contactDetails ? (
                <View style={[styles.qvRow, styles.qvRowTop]}>
                  <Text style={styles.qvLabel}>Notes</Text>
                  <Text style={[styles.qvValue, styles.qvNotes]}>{qvClient.contactDetails}</Text>
                </View>
              ) : null}
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Created</Text>
                <Text style={styles.qvValue}>{fmtDate(qvClient.createdAt)}</Text>
              </View>
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Updated</Text>
                <Text style={styles.qvValue}>{fmtDate(qvClient.updatedAt)}</Text>
              </View>
            </View>

            <View style={styles.qvSeparator} />

            {/* Sites */}
            <View style={styles.qvSection}>
              <Text style={styles.qvSectionTitle}>
                Sites ({clientSites.length})
              </Text>
              {clientSites.length === 0 ? (
                <Text style={styles.qvEmptyCaption}>No sites linked to this client.</Text>
              ) : (
                clientSites.map((site, idx) => (
                  <View
                    key={site.id}
                    style={[styles.siteRow, idx === 0 && styles.siteRowFirst]}
                  >
                    <View style={styles.siteRowLeft}>
                      <Text style={styles.siteName}>{site.name}</Text>
                      {site.address ? (
                        <Text style={styles.siteAddress} numberOfLines={1}>{site.address}</Text>
                      ) : null}
                    </View>
                    <ClientStatusBadge status={site.status} />
                  </View>
                ))
              )}
            </View>
          </View>
        ) : null}
      </Drawer>

      {/* ── Form Drawer ───────────────────────────────────────────────────── */}
      <Drawer
        visible={formDrawerOpen}
        onClose={handleCloseForm}
        title={clientForm.id ? 'Edit Client' : 'Add Client'}
        subtitle={clientForm.id ? 'Update client details' : 'Create a new client account'}
        footer={
          <View style={styles.formFooter}>
            <Button
              label={clientForm.id ? 'Save Changes' : 'Create Client'}
              onPress={handleSave}
              variant="primary"
              size="md"
              loading={savingClient}
            />
            <Button
              label="Cancel"
              onPress={handleCloseForm}
              variant="secondary"
              size="md"
              disabled={savingClient}
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

          {/* Section: Client Details */}
          <View style={styles.formSection}>
            <Text style={styles.formSectionLabel}>Client Details</Text>

            <FormField label="Client name" required>
              <FieldInput
                value={clientForm.name}
                onChangeText={(v: string) => setClientForm((cur) => ({ ...cur, name: v }))}
                placeholder="e.g. Acme Security Ltd"
                hasError={!!formError && !clientForm.name.trim()}
                autoCapitalize="words"
                style={COMPACT_INPUT}
              />
            </FormField>

            <FormField label="Status">
              <FormSelect
                value={clientForm.status || 'active'}
                onChange={(v) => setClientForm((cur) => ({ ...cur, status: v || 'active' }))}
                options={[
                  { label: 'Active',   value: 'active'   },
                  { label: 'Inactive', value: 'inactive' },
                  { label: 'Archived', value: 'archived' },
                ]}
              />
            </FormField>
          </View>

          <View style={styles.formDivider} />

          {/* Section: Primary Contact */}
          <View style={styles.formSection}>
            <Text style={styles.formSectionLabel}>Primary Contact</Text>

            <FormField label="Contact person">
              <FieldInput
                value={clientForm.contactName}
                onChangeText={(v: string) => setClientForm((cur) => ({ ...cur, contactName: v }))}
                placeholder="e.g. Jane Smith"
                autoCapitalize="words"
                style={COMPACT_INPUT}
              />
            </FormField>

            <FormField label="Email">
              <FieldInput
                value={clientForm.contactEmail}
                onChangeText={(v: string) => setClientForm((cur) => ({ ...cur, contactEmail: v }))}
                placeholder="e.g. jane@acme.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                style={COMPACT_INPUT}
              />
            </FormField>

            <FormField label="Phone">
              <FieldInput
                value={clientForm.contactPhone}
                onChangeText={(v: string) => setClientForm((cur) => ({ ...cur, contactPhone: v }))}
                placeholder="e.g. +44 7700 900000"
                keyboardType="phone-pad"
                style={COMPACT_INPUT}
              />
            </FormField>
          </View>

          <View style={styles.formDivider} />

          {/* Section: Notes */}
          <View style={styles.formSection}>
            <Text style={styles.formSectionLabel}>Notes</Text>

            <FieldTextarea
              value={clientForm.notes}
              onChangeText={(v: string) => setClientForm((cur) => ({ ...cur, notes: v }))}
              placeholder="Additional context about this client…"
              minLines={3}
            />
          </View>
        </View>
      </Drawer>

      {/* ── Archive confirmation ───────────────────────────────────────────── */}
      <ConfirmationDialog
        visible={archivingClient !== null}
        onClose={() => setArchivingClient(null)}
        onConfirm={handleConfirmArchive}
        title={archivingClient ? `Archive ${archivingClient.name}?` : 'Archive client?'}
        message={
          archivingClient
            ? `${archivingClient.name} will be set to Archived and hidden from the default client view. The record is not deleted and can be retrieved using the Archived filter.`
            : ''
        }
        confirmLabel="Archive Client"
        cancelLabel="Cancel"
        variant="danger"
        loading={archivingInProgress}
      />
    </View>
  );
}

// ─── Compact input height override (passed as style prop to FieldInput) ───────

const COMPACT_INPUT = { height: 42, minHeight: 42 } as const;

// ─── FormSelect style (web <select> element) ──────────────────────────────────

const formSelectStyle = {
  height: 42,
  borderWidth: 1.5,
  borderColor: colors.fieldBorder,
  borderRadius: radii.sm,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  fontSize: 14,
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

  // ── Action strip (stats + add button) ─────────────────────────────────────
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

  // ── Toolbar ───────────────────────────────────────────────────────────────
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

  // ── Table ─────────────────────────────────────────────────────────────────
  tableContainer: {
    backgroundColor: colors.card,
  },

  // Vertically-scrollable row body. maxHeight caps at ~9 rows (52px each)
  // before internal scroll activates. Empty states are shorter and won't show
  // an unnecessary scrollbar because maxHeight is a ceiling, not a floor.
  tableBodyScroll: {
    maxHeight: TABLE_BODY_MAX_HEIGHT as any,
  },

  // Flex-column minimum widths prevent CLIENT/CONTACT from collapsing at narrow
  // viewports. At ≥1280px the flex layout allocates far more than these minima.
  colClient:  { minWidth: 190 },
  colContact: { minWidth: 148 },

  // Table cell content
  clientName: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
    color: colors.textPrimary,
  },
  clientSubtitle: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
    marginTop: 1,
  },
  contactEmail: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary,
  },
  contactPhone: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
    marginTop: 1,
  },
  siteCount: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  updatedText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400',
    color: colors.textSecondary,
  },

  // Status badge
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

  // ── Quick View Drawer ─────────────────────────────────────────────────────
  qvFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flex: 1,
    gap: spacing.sm,
  },
  qvFooterPrimary: {
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
  qvRowTop: {
    alignItems: 'flex-start',
  },
  qvLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    color: colors.textSecondary,
    width: 64,
    flexShrink: 0,
  },
  qvValue: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary,
    flex: 1,
  },
  qvNotes: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  qvSeparator: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.xl,
  },
  qvEmptyCaption: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },

  // Site list — divider-based, no card styling
  siteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  siteRowFirst: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  siteRowLeft: {
    flex: 1,
    gap: 2,
  },
  siteName: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  siteAddress: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
  },

  // ── Form Drawer ───────────────────────────────────────────────────────────
  formFooter: {
    flexDirection: 'row',
    gap: spacing.sm,
    flex: 1,
  },
  formBody: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: 20,
  },
  formSection: {
    gap: 12,
  },
  formSectionLabel: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    color: colors.textMuted,
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
