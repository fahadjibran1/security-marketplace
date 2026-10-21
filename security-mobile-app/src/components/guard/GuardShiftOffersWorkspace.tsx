import React, { useEffect, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  formatOfferDate,
  formatOfferTime,
  formatOfferWindow,
  shiftZone,
} from '../shifts/shiftOfferTime';
import { colors, control, radii, shadows, spacing } from '../../theme';
import { Shift } from '../../types/models';
import { StatePanel } from '../StatePanel';
import { AppModal } from '../ui/Modal';
import { OFFER_ENDED_LINE, OFFER_STARTED_LINE, offerTiming } from './offerTiming';

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

// Offer times are the SITE's wall clock, because that is the clock the Guard has to turn up against.
// The arithmetic lives in shiftOfferTime, shared with the Company surface and executed by
// scripts/shift-offer-time.spec.cjs; these two wrappers only carry this screen's "TBC" placeholder.

const offerZone = shiftZone;

function fmtDate(value: string | null | undefined, timeZone: string): string {
  return formatOfferDate(value, timeZone, 'TBC');
}

function fmtTimePair(start: string, end: string, timeZone: string): string {
  return formatOfferWindow(start, end, timeZone, { separator: ' – ', empty: 'TBC' });
}

function getUrgencyLine(startAt: string, endAt: string, nowMs: number, timeZone: string): string {
  const diffMs = new Date(startAt).getTime() - nowMs;
  if (!Number.isFinite(diffMs)) return '';
  const timing = offerTiming(startAt, endAt, nowMs);
  if (timing === 'ended') return OFFER_ENDED_LINE;
  if (timing === 'started') return OFFER_STARTED_LINE;
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
  return `Starts ${fmtDate(startAt, timeZone)}`;
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

  // An offer whose shift has ended cannot be accepted (the server refuses it too); Decline stays available.
  const selectedEnded = !!selectedOffer && offerTiming(selectedOffer.start, selectedOffer.end, liveNow) === 'ended';

  function handleAccept() {
    if (!selectedOffer || offerBusy || selectedEnded) return;
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
        <View style={styles.contentWrapper}>
          {/* Offer list */}
          <View style={styles.listSection}>
            {offers.length > 0 ? (
              <Text style={styles.listHeading}>
                {`${offers.length} shift offer${offers.length === 1 ? '' : 's'}`}
              </Text>
            ) : null}

            {offers.length === 0 ? (
              <StatePanel
                title="No shift offers"
                message="You don't have any shifts waiting for a response. Accepted shifts appear on Home."
                actionLabel="Refresh"
                onAction={onRefresh}
              />
            ) : (
              offers.map((offer, index) => {
                const zone = offerZone(offer);
                const urgency = getUrgencyLine(offer.start, offer.end, liveNow, zone);
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
                      <Text style={styles.offerDate}>{fmtDate(offer.start, zone)}</Text>
                      <Text style={styles.offerTime}>{fmtTimePair(offer.start, offer.end, zone)}</Text>
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
        </View>
      </ScrollView>

      {/*
        ── Offer detail ───────────────────────────────────────────────────────
        Hosted in AppModal, a real RNModal, for the same reason as the Guard action forms. This was an
        absolutely-positioned backdrop and sheet inside this workspace, and the workspace sits inside the
        dashboard's ScrollView, so the sheet was anchored to the bottom of the whole offer LIST rather than
        the screen. With more offers than fit on screen, the backdrop greyed the visible list while Accept
        and Decline were laid out below the fold, behind the bottom navigation: a Guard saw a grey overlay
        and no way to respond. AppModal is positioned against the window and keeps its footer outside the
        scrolling body, so the actions are on screen whatever the list length, scroll position or text size.
      */}
      <AppModal
        visible={selectedOffer !== null}
        onClose={() => {
          if (!offerBusy) closeDetail();
        }}
        closeOnBackdrop={!offerBusy}
        title="Shift offer"
        footer={selectedOffer ? (showDeclineConfirm ? (
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
              style={[styles.acceptBtn, (offerBusy || selectedEnded) && styles.btnDisabled]}
              onPress={handleAccept}
              disabled={offerBusy || selectedEnded}
              accessibilityRole="button"
              accessibilityLabel={selectedEnded ? 'Offer expired: this shift has ended' : 'Accept this shift'}
              accessibilityHint={selectedEnded ? 'This shift has ended and can no longer be accepted' : 'Accepts the offer and moves the shift to your Home tab'}
            >
              <Text style={styles.acceptBtnText}>
                {selectedEnded ? 'Offer expired' : offerBusy && offerRespondAction === 'accepted' ? 'Accepting…' : 'Accept Shift'}
              </Text>
            </Pressable>
          </View>
        )) : null}
      >
        {selectedOffer ? (
          <View style={styles.detailBody}>
            {/* WHERE / WHEN */}
            <View style={styles.detailHero}>
              <Text style={styles.detailSite}>{selectedOffer.siteName}</Text>
              <Text style={styles.detailDate}>{fmtDate(selectedOffer.start, offerZone(selectedOffer))}</Text>
              <Text style={styles.detailTime}>
                {fmtTimePair(selectedOffer.start, selectedOffer.end, offerZone(selectedOffer))}
              </Text>
              {(() => {
                const u = getUrgencyLine(selectedOffer.start, selectedOffer.end, liveNow, offerZone(selectedOffer));
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
          </View>
        ) : null}
      </AppModal>
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
    alignItems: 'center',
  },

  // Desktop max-width wrapper — centres content on wide viewports; full-width on mobile
  contentWrapper: {
    width: '100%',
    maxWidth: 840,
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

  // Detail body (inside AppModal's scrolling body)
  detailBody: {
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

  // Actions — AppModal's footer, outside its scrolling body, supplies the padding and top border
  actions: {
    flex: 1,
    gap: spacing.sm,
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
