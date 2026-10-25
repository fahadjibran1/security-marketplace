import React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing } from '../../theme';
import { StatePanel } from '../StatePanel';
import { notificationText, notificationTime, type InboxAvailability, type InboxItem } from './guardInbox';

export interface GuardNotificationsInboxProps {
  items: InboxItem[];
  availability: InboxAvailability;
  /** Why the last list read failed, when it did. The last list stays on screen. */
  problem: string | null;
  /** A non-blocking note, e.g. a read that could not be saved. */
  notice: string | null;
  onDismissNotice: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (item: InboxItem) => void;
  nowMs: number;
}

/** The Guard's notifications, newest first. Tapping a row marks it read and opens where it leads, if anywhere. */
export function GuardNotificationsInbox({ items, availability, problem, notice, onDismissNotice, refreshing, onRefresh, onOpen, nowMs }: GuardNotificationsInboxProps) {
  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accentTeal} />}
      >
        {notice ? (
          <Pressable
            style={styles.notice}
            onPress={onDismissNotice}
            accessibilityRole="button"
            accessibilityLabel={`${notice} Tap to dismiss.`}
          >
            <Text style={styles.noticeText}>{notice}</Text>
          </Pressable>
        ) : null}

        {availability === 'unavailable' ? (
          <StatePanel title="Notifications not available yet" message={problem ?? undefined} tone="info" />
        ) : availability === 'loading' && items.length === 0 ? (
          <StatePanel title="Loading notifications" message="Fetching your latest shift updates." tone="info" loading />
        ) : availability === 'error' && items.length === 0 ? (
          <StatePanel title="Could not load notifications" message={problem ?? undefined} tone="error" actionLabel="Retry" onAction={onRefresh} />
        ) : items.length === 0 ? (
          <StatePanel
            title="No notifications"
            message="Shift offers, changes and extension requests will appear here."
            actionLabel="Refresh"
            onAction={onRefresh}
          />
        ) : (
          <>
            {availability === 'error' && problem ? <Text style={styles.staleLine}>{problem}</Text> : null}
            {items.map((item) => {
              const text = notificationText(item);
              const unread = item.status === 'unread';
              const when = notificationTime(item.createdAt, nowMs);
              return (
                <Pressable
                  key={item.id}
                  onPress={() => onOpen(item)}
                  style={({ pressed }: { pressed: boolean }) => [styles.row, unread && styles.rowUnread, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`${unread ? 'Unread. ' : ''}${text.title}. ${text.message}${when ? `. ${when}` : ''}`}
                  accessibilityHint={unread ? 'Marks it read and opens it' : 'Opens it'}
                >
                  <View style={styles.rowHead}>
                    {unread ? <View style={styles.dot} /> : null}
                    <Text style={[styles.title, unread && styles.titleUnread]} numberOfLines={2}>{text.title}</Text>
                  </View>
                  {text.message ? <Text style={styles.message}>{text.message}</Text> : null}
                  {when ? <Text style={styles.time}>{when}</Text> : null}
                </Pressable>
              );
            })}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxl, gap: spacing.sm },
  notice: { backgroundColor: colors.warningSurface, borderWidth: 1, borderColor: colors.warningBorder, borderRadius: radii.md, padding: spacing.md },
  noticeText: { color: colors.textPrimary, fontSize: 13 },
  staleLine: { color: colors.textSecondary, fontSize: 13 },
  row: { borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: spacing.md, gap: 4, minHeight: 56 },
  rowUnread: { borderColor: colors.accentTeal, backgroundColor: colors.accentTealSoft },
  pressed: { opacity: 0.8 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 999, backgroundColor: colors.accentTealStrong },
  title: { flex: 1, color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  titleUnread: { fontWeight: '800' },
  message: { color: colors.textPrimary, fontSize: 14 },
  time: { color: colors.textSecondary, fontSize: 12 },
});
