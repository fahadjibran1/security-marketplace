import * as React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Client, Site } from '../../types/models';
import { colors, control, radii, spacing, typography } from '../../theme';
import { Drawer } from '../ui/Drawer';
import { Button } from '../ui/Button';
import { FormField, FieldInput, FieldTextarea } from '../ui/FormField';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;

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

function StatusBadge({ status }: { status?: string | null }) {
  const b = getStatusBadge(status);
  return (
    <View style={[styles.badge, { backgroundColor: b.bg, borderColor: b.color }]}>
      <Text style={[styles.badgeText, { color: b.color }]}>{b.label}</Text>
    </View>
  );
}

// ─── FormSelect (web-native <select> for form status field) ──────────────────

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
  const [searchQuery, setSearchQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const [showArchived, setShowArchived] = React.useState(false);
  const [quickViewClient, setQuickViewClient] = React.useState<Client | null>(null);
  const [formDrawerOpen, setFormDrawerOpen] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // ─── derived ─────────────────────────────────────────────────────────────

  const siteCountByClientId = React.useMemo(() => {
    const map = new Map<number, number>();
    for (const site of sites) {
      const cid = site.client?.id ?? (site as any).clientId;
      if (cid != null) map.set(cid, (map.get(cid) ?? 0) + 1);
    }
    return map;
  }, [sites]);

  const filteredClients = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return clients.filter((client) => {
      const status = (client.status || 'active').toLowerCase();
      if (!showArchived && status === 'archived') return false;
      if (statusFilter !== 'all' && status !== statusFilter) return false;
      if (!q) return true;
      return (
        client.name.toLowerCase().includes(q) ||
        (client.contactName || '').toLowerCase().includes(q) ||
        (client.contactEmail || '').toLowerCase().includes(q) ||
        (client.contactPhone || '').toLowerCase().includes(q)
      );
    });
  }, [clients, searchQuery, statusFilter, showArchived]);

  const stats = React.useMemo(() => {
    const active = clients.filter((c) => (c.status || 'active').toLowerCase() === 'active').length;
    return { total: clients.length, active, totalSites: sites.length };
  }, [clients, sites]);

  const clientSites = React.useMemo(
    () =>
      quickViewClient
        ? sites.filter((s) => (s.client?.id ?? (s as any).clientId) === quickViewClient.id)
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
      contactName: client.contactName || '',
      contactEmail: client.contactEmail || '',
      contactPhone: client.contactPhone || '',
      status: client.status || 'active',
      notes: client.contactDetails || '',
    });
    setFormError(null);
    setFormDrawerOpen(true);
    setQuickViewClient(null);
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

  const handleArchive = (client: Client) => {
    Alert.alert(
      'Archive client',
      `Archive "${client.name}"? The client will be hidden from active lists but can be restored.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: async () => {
            try {
              await onArchiveClient(client);
              if (quickViewClient?.id === client.id) setQuickViewClient(null);
            } catch {
              // parent surfaces error via global banner
            }
          },
        },
      ],
    );
  };

  const handleToggleArchived = () => {
    if (showArchived) {
      setShowArchived(false);
      if (statusFilter === 'archived') setStatusFilter('all');
    } else {
      setShowArchived(true);
    }
  };

  const handleFilterChip = (filter: StatusFilter) => {
    setStatusFilter(filter);
    if (filter === 'archived') setShowArchived(true);
  };

  // ─── render ───────────────────────────────────────────────────────────────

  return (
    <View style={styles.root}>
      {/* Page header */}
      <View style={styles.pageHeader}>
        <View style={styles.pageTitleBlock}>
          <Text style={styles.pageTitle}>Client Accounts</Text>
          <Text style={styles.pageCaption}>
            Manage client relationships, contact details, and site associations.
          </Text>
        </View>
        <Button label="+ Add Client" onPress={handleOpenAdd} variant="primary" size="md" />
      </View>

      {/* Stats bar */}
      <View style={styles.statsBar}>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{stats.total}</Text>
          <Text style={styles.statLabel}>Total clients</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: colors.success }]}>{stats.active}</Text>
          <Text style={styles.statLabel}>Active</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{stats.totalSites}</Text>
          <Text style={styles.statLabel}>Total sites</Text>
        </View>
      </View>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <View style={styles.searchBox}>
          <Text style={styles.searchIcon} accessible={false}>
            ⌕
          </Text>
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search by name, contact, email or phone…"
            placeholderTextColor={colors.fieldPlaceholder}
            accessibilityLabel="Search clients"
          />
          {searchQuery.length > 0 ? (
            <Pressable
              onPress={() => setSearchQuery('')}
              style={IS_WEB ? (WEB_PTR as any) : null}
              accessibilityLabel="Clear search"
            >
              <Text style={styles.searchClear}>✕</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.filterChips}>
          {(['all', 'active', 'inactive', 'archived'] as StatusFilter[]).map((filter) => (
            <Pressable
              key={filter}
              onPress={() => handleFilterChip(filter)}
              style={({ pressed }: any) => [
                styles.filterChip,
                statusFilter === filter && styles.filterChipActive,
                pressed && styles.filterChipPressed,
                IS_WEB ? (WEB_PTR as any) : null,
              ]}
              accessibilityRole="radio"
              accessibilityState={{ checked: statusFilter === filter }}
            >
              <Text
                style={[
                  styles.filterChipText,
                  statusFilter === filter && styles.filterChipTextActive,
                ]}
              >
                {filter === 'all' ? 'All' : fmtStatus(filter)}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={handleToggleArchived}
          style={({ pressed }: any) => [
            styles.archivedToggle,
            showArchived && styles.archivedToggleOn,
            pressed && styles.archivedTogglePressed,
            IS_WEB ? (WEB_PTR as any) : null,
          ]}
        >
          <Text
            style={[styles.archivedToggleText, showArchived && styles.archivedToggleTextOn]}
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </Text>
        </Pressable>
      </View>

      {/* Table */}
      <View style={styles.tableContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={IS_WEB ? ({ scrollbarWidth: 'thin' } as any) : null}
        >
          <View style={styles.tableInner}>
            {/* Header */}
            <View style={styles.tableHeadRow}>
              <Text style={[styles.headCell, styles.colClient]}>CLIENT</Text>
              <Text style={[styles.headCell, styles.colContact]}>CONTACT</Text>
              <Text style={[styles.headCell, styles.colStatus]}>STATUS</Text>
              <Text style={[styles.headCell, styles.colSites]}>SITES</Text>
              <Text style={[styles.headCell, styles.colUpdated]}>UPDATED</Text>
              <Text style={[styles.headCell, styles.colActions]}>ACTIONS</Text>
            </View>

            {/* Empty — no clients at all */}
            {filteredClients.length === 0 && clients.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No clients yet</Text>
                <Text style={styles.emptyCaption}>
                  Add your first client to start managing contracts and sites.
                </Text>
                <Button
                  label="+ Add Client"
                  onPress={handleOpenAdd}
                  variant="primary"
                  size="sm"
                />
              </View>
            ) : filteredClients.length === 0 ? (
              /* Empty — filter/search has no matches */
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No clients match</Text>
                <Text style={styles.emptyCaption}>
                  Try adjusting your search or filter.
                </Text>
                <Button
                  label="Clear filters"
                  onPress={() => {
                    setSearchQuery('');
                    setStatusFilter('all');
                  }}
                  variant="secondary"
                  size="sm"
                />
              </View>
            ) : (
              /* Data rows */
              filteredClients.map((client, index) => (
                <Pressable
                  key={client.id}
                  onPress={() => setQuickViewClient(client)}
                  style={({ pressed }: any) => [
                    styles.tableRow,
                    index % 2 === 1 && styles.tableRowAlt,
                    pressed && styles.tableRowPressed,
                    IS_WEB ? (WEB_PTR as any) : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${client.name}`}
                >
                  {/* CLIENT */}
                  <View style={[styles.dataCell, styles.colClient]}>
                    <Text style={styles.clientName} numberOfLines={1}>
                      {client.name}
                    </Text>
                    {client.contactName ? (
                      <Text style={styles.clientSub} numberOfLines={1}>
                        {client.contactName}
                      </Text>
                    ) : null}
                  </View>

                  {/* CONTACT */}
                  <View style={[styles.dataCell, styles.colContact]}>
                    {client.contactEmail ? (
                      <Text style={styles.contactLine} numberOfLines={1}>
                        {client.contactEmail}
                      </Text>
                    ) : null}
                    {client.contactPhone ? (
                      <Text style={styles.contactSub} numberOfLines={1}>
                        {client.contactPhone}
                      </Text>
                    ) : null}
                    {!client.contactEmail && !client.contactPhone ? (
                      <Text style={styles.contactSub}>—</Text>
                    ) : null}
                  </View>

                  {/* STATUS */}
                  <View style={[styles.dataCell, styles.colStatus]}>
                    <StatusBadge status={client.status} />
                  </View>

                  {/* SITES */}
                  <View style={[styles.dataCell, styles.colSites]}>
                    <Text style={styles.siteCount}>
                      {siteCountByClientId.get(client.id) ?? 0}
                    </Text>
                  </View>

                  {/* UPDATED */}
                  <View style={[styles.dataCell, styles.colUpdated]}>
                    <Text style={styles.updatedDate}>{fmtDate(client.updatedAt)}</Text>
                  </View>

                  {/* ACTIONS */}
                  <View style={[styles.dataCell, styles.colActions, styles.actionsCell]}>
                    <Pressable
                      onPress={(e: any) => {
                        e?.stopPropagation?.();
                        handleOpenEdit(client);
                      }}
                      style={({ pressed }: any) => [
                        styles.actionBtn,
                        pressed && styles.actionBtnPressed,
                        IS_WEB ? (WEB_PTR as any) : null,
                      ]}
                      accessibilityLabel={`Edit ${client.name}`}
                    >
                      <Text style={styles.actionBtnText}>Edit</Text>
                    </Pressable>

                    {(client.status || 'active').toLowerCase() !== 'archived' ? (
                      <Pressable
                        onPress={(e: any) => {
                          e?.stopPropagation?.();
                          handleArchive(client);
                        }}
                        style={({ pressed }: any) => [
                          styles.actionBtn,
                          styles.actionBtnDanger,
                          pressed && styles.actionBtnDangerPressed,
                          IS_WEB ? (WEB_PTR as any) : null,
                        ]}
                        accessibilityLabel={`Archive ${client.name}`}
                      >
                        <Text style={[styles.actionBtnText, styles.actionBtnDangerText]}>
                          Archive
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </Pressable>
              ))
            )}
          </View>
        </ScrollView>
      </View>

      {/* ── Quick View Drawer ─────────────────────────────────────────────── */}
      <Drawer
        visible={quickViewClient !== null}
        onClose={() => setQuickViewClient(null)}
        title={quickViewClient?.name ?? ''}
        subtitle="Client overview"
        footer={
          <View style={styles.drawerFooterRow}>
            <Button
              label="Edit Client"
              onPress={() => quickViewClient && handleOpenEdit(quickViewClient)}
              variant="primary"
              size="md"
            />
            <Button
              label="Close"
              onPress={() => setQuickViewClient(null)}
              variant="secondary"
              size="md"
            />
          </View>
        }
      >
        {quickViewClient ? (
          <View style={styles.qvBody}>
            {/* Details */}
            <View style={styles.qvSection}>
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Status</Text>
                <StatusBadge status={quickViewClient.status} />
              </View>
              {quickViewClient.contactName ? (
                <View style={styles.qvRow}>
                  <Text style={styles.qvLabel}>Contact</Text>
                  <Text style={styles.qvValue}>{quickViewClient.contactName}</Text>
                </View>
              ) : null}
              {quickViewClient.contactEmail ? (
                <View style={styles.qvRow}>
                  <Text style={styles.qvLabel}>Email</Text>
                  <Text style={styles.qvValue}>{quickViewClient.contactEmail}</Text>
                </View>
              ) : null}
              {quickViewClient.contactPhone ? (
                <View style={styles.qvRow}>
                  <Text style={styles.qvLabel}>Phone</Text>
                  <Text style={styles.qvValue}>{quickViewClient.contactPhone}</Text>
                </View>
              ) : null}
              {quickViewClient.contactDetails ? (
                <View style={[styles.qvRow, styles.qvRowTop]}>
                  <Text style={styles.qvLabel}>Notes</Text>
                  <Text style={[styles.qvValue, styles.qvNotes]}>
                    {quickViewClient.contactDetails}
                  </Text>
                </View>
              ) : null}
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Created</Text>
                <Text style={styles.qvValue}>{fmtDate(quickViewClient.createdAt)}</Text>
              </View>
              <View style={styles.qvRow}>
                <Text style={styles.qvLabel}>Updated</Text>
                <Text style={styles.qvValue}>{fmtDate(quickViewClient.updatedAt)}</Text>
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
                clientSites.map((site) => (
                  <View key={site.id} style={styles.siteItem}>
                    <View style={styles.siteItemLeft}>
                      <Text style={styles.siteName}>{site.name}</Text>
                      <Text style={styles.siteAddress} numberOfLines={1}>
                        {site.address}
                      </Text>
                    </View>
                    <StatusBadge status={site.status} />
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
          <View style={styles.drawerFooterRow}>
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
                { label: 'Active', value: 'active' },
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
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const COL_CLIENT = 220;
const COL_CONTACT = 220;
const COL_STATUS = 110;
const COL_SITES = 72;
const COL_UPDATED = 130;
const COL_ACTIONS = 160;

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

  // ── Stats bar ─────────────────────────────────────────────────────────────
  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: colors.surfaceSubtle,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.lg,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
  },
  statValue: {
    ...typography.title,
    color: colors.primaryNavy,
    fontWeight: '700',
  } as any,
  statLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  } as any,
  statDivider: {
    width: 1,
    height: 20,
    backgroundColor: colors.border,
  },

  // ── Toolbar ───────────────────────────────────────────────────────────────
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  searchBox: {
    flex: 1,
    minWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    height: 38,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  searchIcon: {
    fontSize: 16,
    color: colors.textSecondary,
  },
  searchInput: {
    flex: 1,
    ...typography.body,
    color: colors.textPrimary,
    height: 38,
    ...(IS_WEB ? { outlineStyle: 'none' } : null),
  } as any,
  searchClear: {
    fontSize: 12,
    color: colors.textSecondary,
    paddingHorizontal: spacing.xs,
  },
  filterChips: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  filterChip: {
    height: 32,
    paddingHorizontal: spacing.md,
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
  filterChipPressed: {
    opacity: 0.75,
  },
  filterChipText: {
    ...typography.caption,
    fontWeight: '500',
    color: colors.textSecondary,
  } as any,
  filterChipTextActive: {
    color: colors.accentTealStrong,
    fontWeight: '700',
  },
  archivedToggle: {
    height: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  archivedToggleOn: {
    borderColor: colors.warning,
    backgroundColor: colors.warningSurface,
  },
  archivedTogglePressed: {
    opacity: 0.75,
  },
  archivedToggleText: {
    ...typography.caption,
    fontWeight: '500',
    color: colors.textSecondary,
  } as any,
  archivedToggleTextOn: {
    color: colors.warning,
    fontWeight: '600',
  },

  // ── Table ─────────────────────────────────────────────────────────────────
  tableContainer: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.card,
  },
  tableInner: {
    flexDirection: 'column',
    minWidth: COL_CLIENT + COL_CONTACT + COL_STATUS + COL_SITES + COL_UPDATED + COL_ACTIONS,
  },
  tableHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    backgroundColor: colors.primaryNavy,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.primaryNavyStrong,
  },
  headCell: {
    ...typography.caption,
    color: colors.textOnBrand,
    fontWeight: '700',
    letterSpacing: 0.6,
    fontSize: 11,
  } as any,
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  tableRowAlt: {
    backgroundColor: colors.background,
  },
  tableRowPressed: {
    backgroundColor: colors.surfaceSubtle,
  },
  dataCell: {
    paddingVertical: spacing.sm,
    paddingRight: spacing.md,
    justifyContent: 'center',
  },
  actionsCell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingRight: 0,
  },

  // Column widths
  colClient: { width: COL_CLIENT },
  colContact: { width: COL_CONTACT },
  colStatus: { width: COL_STATUS },
  colSites: { width: COL_SITES },
  colUpdated: { width: COL_UPDATED },
  colActions: { width: COL_ACTIONS },

  // Cell content
  clientName: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '600',
  } as any,
  clientSub: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  } as any,
  contactLine: {
    ...typography.caption,
    color: colors.textPrimary,
  } as any,
  contactSub: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  } as any,
  siteCount: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '600',
  } as any,
  updatedDate: {
    ...typography.caption,
    color: colors.textSecondary,
  } as any,

  // Action buttons
  actionBtn: {
    height: 30,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 52,
  },
  actionBtnPressed: {
    backgroundColor: colors.surfaceSubtle,
  },
  actionBtnText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textPrimary,
  } as any,
  actionBtnDanger: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
  },
  actionBtnDangerPressed: {
    backgroundColor: colors.dangerBorder,
  },
  actionBtnDangerText: {
    color: colors.danger,
  },

  // Status badge
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },

  // Empty states
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.section,
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
    minWidth: COL_CLIENT + COL_CONTACT + COL_STATUS + COL_SITES + COL_UPDATED + COL_ACTIONS,
  },
  emptyTitle: {
    ...typography.heading,
    color: colors.textPrimary,
    textAlign: 'center',
  } as any,
  emptyCaption: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 360,
  } as any,

  // ── Quick View Drawer ─────────────────────────────────────────────────────
  drawerFooterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    flex: 1,
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
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
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
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
    width: 72,
    flexShrink: 0,
  } as any,
  qvValue: {
    ...typography.body,
    color: colors.textPrimary,
    flex: 1,
  } as any,
  qvNotes: {
    color: colors.textSecondary,
  },
  qvSeparator: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.xl,
  },
  qvEmptyCaption: {
    ...typography.caption,
    color: colors.textSecondary,
    fontStyle: 'italic',
  } as any,
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
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '600',
  } as any,
  siteAddress: {
    ...typography.caption,
    color: colors.textSecondary,
  } as any,

  // ── Form Drawer ───────────────────────────────────────────────────────────
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
    ...typography.caption,
    color: colors.danger,
    fontWeight: '600',
  } as any,

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
    ...typography.body,
    color: colors.textPrimary,
  } as any,
});
