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
  PrimaryCell,
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

// ─── StatusBadge ─────────────────────────────────────────────────────────────

function ClientStatusBadge({ status }: { status?: string | null }) {
  const b = getStatusBadge(status);
  return (
    <View style={[styles.badge, { backgroundColor: b.bg, borderColor: b.color }]}>
      <Text style={[styles.badgeText, { color: b.color }]}>{b.label}</Text>
    </View>
  );
}

// ─── FormSelect (web-native <select> for status field) ───────────────────────

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
  React.useEffect(() => {
    setMounted(IS_WEB);
  }, []);

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
          <OptionTag key={opt.value} value={opt.value}>
            {opt.label}
          </OptionTag>
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

// ─── Minimum table width ──────────────────────────────────────────────────────
// Sum of fixed-width columns + minimum flex-column widths + row outer padding.
// When the container is narrower, the horizontal ScrollView activates.

const FIXED_COL_TOTAL = 100 + 64 + 120 + 72; // status + sites + updated + actions = 356
const MIN_FLEX_TOTAL  = 180 + 150;             // min client + min contact = 330
const ROW_OUTER_PAD   = spacing.md * 2;        // TableFoundation row paddingHorizontal × 2
const TABLE_MIN_WIDTH = FIXED_COL_TOTAL + MIN_FLEX_TOTAL + ROW_OUTER_PAD; // 710

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
  const [tableContainerWidth, setTableContainerWidth] = React.useState(900);

  const handleTableLayout = React.useCallback((e: any) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setTableContainerWidth(w);
  }, []);

  const tableInnerWidth = Math.max(tableContainerWidth, TABLE_MIN_WIDTH);

  // ─── derived ─────────────────────────────────────────────────────────────

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
      // 'all' shows active + inactive only (not archived)
      if (statusFilter === 'all' && status === 'archived') return false;
      // specific filter must match exactly
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

  // ─── handlers ────────────────────────────────────────────────────────────

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

  // ─── render ───────────────────────────────────────────────────────────────

  const qvClient = quickViewClient;
  const canArchiveQV = qvClient && (qvClient.status || 'active').toLowerCase() !== 'archived';

  return (
    <View style={styles.root}>

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <View style={styles.pageHeader}>
        <View style={styles.pageTitleBlock}>
          <Text style={styles.pageTitle}>Client Accounts</Text>
          <Text style={styles.pageCaption}>
            Manage client relationships, contact details, and site associations.
          </Text>
        </View>
        <Button label="+ Add Client" onPress={handleOpenAdd} variant="primary" size="md" />
      </View>

      {/* ── Compact stats strip ───────────────────────────────────────────── */}
      <View style={styles.statsStrip}>
        <Text style={styles.statsText}>
          {stats.total} {stats.total === 1 ? 'client' : 'clients'}
          <Text style={styles.statsDot}> · </Text>
          <Text style={[styles.statsText, { color: colors.success }]}>{stats.active} active</Text>
          <Text style={styles.statsDot}> · </Text>
          {stats.totalSites} {stats.totalSites === 1 ? 'site' : 'sites'}
        </Text>
      </View>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <View style={styles.toolbar}>
        {/* Search */}
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

        {/* Status filter chips */}
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
      <View style={styles.tableContainer} onLayout={handleTableLayout}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={IS_WEB ? ({ scrollbarWidth: 'thin' } as any) : null}
        >
          <View style={{ width: tableInnerWidth, flexDirection: 'column' }}>

            {/* Header */}
            <TableHeader>
              <TableHeaderCell label="Client"  flex={3.5} />
              <TableHeaderCell label="Contact" flex={2} />
              <TableHeaderCell label="Status"  width={100} />
              <TableHeaderCell label="Sites"   width={64}  align="center" />
              <TableHeaderCell label="Updated" width={120} />
              <TableHeaderCell label=""        width={72}  />
            </TableHeader>

            {/* Empty — no clients at all */}
            {filteredClients.length === 0 && clients.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No clients yet</Text>
                <Text style={styles.emptyCaption}>
                  Add your first client to start managing contracts and sites.
                </Text>
                <Button label="+ Add Client" onPress={handleOpenAdd} variant="primary" size="sm" />
              </View>
            ) : filteredClients.length === 0 ? (
              /* Empty — filter / search has no matches */
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No clients match</Text>
                <Text style={styles.emptyCaption}>
                  {statusFilter === 'all'
                    ? 'Try adjusting your search, or switch to a specific status filter (including Archived) to find what you\'re looking for.'
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
              /* Data rows */
              filteredClients.map((client) => (
                <Fragment key={client.id}>
                  <TableRow onPress={() => setQuickViewClient(client)}>
                    {/* CLIENT */}
                    <PrimaryCell
                      label={client.name}
                      subtitle={client.contactName ?? undefined}
                      flex={3.5}
                    />

                    {/* CONTACT */}
                    <TableCell flex={2}>
                      {client.contactEmail ? (
                        <Text style={styles.contactEmail} numberOfLines={1}>
                          {client.contactEmail}
                        </Text>
                      ) : null}
                      {client.contactPhone ? (
                        <Text style={styles.contactPhone} numberOfLines={1}>
                          {client.contactPhone}
                        </Text>
                      ) : null}
                      {!client.contactEmail && !client.contactPhone ? (
                        <Text style={styles.contactPhone}>—</Text>
                      ) : null}
                    </TableCell>

                    {/* STATUS */}
                    <TableCell width={100}>
                      <ClientStatusBadge status={client.status} />
                    </TableCell>

                    {/* SITES */}
                    <TableCell width={64} align="center">
                      <Text style={styles.siteCount}>
                        {siteCountByClientId.get(client.id) ?? 0}
                      </Text>
                    </TableCell>

                    {/* UPDATED */}
                    <TableCell width={120}>
                      <Text style={styles.updatedText} numberOfLines={1}>
                        {fmtDate(client.updatedAt)}
                      </Text>
                    </TableCell>

                    {/* ACTION */}
                    <ActionCell width={72}>
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
          </View>
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
            {/* Details */}
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
              <Text style={styles.qvSectionTitle}>Sites ({clientSites.length})</Text>
              {clientSites.length === 0 ? (
                <Text style={styles.qvEmptyCaption}>No sites linked to this client.</Text>
              ) : (
                clientSites.map((site) => (
                  <View key={site.id} style={styles.siteItem}>
                    <View style={styles.siteItemLeft}>
                      <Text style={styles.siteName}>{site.name}</Text>
                      <Text style={styles.siteAddress} numberOfLines={1}>{site.address}</Text>
                    </View>
                    <ClientStatusBadge status={site.status} />
                  </View>
                ))
              )}
            </View>
          </View>
        ) : null}
      </Drawer>

      {/* ── Form Drawer ────────────────────────────────────────────────────── */}
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

          <FormField label="Client name" required>
            <FieldInput
              value={clientForm.name}
              onChangeText={(v: string) => setClientForm((cur) => ({ ...cur, name: v }))}
              placeholder="e.g. Acme Security Ltd"
              hasError={!!formError && !clientForm.name.trim()}
              autoCapitalize="words"
            />
          </FormField>

          <FormField label="Contact person">
            <FieldInput
              value={clientForm.contactName}
              onChangeText={(v: string) => setClientForm((cur) => ({ ...cur, contactName: v }))}
              placeholder="e.g. Jane Smith"
              autoCapitalize="words"
            />
          </FormField>

          <FormField label="Contact email">
            <FieldInput
              value={clientForm.contactEmail}
              onChangeText={(v: string) => setClientForm((cur) => ({ ...cur, contactEmail: v }))}
              placeholder="e.g. jane@acme.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </FormField>

          <FormField label="Contact phone">
            <FieldInput
              value={clientForm.contactPhone}
              onChangeText={(v: string) => setClientForm((cur) => ({ ...cur, contactPhone: v }))}
              placeholder="e.g. +44 7700 900000"
              keyboardType="phone-pad"
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

          <FormField label="Notes">
            <FieldTextarea
              value={clientForm.notes}
              onChangeText={(v: string) => setClientForm((cur) => ({ ...cur, notes: v }))}
              placeholder="Additional notes about this client…"
              minLines={3}
            />
          </FormField>
        </View>
      </Drawer>

      {/* ── Archive ConfirmationDialog ─────────────────────────────────────── */}
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const formSelectStyle = {
  height: control.inputHeight,
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

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    flexDirection: 'column',
    backgroundColor: colors.background,
  },

  // ── Page header ───────────────────────────────────────────────────────────
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.lg,
  },
  pageTitleBlock: {
    flex: 1,
    gap: spacing.xs,
  },
  pageTitle: {
    ...typography.sectionTitle,
    color: colors.primaryNavy,
  } as any,
  pageCaption: {
    ...typography.caption,
    color: colors.textSecondary,
  } as any,

  // ── Compact stats strip ───────────────────────────────────────────────────
  statsStrip: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  statsText: {
    ...typography.caption,
    color: colors.textSecondary,
  } as any,
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
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.card,
  },

  // Table cell content
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
    paddingVertical: spacing.lg,
    gap: spacing.sm,
  },
  qvSectionTitle: {
    ...typography.panelHeading,
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  } as any,
  qvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 32,
  },
  qvRowTop: {
    alignItems: 'flex-start',
  },
  qvLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    color: colors.textSecondary,
    width: 68,
    flexShrink: 0,
  },
  qvValue: {
    ...typography.body,
    color: colors.textPrimary,
    flex: 1,
    fontSize: 14,
  } as any,
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
  siteItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
  },
  siteItemLeft: {
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
    paddingVertical: spacing.lg,
    gap: spacing.lg,
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

  // Native select fallback
  nativeSelectFallback: {
    height: control.inputHeight,
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
