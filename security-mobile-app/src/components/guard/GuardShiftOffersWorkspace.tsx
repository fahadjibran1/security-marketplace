import React, { useEffect, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, control, radii, shadows, spacing } from '../../theme';
import { Shift } from '../../types/models';
import { StatePanel } from '../StatePanel';

export interface GuardShiftOffersWorkspaceProps {
  offers: Shift[];
  respondingShiftId: number | null;
  offerRespondAction: 'accepted' | 'rejected' | null;
  /** Parent's certified handler — resolves after reload; errors are surfaced by parent */
  onRespond: (shiftId: number, response: 'accepted' | 'rejected') => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** Shared liveNow tick from GuardDashboardScreen — drives urgency labels without per-offer timers */
  liveNow: number;
  /** Initial offer to open in detail (from Home "Review Offer" CTA) */
  initialSelectedOfferId?: number | null;
  onInitialSelectedHandled?: () => void;
}

// ── Local date/time helpers ────────────────────────────────────────────────

function getLiteralParts(value?: string | null) {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return { year: m[1], month: m[2], day: m[3], hour: m[4] ?? null, minute: m[5] ?? null };
}

function fmtDate(value?: string | null): string {
  if (!value) return 'TBC';
  const p = getLiteralParts(value);
  if (p) {
    return new Date(Number(p.year), Number(p.month) - 1, Number(p.day)).toLocaleDateString(
      undefined,
      { weekday: 'short', day: '2-digit', month: 'short' },
    );
  }
  return new Date(value).toLocaleDateString(undefined, {
    weekday: 'short', day: '2-digit', month: 'short',
  });
}

function fmtTime(value?: string | null): string {
  if (!value) return 'TBC';
  const p = getLiteralParts(value);
  if (p?.hour && p?.minute) return `${p.hour}:${p.minute}`;
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtTimePair(start: string, end: string): string {
  // Detect overnight: end date > start date (ISO comparison)
  const startDate = start.slice(0, 10);
  const endDate = end.slice(0, 10);
  const suffix = endDate > startDate ? ' (+1)' : '';
  return `${fmtTime(start)} – ${fmtTime(end)}${suffix}`;
}

function getUrgencyLine(startAt: string, nowMs: number): string {
  const diffMs = new Date(startAt).getTime() - nowMs;
  if (!Number.isFinite(diffMs)) return '';
  if (diffMs <= 0) return 'Start time passed — contact control before accepting.';
  const h = 3_600_000;
  const d = 86_400_000;
  if (diffMs < h) {
    const m = Math.ceil(diffMs / 60_000);
    return `Starts in ${m} min`;
  }
  if (diffMs < 12 * h) return 'Starts today';
  if (diffMs < 24 * h) return 'Starts today';
  if (diffMs < 2 * d) return 'Starts tomorrow';
  const days = Math.ceil(diffMs / d);
  if (days <= 7) return `Starts in ${days} days`;
  return `Starts ${fmtDate(startAt)}`;
}

function isUrgent(startAt: string, nowMs: number): boolean {
  const diffMs = new Date(startAt).getTime() - nowMs;
  return diffMs <= 0 || diffMs < 24 * 3_600_000;
}

// ── Component ──────────────────────────────────────────────────────────────

export function GuardShiftOffersWorkspace({
  offers,
  respondingShiftId,
  offerRespondAction,
  onRespond,
  onRefresh,
  refreshing,
  liveNow,
  initialSelectedOfferId,
  onInitialSelectedHandled,
}: GuardShiftOffersWorkspaceProps) {
  const [selectedOfferId, setSelectedOfferId] = useState<number | null>(null);
  const [showDeclineConfirm, setShowDeclineConfirm] = useState(false);

  // Open specific offer when navigated from Home "Review Offer" CTA
  useEffect(() => {
    if (initialSelectedOfferId && offers.find((o) => o.id === initialSelectedOfferId)) {
      setSelectedOfferId(initialSelectedOfferId);
      setShowDeclineConfirm(false);
      onInitialSelectedHandled?.();
    }
  }, [initialSelectedOfferId]);

  // Auto-close detail when selected offer leaves the list (after respond)
  useEffect(() => {
    if (selectedOfferId && !offers.find((o) => o.id === selectedOfferId)) {
      setSelectedOfferId(null);
      setShowDeclineConfirm(false);
    }
  }, [offers, selectedOfferId]);

  const selectedOffer = selectedOfferId
    ? (offers.find((o) => o.id === selectedOfferId) ?? null)
    : null;
  const offerBusy = selectedOffer ? respondingShiftId === selectedOffer.id : false;

  function openDetail(shiftId: number) {
    setSelectedOfferId(shiftId);
    setShowDeclineConfirm(false);
  }

  function closeDetail() {
    setSelectedOfferId(null);
    setShowDeclineConfirm(false);
  }

  function handleAccept() {
    if (!selectedOffer || offerBusy) return;
    onRespond(selectedOffer.id, 'accepted');
  }

  function handleDeclinePress() {
    if (!selectedOffer || offerBusy) return;
    setShowDeclineConfirm(true);
  }

  function handleDeclineConfirm() {
    if (!selectedOffer || offerBusy) return;
    setShowDeclineConfirm(false);
    onRespond(selectedOffer.id, 'rejected');
  }

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentTeal}
          />
        }
      >
        {/* Context strip */}
        <View style={styles.contextStrip}>
          <Text style={styles.contextLabel}>How this works</Text>
          <Text style={styles.contextBody}>
            Invitations land here before they are on your roster. Decide offers here so control always knows your answer.
          </Text>
        </View>

        {/* Offer list */}
        <View style={styles.listSection}>
          <Text style={styles.listHeading}>
            {offers.length === 0
              ? 'No shift offers'
              : `${offers.length} open invitation${offers.length === 1 ? '' : 's'}`}
          </Text>

          {offers.length === 0 ? (
            <StatePanel
              title="No shift offers"
              message="You don't have any shifts waiting for a response. Accepted shifts appear on Home."
              actionLabel="Refresh"
              onAction={onRefresh}
            />
          ) : (
            offers.map((offer, index) => {
              const urgency = getUrgencyLine(offer.start, liveNow);
              const urgent = isUrgent(offer.start, liveNow);
              return (
                <View
                  key={offer.id}
                  style={[styles.offerCard, index === 0 && styles.offerCardFirst]}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={`Shift offer at ${offer.siteName}`}
                  accessibilityHint="Tap Review offer to see full details and accept or decline"
                >
                  <View style={styles.offerInfo}>
                    <Text style={styles.offerSite} numberOfLines={2}>
                      {offer.siteName}
                    </Text>
                    <Text style={styles.offerDate}>{fmtDate(offer.start)}</Text>
                    <Text style={styles.offerTime}>{fmtTimePair(offer.start, offer.end)}</Text>
                    {urgency ? (
                      <Text style={[styles.offerUrgency, urgent && styles.offerUrgencyAlert]}>
                        {urgency}
                      </Text>
                    ) : null}
                  </View>
                  <Pressable
                    style={styles.reviewBtn}
                    onPress={() => openDetail(offer.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Review offer for ${offer.siteName}`}
                    accessibilityHint="Opens full offer detail with Accept and Decline"
                  >
                    <Text style={styles.reviewBtnText}>Review offer</Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </View>

        {/* After-accept guidance */}
        <View style={styles.footer}>
          <Text style={styles.footerLabel}>
            {offers.length > 0 ? 'After you accept' : 'Where to go next'}
          </Text>
          <Text style={styles.footerBody}>
            {offers.length > 0
              ? 'The shift moves to Home — check in from there when you are on site. Declining removes the post from this list so the company can re-cover.'
              : 'Home shows your next booked or live shift. History holds finished shifts and timesheets.'}
          </Text>
        </View>
      </ScrollView>

      {/* ── Offer detail bottom sheet ─────────────────────────────────────── */}
      {selectedOffer ? (
        <View style={styles.sheetBackdrop}>
          <Pressable
            style={styles.sheetBackdropTap}
            onPress={closeDetail}
            accessibilityLabel="Close offer detail"
            accessibilityRole="button"
          />
          <View style={styles.sheet}>
            {/* Sheet drag handle (visual) */}
            <View style={styles.sheetHandle} />

            {/* Sheet header */}
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetHeaderEyebrow}>SHIFT OFFER</Text>
              <Pressable
                style={styles.sheetCloseBtn}
                onPress={closeDetail}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Text style={styles.sheetCloseBtnText}>Close</Text>
              </Pressable>
            </View>

            {/* Scrollable detail body */}
            <ScrollView
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetScrollContent}
              showsVerticalScrollIndicator={false}
            >
              {/* WHERE / WHEN */}
              <View style={styles.detailHero}>
                <Text style={styles.detailSite}>{selectedOffer.siteName}</Text>
                <Text style={styles.detailDate}>{fmtDate(selectedOffer.start)}</Text>
                <Text style={styles.detailTime}>
                  {fmtTimePair(selectedOffer.start, selectedOffer.end)}
                </Text>
                {(() => {
                  const u = getUrgencyLine(selectedOffer.start, liveNow);
                  const urgent = isUrgent(selectedOffer.start, liveNow);
                  return u ? (
                    <Text style={[styles.detailUrgency, urgent && styles.detailUrgencyAlert]}>
                      {u}
                    </Text>
                  ) : null;
                })()}
              </View>

              {/* INSTRUCTIONS */}
              <View style={styles.detailSection}>
                <Text style={styles.detailSectionLabel}>INSTRUCTIONS</Text>
                <Text style={styles.detailSectionBody}>
                  {selectedOffer.instructions?.trim() || 'No additional shift instructions.'}
                </Text>
              </View>

              {/* CHECK CALLS */}
              {selectedOffer.checkCallIntervalMinutes &&
              selectedOffer.checkCallIntervalMinutes > 0 ? (
                <View style={styles.detailSection}>
                  <Text style={styles.detailSectionLabel}>CHECK CALLS</Text>
                  <Text style={styles.detailSectionBody}>
                    Every {selectedOffer.checkCallIntervalMinutes} minutes
                  </Text>
                </View>
              ) : null}
            </ScrollView>

            {/* ── Actions ───────────────────────────────────────────────── */}
            {showDeclineConfirm ? (
              <View style={styles.actions}>
                <View style={styles.declineConfirmBlock}>
                  <Text style={styles.declineConfirmTitle}>Decline this shift?</Text>
                  <Text style={styles.declineConfirmBody}>
                    You will no longer be assigned to this offer and the company will need to arrange cover.
                  </Text>
                </View>
                <View style={styles.actionRow}>
                  <Pressable
                    style={[styles.keepBtn, offerBusy && styles.btnDisabled]}
                    onPress={() => setShowDeclineConfirm(false)}
                    disabled={offerBusy}
                    accessibilityRole="button"
                    accessibilityLabel="Keep offer"
                    accessibilityHint="Dismiss decline confirmation and keep the offer open"
                  >
                    <Text style={styles.keepBtnText}>Keep Offer</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.declineConfirmBtn, offerBusy && styles.btnDisabled]}
                    onPress={handleDeclineConfirm}
                    disabled={offerBusy}
                    accessibilityRole="button"
                    accessibilityLabel="Confirm decline"
                    accessibilityHint="Permanently declines this shift offer"
                  >
                    <Text style={styles.declineConfirmBtnText}>
                      {offerBusy && offerRespondAction === 'rejected' ? 'Declining…' : 'Decline Shift'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.actions}>
                <Pressable
                  style={[styles.declineBtn, offerBusy && styles.btnDisabled]}
                  onPress={handleDeclinePress}
                  disabled={offerBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Decline this shift offer"
                  accessibilityHint="Shows a confirmation before declining"
                >
                  <Text style={styles.declineBtnText}>
                    {offerBusy && offerRespondAction === 'rejected' ? 'Declining…' : 'Decline'}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.acceptBtn, offerBusy && styles.btnDisabled]}
                  onPress={handleAccept}
                  disabled={offerBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Accept this shift"
                  accessibilityHint="Accepts the offer and moves the shift to your Home tab"
                >
                  <Text style={styles.acceptBtnText}>
                    {offerBusy && offerRespondAction === 'accepted' ? 'Accepting…' : 'Accept Shift'}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },

  // Context strip
  contextStrip: {
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.infoSurface,
    borderWidth: 1,
    borderColor: colors.infoBorder,
    gap: spacing.xs,
  },
  contextLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.info,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  contextBody: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.textPrimary,
    fontWeight: '500',
  },

  // List section
  listSection: {
    gap: spacing.md,
  },
  listHeading: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },

  // Offer card
  offerCard: {
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
    marginTop: spacing.sm,
  },
  offerCardFirst: {
    marginTop: 0,
  },
  offerInfo: {
    gap: spacing.xs,
  },
  offerSite: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.textPrimary,
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  offerDate: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textSecondary,
    marginTop: 2,
  },
  offerTime: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  offerUrgency: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.warning,
  },
  offerUrgencyAlert: {
    color: colors.danger,
    fontWeight: '700',
  },

  // Review button
  reviewBtn: {
    alignSelf: 'stretch',
    minHeight: control.buttonHeightMd,
    borderRadius: radii.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accentTeal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  reviewBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.accentTeal,
    letterSpacing: 0.1,
  },

  // Footer
  footer: {
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  footerLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  footerBody: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.textSecondary,
    fontWeight: '500',
  },

  // Bottom sheet backdrop
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(11,27,43,0.46)',
    justifyContent: 'flex-end',
    zIndex: 20,
  },
  sheetBackdropTap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },

  // Bottom sheet
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '84%',
    ...shadows.elevated,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetHeaderEyebrow: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sheetCloseBtn: {
    minHeight: control.buttonHeightSm,
    minWidth: 60,
    borderRadius: radii.sm,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  sheetCloseBtnText: {
    color: colors.supportBlue,
    fontWeight: '700',
    fontSize: 14,
  },

  // Detail scroll body
  sheetScroll: {
    flexShrink: 1,
  },
  sheetScrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.lg,
  },

  // Detail hero
  detailHero: {
    gap: spacing.xs,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  detailSite: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.textPrimary,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  detailDate: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textSecondary,
    marginTop: 4,
  },
  detailTime: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  detailUrgency: {
    marginTop: spacing.xs,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
    color: colors.warning,
  },
  detailUrgencyAlert: {
    color: colors.danger,
    fontWeight: '700',
  },

  // Detail section (INSTRUCTIONS, CHECK CALLS)
  detailSection: {
    gap: spacing.xs,
  },
  detailSectionLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  detailSectionBody: {
    fontSize: 14,
    lineHeight: 22,
    color: colors.textPrimary,
    fontWeight: '500',
  },

  // Actions area (pinned at sheet bottom)
  actions: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },

  // Decline confirmation
  declineConfirmBlock: {
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  declineConfirmTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  declineConfirmBody: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.textSecondary,
    fontWeight: '500',
  },

  // Keep Offer button
  keepBtn: {
    flex: 1,
    minHeight: control.buttonHeight,
    borderRadius: radii.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  keepBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
  },

  // Decline Shift (confirmation) button
  declineConfirmBtn: {
    flex: 1,
    minHeight: control.buttonHeight,
    borderRadius: radii.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  declineConfirmBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.danger,
  },

  // Decline (initial) button — outline
  declineBtn: {
    alignSelf: 'stretch',
    minHeight: control.buttonHeightMd,
    borderRadius: radii.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  declineBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textSecondary,
  },

  // Accept Shift button — primary
  acceptBtn: {
    alignSelf: 'stretch',
    minHeight: control.buttonHeight,
    borderRadius: radii.lg,
    backgroundColor: colors.primaryNavy,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    ...shadows.raised,
  },
  acceptBtnText: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.textOnBrand,
    letterSpacing: 0.2,
  },

  btnDisabled: {
    opacity: 0.65,
  },
});
