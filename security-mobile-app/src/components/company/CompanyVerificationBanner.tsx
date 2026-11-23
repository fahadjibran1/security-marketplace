import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { FieldInput, FieldTextarea, FormField } from '../ui/FormField';
import {
  companyNotApprovedMessage, formatApiErrorMessage, getMyCompany, getMyCompanyVerification, onCompanyNotApproved, requestCompanyReconsideration,
  updateMyCompany, type OwnCompanyVerification,
} from '../../services/api';
import {
  VERIFICATION_REASON_MAX, companyVerificationBanner, type VerificationTone,
} from '../../navigation/company-verification';

type Props = {
  /** company.manage (owner / admin): may correct registration details and ask S4 to reconsider. Display only. */
  canManageCompany: boolean;
};

type Details = { name: string; companyNumber: string; address: string; contactDetails: string };

const TONE: Record<VerificationTone, { surface: string; border: string; ink: string }> = {
  info: { surface: colors.infoSurface, border: colors.infoBorder, ink: colors.info },
  success: { surface: colors.successSurface, border: colors.successBorder, ink: colors.success },
  warning: { surface: colors.warningSurface, border: colors.warningBorder, ink: colors.warning },
  danger: { surface: colors.dangerSurface, border: colors.dangerBorder, ink: colors.danger },
};

/**
 * S4-CV-01 company portal: the company's verification state, shown on every page until S4 approves it.
 *
 * Pending: what can be set up now and what waits for approval. Rejected: S4's reason, correcting the registration
 * details and asking S4 to reconsider. Suspended: S4's reason, what keeps working (safety, existing work) and support
 * guidance. It also listens for every 403 COMPANY_NOT_APPROVED refusal in the app and refreshes itself, so a refused
 * action always lands next to the explanation. Nothing here disables any control: the backend decides what each state
 * may do, and safety actions and existing obligations stay exactly as they are.
 */
export function CompanyVerificationBanner({ canManageCompany }: Props) {
  const [verification, setVerification] = React.useState<OwnCompanyVerification | null>(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [details, setDetails] = React.useState<Details | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [savingDetails, setSavingDetails] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [confirming, setConfirming] = React.useState(false);
  const [requesting, setRequesting] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const refresh = React.useCallback(async () => {
    try { setVerification(await getMyCompanyVerification()); }
    catch { /* No banner rather than a wrong one: the refused actions still explain themselves. */ }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => {
    const stop = onCompanyNotApproved((refused) => {
      setRefusal(companyNotApprovedMessage(refused));
      void refresh();
    });
    return () => { if (typeof stop === 'function') stop(); };
  }, [refresh]);

  const model = companyVerificationBanner(verification?.verificationStatus, verification?.verificationNote, canManageCompany);
  if (!model) return null;
  const tone = TONE[model.tone];

  const startEditing = async () => {
    setFeedback(null);
    try {
      const company = await getMyCompany();
      setDetails({ name: company.name ?? '', companyNumber: company.companyNumber ?? '', address: company.address ?? '', contactDetails: company.contactDetails ?? '' });
      setEditing(true);
    } catch (error) { setFeedback({ tone: 'error', text: formatApiErrorMessage(error, 'Your registration details could not be loaded.') }); }
  };
  const saveDetails = async () => {
    if (!details) return;
    const missing = (Object.entries(details) as Array<[keyof Details, string]>).find(([, value]) => !value.trim());
    if (missing) { setFeedback({ tone: 'error', text: 'Every registration detail is required.' }); return; }
    setSavingDetails(true); setFeedback(null);
    try {
      await updateMyCompany({ name: details.name.trim(), companyNumber: details.companyNumber.trim(), address: details.address.trim(), contactDetails: details.contactDetails.trim() });
      setEditing(false);
      setFeedback({ tone: 'success', text: verification?.verificationStatus === 'rejected' ? 'Registration details saved. Ask S4 to reconsider when you are ready.' : 'Registration details saved. S4 checks them when it verifies your company.' });
    } catch (error) { setFeedback({ tone: 'error', text: formatApiErrorMessage(error, 'Your registration details were not saved. Try again.') }); }
    finally { setSavingDetails(false); }
  };
  const reconsider = async () => {
    setRequesting(true); setFeedback(null);
    try {
      setVerification(await requestCompanyReconsideration(message));
      setMessage(''); setRefusal(null); setConfirming(false);
      setFeedback({ tone: 'success', text: 'S4 has been asked to reconsider. Your company is pending verification again.' });
    } catch (error) {
      setConfirming(false);
      setFeedback({ tone: 'error', text: formatApiErrorMessage(error, 'The request was not sent. Try again.') });
      void refresh();
    } finally { setRequesting(false); }
  };

  return (
    <View accessibilityRole="alert" accessibilityLabel={model.title}
      style={[styles.banner, { backgroundColor: tone.surface, borderColor: tone.border }]}>
      <Text style={[styles.title, { color: tone.ink }]}>{model.title}</Text>
      <Text style={styles.body}>{model.body}</Text>
      {model.reason ? (
        <View style={styles.reason}>
          <Text style={styles.reasonLabel}>{verification?.verificationStatus === 'suspended' ? 'Reason for suspension' : 'Reason given by S4'}</Text>
          <Text style={styles.body}>{model.reason}</Text>
        </View>
      ) : null}
      {model.points.map((point) => <Text key={point} style={styles.point}>• {point}</Text>)}
      {model.supportGuidance ? <Text style={styles.support}>{model.supportGuidance}</Text> : null}
      {refusal ? <Text accessibilityLiveRegion="polite" style={styles.refusal}>Last action refused: {refusal}</Text> : null}

      {feedback ? <Text accessibilityLiveRegion="polite" style={feedback.tone === 'success' ? styles.success : styles.error}>{feedback.text}</Text> : null}

      {model.canCorrectDetails && !editing ? (
        <View style={styles.actions}>
          <Button label="Review registration details" variant="secondary" size="sm" onPress={() => void startEditing()} />
        </View>
      ) : null}

      {editing && details ? (
        <View style={styles.form}>
          {([['name', 'Registered company name'], ['companyNumber', 'Company number'], ['address', 'Registered address'], ['contactDetails', 'Contact details']] as Array<[keyof Details, string]>).map(([key, label]) => (
            <View key={key}>
              <FormField label={label} required>
                <FieldInput accessibilityLabel={label} value={details[key]} onChangeText={(value: string) => setDetails((current) => (current ? { ...current, [key]: value } : current))} />
              </FormField>
            </View>
          ))}
          <View style={styles.actions}>
            <Button label="Cancel" variant="secondary" size="sm" onPress={() => setEditing(false)} disabled={savingDetails} />
            <Button label="Save details" size="sm" onPress={() => void saveDetails()} loading={savingDetails} />
          </View>
        </View>
      ) : null}

      {model.canRequestReconsideration ? (
        <View style={styles.form}>
          <FormField label="Message to S4 (optional)" helperText="Say what you corrected. S4 sees this with your request.">
            <FieldTextarea accessibilityLabel="Message to S4" value={message} onChangeText={setMessage} maxLength={VERIFICATION_REASON_MAX} minLines={2}
              placeholder="e.g. We corrected our company number to match Companies House." />
          </FormField>
          <View style={styles.actions}>
            <Button label="Ask S4 to reconsider" size="sm" onPress={() => { setFeedback(null); setConfirming(true); }} disabled={requesting} />
          </View>
        </View>
      ) : null}

      <ConfirmationDialog
        visible={confirming}
        onClose={() => { if (!requesting) setConfirming(false); }}
        onConfirm={() => void reconsider()}
        title="Ask S4 to reconsider?"
        message="Your company returns to pending verification and S4 reviews your registration details again. Make sure you have corrected them first."
        confirmLabel="Send request"
        loading={requesting}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.sm, marginBottom: spacing.lg },
  title: { ...typography.heading },
  body: { ...typography.body, color: colors.textPrimary },
  reason: { backgroundColor: colors.card, borderRadius: radii.md, padding: spacing.md, gap: 2 },
  reasonLabel: { ...typography.label, color: colors.textSecondary },
  point: { ...typography.body, color: colors.textPrimary },
  support: { ...typography.label, color: colors.textSecondary },
  refusal: { ...typography.label, color: colors.danger },
  success: { ...typography.label, color: colors.success },
  error: { ...typography.label, color: colors.danger },
  form: { backgroundColor: colors.card, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
