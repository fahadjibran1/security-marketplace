import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { confirmWelfareCheck, requestWelfareHelp } from '../../services/api';
import { colors, radii, spacing } from '../../theme';
import {
  firstStep,
  helpErrorOutcome,
  helpOutcome,
  safeErrorOutcome,
  safeOutcome,
  type WelfareIntent,
  type WelfarePromptStep,
} from './welfarePush';

type Props = {
  intent: WelfareIntent;
  /** False when the Guard was signed out when the tap arrived, or had to sign in again since. */
  sessionLive: boolean;
  onClose: () => void;
};

/**
 * The Welfare Check confirmation screen a notification opens: one tap from the notification, never a walk through
 * the dashboard. Shows only what the server answered; nothing is recorded on the phone.
 */
export function WelfareCheckPrompt({ intent, sessionLive, onClose }: Props) {
  const [step, setStep] = useState<WelfarePromptStep>(() => firstStep(intent, sessionLive));
  const mounted = useRef(true);
  const started = useRef(false);
  useEffect(() => () => { mounted.current = false; }, []);

  const set = (next: WelfarePromptStep) => { if (mounted.current) setStep(next); };

  // reminderId === null asks for the CURRENT check (after a reminder expired).
  const submitSafe = async (reminderId: number | null) => {
    set({ step: 'submitting', what: 'safe' });
    try {
      set(safeOutcome(await confirmWelfareCheck({ shiftId: intent.shiftId, ...(reminderId ? { reminderId } : {}) })));
    } catch (error) {
      set(safeErrorOutcome(error as never));
    }
  };
  const submitHelp = async () => {
    set({ step: 'submitting', what: 'help' });
    try {
      set(helpOutcome(await requestWelfareHelp({ shiftId: intent.shiftId, ...(intent.reminderId ? { reminderId: intent.reminderId } : {}) })));
    } catch (error) {
      set(helpErrorOutcome(error as never));
    }
  };

  // I'm Safe tapped with a live session: the tap was the confirmation.
  useEffect(() => {
    if (step.step === 'submitting' && step.what === 'safe' && !started.current) {
      started.current = true;
      void submitSafe(intent.reminderId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={step.step === 'submitting' ? () => undefined : onClose}>
      <View style={styles.scrim}>
        <View style={styles.card} accessibilityViewIsModal>
          {step.step === 'confirm_safe' ? (
            <>
              <Text style={styles.title} accessibilityRole="header">S4 — Welfare Check</Text>
              <Text style={styles.body}>Please confirm that you are safe and on duty.</Text>
              {step.notice ? <Text style={styles.notice}>{step.notice}</Text> : null}
              <Button label="I'm Safe" tone="primary" onPress={() => void submitSafe(intent.reminderId)} />
              <Button label="Need Help" tone="danger" onPress={() => set({ step: 'confirm_help' })} />
              <Button label="Not now" tone="plain" onPress={onClose} />
            </>
          ) : step.step === 'confirm_help' ? (
            <>
              <Text style={styles.title} accessibilityRole="header">Request help?</Text>
              <Text style={styles.body}>This alerts your Control Room straight away. S4 does not contact the emergency services — if you are in immediate danger, call 999.</Text>
              <Button label="Request help now" tone="danger" onPress={() => void submitHelp()} />
              <Button label="Cancel" tone="plain" onPress={onClose} />
            </>
          ) : step.step === 'submitting' ? (
            <View style={styles.busy} accessibilityLiveRegion="polite">
              <ActivityIndicator color={colors.primaryNavy} />
              <Text style={styles.body}>{step.what === 'help' ? 'Alerting your Control Room…' : 'Recording your Welfare Check…'}</Text>
            </View>
          ) : (
            <>
              <Text style={[styles.title, step.tone === 'error' ? styles.titleError : step.tone === 'success' ? styles.titleSuccess : null]} accessibilityRole="header">
                {step.title}
              </Text>
              <Text style={styles.body} accessibilityLiveRegion="polite">{step.message}</Text>
              {step.offerCurrentCheck ? <Button label="Confirm current Welfare Check" tone="primary" onPress={() => void submitSafe(null)} /> : null}
              {step.retry === 'safe' ? <Button label="Try again" tone="primary" onPress={() => void submitSafe(intent.reminderId)} /> : null}
              {step.retry === 'help' ? <Button label="Try again" tone="danger" onPress={() => void submitHelp()} /> : null}
              <Button label="Close" tone="plain" onPress={onClose} />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function Button({ label, tone, onPress }: { label: string; tone: 'primary' | 'danger' | 'plain'; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => [styles.button, styles[tone], pressed && styles.pressed]}
    >
      <Text style={[styles.buttonText, tone === 'plain' ? styles.plainText : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(5, 22, 28, 0.55)', justifyContent: 'center', padding: spacing.lg },
  card: { backgroundColor: colors.card, borderRadius: radii.lg, padding: spacing.xl, gap: spacing.md, maxWidth: 480, width: '100%', alignSelf: 'center' },
  title: { fontSize: 20, fontWeight: '800', color: colors.textPrimary },
  titleError: { color: colors.danger },
  titleSuccess: { color: colors.success },
  body: { fontSize: 15, lineHeight: 21, color: colors.textPrimary },
  notice: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  busy: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg },
  button: { minHeight: 52, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  primary: { backgroundColor: colors.primaryNavy },
  danger: { backgroundColor: colors.danger },
  plain: { backgroundColor: 'transparent' },
  pressed: { opacity: 0.8 },
  buttonText: { fontSize: 17, fontWeight: '700', color: colors.textOnBrand },
  plainText: { color: colors.textSecondary, fontWeight: '600' },
});
