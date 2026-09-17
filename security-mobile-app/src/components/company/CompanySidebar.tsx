import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { brand, colors, radii, spacing } from '../../theme';

const IS_WEB = typeof document !== 'undefined';

type NavItem<Id extends string> = {
  id: Id;
  label: string;
  caption: string;
};

type NavGroup<Id extends string> = {
  id: string;
  title: string;
  itemIds: Id[];
};

type CompanySidebarProps<Id extends string> = {
  /** Deprecated — kept for call-site compat; no longer rendered. */
  title?: string;
  /** Deprecated — kept for call-site compat; no longer rendered. */
  subtitle?: string;
  /** Deprecated — kept for call-site compat; no longer rendered. */
  description?: string;
  /** Deprecated — kept for call-site compat; no longer rendered. */
  brandLogo?: any;
  activeId: Id;
  navItems: Array<NavItem<Id>>;
  groups: Array<NavGroup<Id>>;
  onNavigate: (id: Id) => void;
  /** When true the sidebar renders in icon-only mode (64px wide). */
  collapsed?: boolean;
  /** Called when the user presses the collapse/expand toggle. */
  onToggleCollapse?: () => void;
};

function buildItemByIdMap<Id extends string>(items: Array<NavItem<Id>>) {
  const map = new Map<Id, NavItem<Id>>();
  items.forEach((item) => map.set(item.id, item));
  return map;
}

function groupContainsActive<Id extends string>(group: NavGroup<Id>, activeId: Id) {
  return group.itemIds.includes(activeId);
}

export function CompanySidebar<Id extends string>({
  activeId,
  navItems,
  groups,
  onNavigate,
  collapsed = false,
  onToggleCollapse,
}: CompanySidebarProps<Id>) {
  const itemById = React.useMemo(() => buildItemByIdMap(navItems), [navItems]);

  // ── Expanded-mode group accordion state ──────────────────────────────────
  const initialExpanded = React.useMemo(() => {
    const map = new Map<string, boolean>();
    groups.forEach((group, index) => {
      map.set(group.id, groupContainsActive(group, activeId) || index === 0);
    });
    return map;
  }, [activeId, groups]);

  const [expandedByGroupId, setExpandedByGroupId] = React.useState<Map<string, boolean>>(initialExpanded);

  // Auto-expand the group containing the newly-active item.
  React.useEffect(() => {
    const activeGroup = groups.find((g) => groupContainsActive(g, activeId));
    if (!activeGroup) return;
    setExpandedByGroupId((current) => {
      if (current.get(activeGroup.id)) return current;
      const next = new Map(current);
      next.set(activeGroup.id, true);
      return next;
    });
  }, [activeId, groups]);

  function toggleGroup(group: NavGroup<Id>) {
    setExpandedByGroupId((current) => {
      const isExpanded = current.get(group.id) ?? false;
      // Prevent collapsing the group that contains the active item.
      if (isExpanded && groupContainsActive(group, activeId)) return current;
      const next = new Map(current);
      next.set(group.id, !isExpanded);
      return next;
    });
  }

  // ── Collapsed mode ───────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <View style={[styles.shell, styles.shellCollapsed]}>
        {/* S4 mark */}
        <View style={styles.collapsedBrand}>
          <Text style={styles.collapsedMark}>{brand.shortBrand}</Text>
        </View>

        <View style={styles.divider} />

        <ScrollView
          style={[styles.navScroll, IS_WEB && styles.navScrollWeb]}
          contentContainerStyle={styles.collapsedNavContent}
          showsVerticalScrollIndicator={false}
        >
          {groups.map((group, index) => (
            <View key={group.id}>
              {index > 0 ? <View style={styles.collapsedGroupDivider} /> : null}
              {group.itemIds
                .map((id) => itemById.get(id))
                .filter((item): item is NavItem<Id> => Boolean(item))
                .map((item) => {
                  const isActive = activeId === item.id;
                  return (
                    <Pressable
                      key={String(item.id)}
                      onPress={() => onNavigate(item.id)}
                      accessibilityRole="button"
                      accessibilityLabel={item.label}
                      accessibilityState={{ selected: isActive }}
                      style={({ hovered, pressed }: any) => [
                        styles.collapsedItem,
                        isActive    ? styles.collapsedItemActive   : null,
                        IS_WEB && hovered && !isActive ? styles.collapsedItemHover : null,
                        IS_WEB && pressed  ? styles.collapsedItemPressed : null,
                        IS_WEB ? (styles.cursorPointer as any) : null,
                      ]}
                    >
                      {isActive ? <View style={styles.collapsedActiveBar} /> : null}
                      <Feather
                        name={getNavFeatherIconName(String(item.id)) as any}
                        size={16}
                        color={isActive ? colors.accentTeal : 'rgba(226, 232, 240, 0.5)'}
                      />
                    </Pressable>
                  );
                })}
            </View>
          ))}
        </ScrollView>

        <View style={styles.divider} />

        {onToggleCollapse ? (
          <Pressable
            onPress={onToggleCollapse}
            accessibilityRole="button"
            accessibilityLabel="Expand navigation"
            style={({ pressed }: any) => [
              styles.toggleBtn,
              pressed ? styles.toggleBtnPressed : null,
              IS_WEB ? (styles.cursorPointer as any) : null,
            ]}
          >
            <Feather name="chevron-right" size={16} color="rgba(226, 232, 240, 0.45)" />
          </Pressable>
        ) : null}
      </View>
    );
  }

  // ── Expanded mode ────────────────────────────────────────────────────────
  return (
    <View style={styles.shell}>
      {/* Brand area */}
      <View style={styles.brand}>
        <Text style={styles.brandMark}>{brand.shortBrand}</Text>
        <Text style={styles.brandTagline}>{brand.tagline}</Text>
      </View>

      <View style={styles.divider} />

      {/* Navigation */}
      <ScrollView
        style={[styles.navScroll, IS_WEB && styles.navScrollWeb]}
        contentContainerStyle={styles.navScrollContent}
        showsVerticalScrollIndicator={false}
      >
        {groups.map((group) => {
          const isExpanded = expandedByGroupId.get(group.id) ?? false;
          const activeInGroup = groupContainsActive(group, activeId);

          return (
            <View key={group.id} style={styles.group}>
              <Pressable
                style={({ hovered }: any) => [
                  styles.groupHeader,
                  IS_WEB && hovered ? styles.groupHeaderHover : null,
                  IS_WEB ? (styles.cursorPointer as any) : null,
                ]}
                onPress={() => toggleGroup(group)}
                accessibilityRole="button"
                accessibilityLabel={`${group.title} navigation group`}
                accessibilityState={{ expanded: isExpanded }}
              >
                <Text style={styles.groupTitle}>{group.title.toUpperCase()}</Text>
                <Feather
                  name={isExpanded ? 'chevron-down' : 'chevron-right'}
                  size={12}
                  color="rgba(226, 232, 240, 0.4)"
                />
              </Pressable>

              {isExpanded ? (
                <View style={styles.groupItems}>
                  {group.itemIds
                    .map((id) => itemById.get(id))
                    .filter((item): item is NavItem<Id> => Boolean(item))
                    .map((item) => {
                      const isActive = activeId === item.id;
                      return (
                        <Pressable
                          key={String(item.id)}
                          onPress={() => onNavigate(item.id)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: isActive }}
                          accessibilityLabel={item.label}
                          style={({ hovered, pressed }: any) => [
                            styles.navItem,
                            isActive ? styles.navItemActive : null,
                            IS_WEB && hovered && !isActive ? styles.navItemHover   : null,
                            IS_WEB && pressed              ? styles.navItemPressed : null,
                            IS_WEB ? (styles.cursorPointer as any) : null,
                          ]}
                        >
                          {isActive ? <View style={styles.activeBar} /> : null}
                          <View style={styles.navLabelRow}>
                            <Feather
                              name={getNavFeatherIconName(String(item.id)) as any}
                              size={16}
                              color={isActive ? colors.accentTeal : 'rgba(226, 232, 240, 0.5)'}
                            />
                            <Text style={[styles.navLabel, isActive && styles.navLabelActive]} numberOfLines={1}>
                              {item.label}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                </View>
              ) : activeInGroup ? (
                <View style={styles.groupCollapsedHint}>
                  <Text style={styles.groupCollapsedHintText}>● Active</Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.divider} />

      {/* Collapse toggle */}
      {onToggleCollapse ? (
        <Pressable
          onPress={onToggleCollapse}
          accessibilityRole="button"
          accessibilityLabel="Collapse navigation"
          style={({ pressed }: any) => [
            styles.toggleBtn,
            styles.toggleBtnExpanded,
            pressed ? styles.toggleBtnPressed : null,
            IS_WEB ? (styles.cursorPointer as any) : null,
          ]}
        >
          <Feather name="chevron-left" size={16} color="rgba(226, 232, 240, 0.45)" />
          <Text style={styles.toggleLabel}>Collapse</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── Icon map ─────────────────────────────────────────────────────────────────

const NAV_FEATHER_ICONS: Record<string, string> = {
  'dashboard':        'grid',
  'live-operations':  'activity',
  'sites':            'map-pin',
  'clients':          'briefcase',
  'rota-planner':     'calendar',
  'shift-offers':     'send',
  'coverage':         'layers',
  'analytics':        'bar-chart-2',
  'guards':           'users',
  'availability':     'clock',
  'recruitment':      'user-plus',
  'weekly-approvals': 'check-square',
  'timesheets':       'file-text',
  'payroll':          'dollar-sign',
  'payroll-batches':  'package',
  'pay-rules':        'sliders',
  'invoices':         'file',
  'finance':          'trending-up',
  'finance-control':  'settings',
  'margins':          'percent',
  'contract-pricing': 'tag',
  'compliance':       'shield',
  'audit':            'list',
  'incidents':        'alert-triangle',
  'alerts':           'bell',
};

function getNavFeatherIconName(id: string): string {
  return NAV_FEATHER_ICONS[id] ?? 'circle';
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Shell ─────────────────────────────────────────────────────────────────
  shell: {
    flex: 1,
    paddingTop: 0,
    paddingBottom: 0,
  },
  shellCollapsed: {
    alignItems: 'center',
  },

  // ── Brand (expanded) ──────────────────────────────────────────────────────
  brand: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    gap: 4,
  },
  brandMark: {
    color: colors.accentTeal,
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1.5,
    lineHeight: 24,
  },
  brandTagline: {
    color: 'rgba(226, 232, 240, 0.45)',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.4,
    lineHeight: 14,
  },

  // ── Divider ───────────────────────────────────────────────────────────────
  divider: {
    height: 1,
    backgroundColor: 'rgba(226, 232, 240, 0.1)',
    marginHorizontal: 0,
  },

  // ── Nav scroll ────────────────────────────────────────────────────────────
  navScroll: {
    flex: 1,
  },
  navScrollWeb: {
    overflowY: 'auto',
    overflowX: 'hidden',
    scrollbarWidth: 'thin',
  } as any,
  navScrollContent: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },

  // ── Group (expanded) ──────────────────────────────────────────────────────
  group: {
    gap: 2,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 6,
    borderRadius: 0,
  },
  groupHeaderHover: {
    backgroundColor: 'rgba(148, 163, 184, 0.06)',
  },
  groupTitle: {
    color: 'rgba(226, 232, 240, 0.45)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    lineHeight: 16,
  },
  groupChevron: {
    color: 'rgba(226, 232, 240, 0.4)',
    fontSize: 11,
  },
  groupItems: {
    gap: 1,
    paddingHorizontal: 8,
  },
  groupCollapsedHint: {
    paddingHorizontal: 20,
    paddingVertical: 4,
  },
  groupCollapsedHintText: {
    color: colors.accentTeal,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // ── Nav item (expanded) ───────────────────────────────────────────────────
  navItem: {
    borderRadius: radii.sm,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 0,
    position: 'relative',
    overflow: 'hidden',
  },
  navItemActive: {
    backgroundColor: 'rgba(20, 184, 166, 0.12)',
  },
  navItemHover: {
    backgroundColor: 'rgba(148, 163, 184, 0.08)',
  },
  navItemPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
  },
  activeBar: {
    position: 'absolute',
    left: 0,
    top: 6,
    bottom: 6,
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.accentTeal,
  },
  navLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 4,
  },
  navIcon: {
    width: 16,
    textAlign: 'center',
    color: 'rgba(226, 232, 240, 0.5)',
    fontSize: 13,
    lineHeight: 18,
  },
  navIconActive: {
    color: colors.accentTeal,
  },
  navLabel: {
    color: 'rgba(226, 232, 240, 0.82)',
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
    letterSpacing: 0.1,
  },
  navLabelActive: {
    color: colors.accentTeal,
    fontWeight: '600',
  },

  // ── Collapsed brand ───────────────────────────────────────────────────────
  collapsedBrand: {
    width: 64,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapsedMark: {
    color: colors.accentTeal,
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 1,
  },

  // ── Collapsed nav ─────────────────────────────────────────────────────────
  collapsedNavContent: {
    paddingVertical: spacing.sm,
    alignItems: 'center',
    gap: 0,
  },
  collapsedGroupDivider: {
    width: 32,
    height: 1,
    backgroundColor: 'rgba(226, 232, 240, 0.1)',
    marginVertical: 4,
    alignSelf: 'center',
  },
  collapsedItem: {
    width: 64,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  collapsedItemActive: {
    backgroundColor: 'rgba(20, 184, 166, 0.12)',
  },
  collapsedItemHover: {
    backgroundColor: 'rgba(148, 163, 184, 0.08)',
  },
  collapsedItemPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
  },
  collapsedActiveBar: {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.accentTeal,
  },
  collapsedIcon: {
    color: 'rgba(226, 232, 240, 0.5)',
    fontSize: 14,
    lineHeight: 18,
    textAlign: 'center',
  },
  collapsedIconActive: {
    color: colors.accentTeal,
  },

  // ── Toggle button ─────────────────────────────────────────────────────────
  toggleBtn: {
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    paddingHorizontal: 12,
    gap: spacing.sm,
  },
  toggleBtnExpanded: {
    paddingHorizontal: 20,
    justifyContent: 'flex-start',
  },
  toggleBtnPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.1)',
  },
  toggleIcon: {
    color: 'rgba(226, 232, 240, 0.45)',
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 22,
  },
  toggleLabel: {
    color: 'rgba(226, 232, 240, 0.45)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },

  cursorPointer: { cursor: 'pointer' } as any,
});
