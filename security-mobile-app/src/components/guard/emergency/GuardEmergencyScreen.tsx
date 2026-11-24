import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../../../theme';
import { guardColors, guardFontFamily, guardShape } from '../../../theme/guard';
import { formatInstantTime } from '../../../services/siteTime';
import {
  EMERGENCY_999_NOTICE,
  EMERGENCY_COPY,
  EMERGENCY_MAX_FONT_MULTIPLIER,
  emergencyFailureView,
  emergencyFollowUp,
  emergencyReceivedView,
  emergencyScreenLayout,
  sendGuardEmergency,
  type EmergencyApi,
  type EmergencyFollowUp,
  type EmergencyReceipt,
  type EmergencyShift,
  type EmergencySubmitResult,
} from './guardEmergency';

/**
 * S4-EM-01 — the full-screen Emergency confirmation (two taps: the Emergency launcher, then SEND EMERGENCY).
 *
 * No typing, no description and no ScrollView: the whole screen is laid out to fit, with SEND EMERGENCY taking the space
 * that is left (never less than EMERGENCY_MIN_SEND_HEIGHT) and Cancel a separate full-width control at the bottom, in
 * thumb reach. All rules and words live in guardEmergency.ts.
 */
export interface GuardEmergencyScreenProps {
  visible: boolean;
  shift: EmergencyShift;
  timeZone?: string | null;
  api: EmergencyApi & { listMySafetyAlerts: () => Promise<Array<{ id: number; status?: string | null; acknowledgedAt?: string | null; closedAt?: string | null }>> };
  onClose: () => void;
  /** After S4 has received it: the dashboard records it on the Guard's timeline and refreshes. */
  onReceived?: (receipt: EmergencyReceipt) => void;
}

/** How often the received screen re-reads the alert to learn whether a person has acknowledged it. */
export const EMERGENCY_FOLLOW_UP_POLL_MS = 15_000;

type Phase = 'confirm' | 'sending' | 'result';

/** Text capped at EMERGENCY_MAX_FONT_MULTIPLIER, so the largest accessibility size still fits without scrolling. */
function T(props: { children?: React.ReactNode; style?: unknown; accessibilityRole?: string; accessibilityLiveRegion?: 'none' | 'polite' | 'assertive' }) {
  return <Text maxFontSizeMultiplier={EMERGENCY_MAX_FONT_MULTIPLIER} {...props} />;
}

export function GuardEmergencyScreen({ visible, shift, timeZone, api, onClose, onReceived }: GuardEmergencyScreenProps) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = emergencyScreenLayout(window);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [result, setResult] = useState<EmergencySubmitResult | null>(null);
  const [followUp, setFollowUp] = useState<EmergencyFollowUp>({ state: 'waiting' });
  // One request per press, whatever the renderer does with a fast double tap: state updates are not synchronous.
  const inFlight = useRef(false);

  useEffect(() => {
    if (visible) {
      setPhase('confirm');
      setResult(null);
      setFollowUp({ state: 'waiting' });
    }
  }, [visible]);

  const send = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase('sending');
    try {
      const outcome = await sendGuardEmergency(shift, api);
      setResult(outcome);
      setPhase('result');
      if (outcome.kind === 'received') onReceived?.(outcome.receipt);
    } finally {
      inFlight.current = false;
    }
  }, [api, onReceived, shift]);

  const receipt = result?.kind === 'received' ? result.receipt : null;

  // While the received screen is open, read the alert back so a real acknowledgement is shown when, and only when, it
  // happens. A failed read changes nothing on screen.
  useEffect(() => {
    if (!visible || !receipt) return undefined;
    let cancelled = false;
    const read = async () => {
      try {
        const mine = await api.listMySafetyAlerts();
        const alert = mine.find((a) => a.id === receipt.alertId);
        if (!cancelled && alert) setFollowUp(emergencyFollowUp(alert));
      } catch {
        // Keep what is shown.
      }
    };
    void read();
    const timer = setInterval(() => void read(), EMERGENCY_FOLLOW_UP_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, receipt, visible]);

  const time = (iso: string) => formatInstantTime(iso, timeZone ?? undefined);
  const close = () => { if (phase !== 'sending') onClose(); };
  const pad = {
    paddingTop: insets.top + layout.gutter,
    paddingBottom: insets.bottom + layout.gutter,
    paddingLeft: insets.left + layout.gutter,
    paddingRight: insets.right + layout.gutter,
  };

  let body: React.ReactNode;
  if (phase !== 'result' || !result) {
    const sending = phase === 'sending';
    body = (
      <>
        <View style={styles.head}>
          <T accessibilityRole="header" style={[styles.title, { fontSize: layout.titleSize, lineHeight: layout.titleSize + 6 }]}>{EMERGENCY_COPY.title}</T>
          <T style={styles.lead}>{EMERGENCY_COPY.confirmLead}</T>
          {!layout.compact ? <T style={styles.detail}>{EMERGENCY_COPY.confirmDetail}</T> : null}
        </View>
        <Pressable
          testID="guard-emergency-send"
          accessibilityRole="button"
          accessibilityLabel={EMERGENCY_COPY.sendAccessibility}
          accessibilityHint={EMERGENCY_COPY.sendHint}
          accessibilityState={{ disabled: sending, busy: sending }}
          disabled={sending}
          onPress={send}
          style={({ pressed }: { pressed: boolean }) => [styles.send, { minHeight: layout.sendMinHeight }, (pressed || sending) && styles.sendPressed]}
        >
          {sending ? <ActivityIndicator color="#FFFFFF" size="large" /> : null}
          <T style={[styles.sendText, { fontSize: layout.sendTextSize, lineHeight: layout.sendTextSize + 6 }]}>
            {sending ? EMERGENCY_COPY.sending : EMERGENCY_COPY.send}
          </T>
        </Pressable>
        <T style={styles.notice} accessibilityRole="text">{EMERGENCY_999_NOTICE}</T>
        <Pressable
          testID="guard-emergency-cancel"
          accessibilityRole="button"
          accessibilityLabel={EMERGENCY_COPY.cancelAccessibility}
          accessibilityState={{ disabled: sending }}
          disabled={sending}
          onPress={close}
          style={({ pressed }: { pressed: boolean }) => [styles.secondary, { minHeight: layout.cancelHeight }, pressed && styles.secondaryPressed, sending && styles.dimmed]}
        >
          <T style={styles.secondaryText}>{EMERGENCY_COPY.cancel}</T>
        </Pressable>
      </>
    );
  } else if (result.kind === 'received') {
    const view = emergencyReceivedView(result.receipt, followUp, time);
    body = (
      <>
        <View style={[styles.head, styles.flexHead]} testID="guard-emergency-received">
          <View style={[styles.badge, view.acknowledged ? styles.badgeAck : styles.badgeReceived]}>
            <T style={styles.badgeText}>{view.acknowledged ? 'ACKNOWLEDGED' : 'RECEIVED BY S4'}</T>
          </View>
          <T accessibilityRole="header" style={[styles.title, { fontSize: layout.titleSize, lineHeight: layout.titleSize + 6 }]}>{view.title}</T>
          <View accessibilityLiveRegion="assertive">
            {view.lines.map((line) => <Text key={line} maxFontSizeMultiplier={EMERGENCY_MAX_FONT_MULTIPLIER} style={styles.lead}>{line}</Text>)}
          </View>
        </View>
        <T style={styles.notice}>{view.notice}</T>
        <Pressable
          testID="guard-emergency-close"
          accessibilityRole="button"
          accessibilityLabel={EMERGENCY_COPY.close}
          onPress={close}
          style={({ pressed }: { pressed: boolean }) => [styles.secondary, { minHeight: layout.cancelHeight }, pressed && styles.secondaryPressed]}
        >
          <T style={styles.secondaryText}>{EMERGENCY_COPY.close}</T>
        </Pressable>
      </>
    );
  } else {
    const view = emergencyFailureView(result);
    body = (
      <>
        <View style={[styles.head, styles.flexHead]} testID="guard-emergency-not-sent">
          <View style={[styles.badge, styles.badgeFailed]}><T style={styles.badgeText}>NOT SENT</T></View>
          <T accessibilityRole="header" style={[styles.title, { fontSize: layout.titleSize, lineHeight: layout.titleSize + 6 }]}>{view.title}</T>
          <T style={styles.lead} accessibilityLiveRegion="assertive">{view.message}</T>
        </View>
        {view.canRetry ? (
          <Pressable
            testID="guard-emergency-retry"
            accessibilityRole="button"
            accessibilityLabel={EMERGENCY_COPY.tryAgainAccessibility}
            onPress={send}
            style={({ pressed }: { pressed: boolean }) => [styles.send, { minHeight: Math.round(layout.sendMinHeight * 0.75) }, pressed && styles.sendPressed]}
          >
            <T style={[styles.sendText, { fontSize: layout.sendTextSize, lineHeight: layout.sendTextSize + 6 }]}>{EMERGENCY_COPY.tryAgain}</T>
          </Pressable>
        ) : null}
        <Pressable
          testID="guard-emergency-close"
          accessibilityRole="button"
          accessibilityLabel={EMERGENCY_COPY.close}
          onPress={close}
          style={({ pressed }: { pressed: boolean }) => [styles.secondary, { minHeight: layout.cancelHeight }, pressed && styles.secondaryPressed]}
        >
          <T style={styles.secondaryText}>{EMERGENCY_COPY.close}</T>
        </Pressable>
      </>
    );
  }

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={close}>
      <View style={[styles.root, pad]} testID="guard-emergency-screen" accessibilityViewIsModal>
        {body}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: guardColors.surface, gap: 16 },
  head: { gap: 8 },
  flexHead: { flexGrow: 1, flexShrink: 1, justifyContent: 'center' },
  title: { color: guardColors.emergency, fontFamily: guardFontFamily.bold },
  lead: { color: guardColors.textPrimary, fontFamily: guardFontFamily.semibold, fontSize: 18, lineHeight: 24 },
  detail: { color: colors.textSecondary, fontSize: 15, lineHeight: 21 },
  // The one action: it takes the remaining height, flat Emergency red, white bold label.
  send: {
    flexGrow: 1,
    flexShrink: 1,
    borderRadius: guardShape.controlRadius * 2,
    backgroundColor: guardColors.emergency,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },
  sendPressed: { opacity: 0.85 },
  sendText: { color: '#FFFFFF', fontFamily: guardFontFamily.bold, textAlign: 'center', letterSpacing: 0.5 },
  notice: { color: guardColors.textPrimary, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  secondary: {
    borderRadius: guardShape.controlRadius,
    borderWidth: guardShape.outlineWidth,
    borderColor: guardColors.navy,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: guardColors.surface,
  },
  secondaryPressed: { backgroundColor: guardColors.canvas },
  secondaryText: { color: guardColors.navy, fontFamily: guardFontFamily.bold, fontSize: 18, lineHeight: 24 },
  dimmed: { opacity: 0.5 },
  badge: { alignSelf: 'flex-start', borderRadius: guardShape.statusRadius, paddingHorizontal: 10, paddingVertical: 4 },
  badgeReceived: { backgroundColor: guardColors.navy },
  badgeAck: { backgroundColor: colors.success },
  badgeFailed: { backgroundColor: guardColors.emergency },
  badgeText: { color: '#FFFFFF', fontFamily: guardFontFamily.bold, fontSize: 13, letterSpacing: 0.5 },
});
