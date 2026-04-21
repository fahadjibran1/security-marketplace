import * as React from 'react';
import { Image, ImageSourcePropType, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

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
  title: string;
  subtitle?: string;
  /** Optional mark (e.g. S4); may be combined with `subtitle` for logo + wordmark. */
  brandLogo?: ImageSourcePropType;
  description?: string;
  activeId: Id;
  navItems: Array<NavItem<Id>>;
  groups: Array<NavGroup<Id>>;
  onNavigate: (id: Id) => void;
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
  title,
  subtitle,
  brandLogo,
  description,
  activeId,
  navItems,
  groups,
  onNavigate,
}: CompanySidebarProps<Id>) {
  const isWeb = typeof document !== 'undefined';
  const itemById = React.useMemo(() => buildItemByIdMap(navItems), [navItems]);

  const initialExpanded = React.useMemo(() => {
    const expanded = new Map<string, boolean>();
    groups.forEach((group, index) => {
      const shouldExpand = groupContainsActive(group, activeId) || index === 0;
      expanded.set(group.id, shouldExpand);
    });
    return expanded;
  }, [activeId, groups]);

  const [expandedByGroupId, setExpandedByGroupId] = React.useState<Map<string, boolean>>(initialExpanded);

  React.useEffect(() => {
    const activeGroup = groups.find((group) => groupContainsActive(group, activeId));
    if (!activeGroup) return;

    setExpandedByGroupId((current) => {
      const currentValue = current.get(activeGroup.id);
      if (currentValue) return current;
      const next = new Map(current);
      next.set(activeGroup.id, true);
      return next;
    });
  }, [activeId, groups]);

  function toggleGroup(group: NavGroup<Id>) {
    setExpandedByGroupId((current) => {
      const isExpanded = current.get(group.id) ?? false;
      if (isExpanded && groupContainsActive(group, activeId)) {
        return current;
      }
      const next = new Map(current);
      next.set(group.id, !isExpanded);
      return next;
    });
  }

  return (
    <View style={styles.shell}>
      <View style={styles.header}>
        {brandLogo ? (
          <Image source={brandLogo} style={styles.brandLogoImage} resizeMode="contain" accessibilityLabel="S4 Security" />
        ) : null}
        {subtitle ? <Text style={styles.brandEyebrow}>{subtitle}</Text> : null}
        <Text style={styles.brandTitle}>{title}</Text>
        {description ? <Text style={styles.brandCopy}>{description}</Text> : null}
      </View>

      <View style={styles.divider} />

      <ScrollView
        style={[styles.navScroll, isWeb && styles.navScrollWeb]}
        contentContainerStyle={styles.navScrollContent}
        showsVerticalScrollIndicator
      >
        {groups.map((group) => {
          const isExpanded = expandedByGroupId.get(group.id) ?? false;
          const activeInGroup = groupContainsActive(group, activeId);

          return (
            <View key={group.id} style={styles.group}>
              <Pressable style={styles.groupHeader} onPress={() => toggleGroup(group)}>
                <Text style={styles.groupTitle}>{group.title}</Text>
                <Text style={styles.groupChevron}>{isExpanded ? '▾' : '▸'}</Text>
              </Pressable>

              {isExpanded ? (
                <View style={styles.groupItems}>
                  {group.itemIds
                    .map((id) => itemById.get(id))
                    .filter((item): item is NavItem<Id> => Boolean(item))
                    .map((item) => (
                      <Pressable
                        key={item.id}
                        style={({ hovered, pressed }: any) => [
                          styles.navItem,
                          hovered ? styles.navItemHover : null,
                          pressed ? styles.navItemPressed : null,
                          activeId === item.id ? styles.navItemActive : null,
                        ]}
                        onPress={() => onNavigate(item.id)}
                      >
                        <View style={styles.navLabelRow}>
                          <Text style={styles.navIcon} aria-hidden>
                            {getNavIcon(String(item.id))}
                          </Text>
                          <Text style={[styles.navLabel, activeId === item.id && styles.navLabelActive]}>{item.label}</Text>
                        </View>
                        <Text style={[styles.navCaption, activeId === item.id && styles.navCaptionActive]}>{item.caption}</Text>
                      </Pressable>
                    ))}
                </View>
              ) : activeInGroup ? (
                <View style={styles.groupCollapsedActiveHint}>
                  <Text style={styles.groupCollapsedActiveHintText}>Active page is in this section.</Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function getNavIcon(id: string) {
  switch (id) {
    case 'dashboard':
      return '🎛️';
    case 'live-operations':
      return '🟢';
    case 'sites':
      return '📍';
    case 'clients':
      return '🏢';
    case 'rota-planner':
      return '🗓️';
    case 'shift-offers':
      return '📨';
    case 'coverage':
      return '🧭';
    case 'analytics':
      return '📈';
    case 'guards':
      return '🛡️';
    case 'availability':
      return '🕒';
    case 'recruitment':
      return '🧲';
    case 'timesheets':
      return '⏱️';
    case 'payroll':
      return '💳';
    case 'payroll-batches':
      return '🧾';
    case 'pay-rules':
      return '🧮';
    case 'invoices':
      return '🧾';
    case 'finance':
      return '💰';
    case 'finance-control':
      return '🧮';
    case 'margins':
      return '📊';
    case 'contract-pricing':
      return '🏷️';
    case 'compliance':
      return '✅';
    case 'audit':
      return '🕵️';
    case 'incidents':
      return '🚨';
    case 'alerts':
      return '🔔';
    default:
      return '•';
  }
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 12,
    gap: 10,
  },
  header: {
    gap: 8,
  },
  brandLogoImage: {
    height: 32,
    width: 120,
    alignSelf: 'flex-start',
    marginBottom: 2,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(226, 232, 240, 0.14)',
  },
  brandEyebrow: {
    color: '#7dd3fc',
    fontSize: 12,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  brandTitle: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '800',
  },
  brandCopy: {
    color: '#cbd5e1',
    fontSize: 13,
    lineHeight: 18,
  },
  navScroll: {
    flex: 1,
  },
  navScrollWeb: {
    overflowY: 'auto',
    overflowX: 'hidden',
    scrollbarWidth: 'thin',
  } as any,
  navScrollContent: {
    paddingTop: 8,
    paddingBottom: 24,
    gap: 14,
  },
  group: {
    gap: 10,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  groupTitle: {
    color: 'rgba(226, 232, 240, 0.82)',
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontWeight: '800',
  },
  groupChevron: {
    color: 'rgba(226, 232, 240, 0.65)',
    fontSize: 14,
    fontWeight: '700',
  },
  groupItems: {
    gap: 8,
  },
  groupCollapsedActiveHint: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(148, 163, 184, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(226, 232, 240, 0.12)',
  },
  groupCollapsedActiveHintText: {
    color: 'rgba(226, 232, 240, 0.82)',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  navItem: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: 'rgba(148, 163, 184, 0.08)',
    gap: 3,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.04)',
  },
  navItemHover: {
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
  navItemPressed: {
    backgroundColor: 'rgba(148, 163, 184, 0.16)',
  },
  navItemActive: {
    backgroundColor: '#e0f2fe',
    borderColor: 'rgba(14, 116, 144, 0.25)',
  },
  navLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  navIcon: {
    width: 18,
    textAlign: 'center',
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '800',
  },
  navLabel: {
    color: '#f8fafc',
    fontWeight: '800',
    fontSize: 15,
  },
  navLabelActive: {
    color: '#0f172a',
  },
  navCaption: {
    color: '#cbd5e1',
    fontSize: 12,
    lineHeight: 16,
  },
  navCaptionActive: {
    color: '#334155',
  },
});

