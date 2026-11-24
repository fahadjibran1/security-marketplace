// Guard live-shift action forms — presentation contract. (Phase 2 layout, Phase 3C vocabulary.)
//
// The operational actions a Guard can raise during a live shift each had their own hand-rolled overlay in
// GuardDashboardScreen, and each overlay reproduced the same layout defect that hid Submit behind the
// bottom navigation and the keyboard. They now all render through AppModal, and this module holds the
// per-action copy and the submit-button state so both are executed by tests rather than only read.
//
// PHASE 3C — ONE ACTION MODEL
// Phase 2 deliberately kept the old labels character for character, so that a layout fix and a rename
// could not be confused for one another. The rename is now done, and the duplication with it.
//
// What a Guard saw before: Add Log, Check Call, Incident, Welfare, Panic in one grid, plus a second
// "On-shift reporting" block offering Report incident and Record check call AGAIN, plus copy explaining
// that the same form was also available somewhere else. Two of the five actions had two launchers, the
// grid labelled them LOG / CALL / INC / CARE, and Check Call and Welfare were two names for what a guard
// understands as one thing.
//
// The canonical set is now: WELFARE CHECK, LOG BOOK, SITE REQUEST, INCIDENT, EMERGENCY — and Book Off,
// which stays where it is, as the shift card's own control, well away from routine reporting.
//
// EMERGENCY IS TWO TAPS, NOT A TYPED WORD (S4-EM-01, owner decision 24 Nov 2026)
// The alert is still SafetyAlertType.PANIC on the wire. Typing SOS under real duress, one-handed, was the
// wrong safeguard: it is replaced by a full-screen confirmation (components/guard/emergency) — the
// Emergency launcher, then one large SEND EMERGENCY button with a separate Cancel. Nothing is typed and no
// description is required. The pocket-press safeguard is the second, deliberate tap on a dedicated screen.

export type GuardActionKey = 'welfareCheck' | 'logBook' | 'siteRequest' | 'incident' | 'emergency';

export type GuardActionForm = {
  key: GuardActionKey;
  /** Modal title. Also the name on the launcher, so a Guard sees one word for one action. */
  title: string;
  /** Helper line above the input, where the form has one. */
  helperText?: string;
  placeholder: string;
  /** Label on the primary button when idle. */
  submitLabel: string;
  /** Label while the submission is in flight. */
  busyLabel: string;
  /** A free-text operational note, so the input is multiline and grows. */
  multiline: boolean;
  /**
   * False for an action that needs no words (Emergency): its button is ready as soon as a live shift exists. Every
   * other action needs a non-empty note.
   */
  requiresText?: boolean;
  /** Destructive styling for the primary action. */
  destructive?: boolean;
  /** Accessibility label on the launcher control. */
  launchAccessibilityLabel: string;
};

export const GUARD_ACTION_FORMS: readonly GuardActionForm[] = [
  {
    key: 'welfareCheck',
    title: 'Welfare Check',
    placeholder: 'Short welfare update',
    submitLabel: 'Record Welfare Check',
    busyLabel: 'Saving...',
    multiline: true,
    launchAccessibilityLabel: 'Record Welfare Check',
  },
  {
    key: 'logBook',
    title: 'Log Book',
    // The boundary between the four written actions, stated once where the Guard is deciding.
    helperText: 'A routine record of what you did or saw. Nothing needs action.',
    placeholder: 'Write a Log Book entry',
    submitLabel: 'Save Log Book Entry',
    busyLabel: 'Saving...',
    multiline: true,
    launchAccessibilityLabel: 'Add Log Book entry',
  },
  {
    key: 'siteRequest',
    // Non-emergency: something the site needs. Fuel, log books, equipment, welfare supplies, access,
    // lighting. The placeholder carries the examples so the form needs no explanatory paragraph.
    title: 'Site Request',
    helperText: 'Something the site needs. Control will arrange it.',
    placeholder: 'What does the site need? Fuel, log books, equipment, access, lighting',
    submitLabel: 'Send Site Request',
    busyLabel: 'Sending...',
    multiline: true,
    launchAccessibilityLabel: 'Raise Site Request',
  },
  {
    key: 'incident',
    title: 'Incident',
    helperText: 'Something happened that needs reporting and follow-up.',
    placeholder: 'Short incident description',
    submitLabel: 'Submit Incident',
    busyLabel: 'Submitting...',
    multiline: true,
    launchAccessibilityLabel: 'Report Incident',
  },
  {
    key: 'emergency',
    title: 'Emergency',
    helperText: 'Send an Emergency alert to your company?',
    placeholder: '',
    submitLabel: 'SEND EMERGENCY',
    busyLabel: 'Sending...',
    multiline: false,
    requiresText: false,
    destructive: true,
    launchAccessibilityLabel: 'Send Emergency alert',
  },
] as const;

export function guardActionForm(key: GuardActionKey): GuardActionForm {
  const found = GUARD_ACTION_FORMS.find((form) => form.key === key);
  if (!found) throw new Error(`Unknown guard action form: ${key}`);
  return found;
}

export type ActionSubmitState = {
  /** Whether the primary button is disabled. */
  disabled: boolean;
  /** The label to show right now. */
  label: string;
  /** Why it is disabled, for the test and for an accessibility hint. Null when enabled. */
  blockedReason: 'busy' | 'empty' | null;
};

/**
 * The primary button's state for one render.
 *
 * DELIBERATELY MIRRORS THE DISPATCHER, IT DOES NOT REPLACE IT. `dispatchGuardAction` already refuses an
 * empty note (Emergency excepted: it needs no words) — that check stays where it is, because it is what
 * actually protects the request. Reflecting them in the button is a
 * usability change only: a button that is visibly not ready is better than one that looks ready and
 * quietly refuses.
 *
 * `busy` wins over everything, which is the double-tap protection: while a submission is in flight the
 * button is disabled, so a second tap cannot start a second request.
 */
export function resolveActionSubmitState(
  form: GuardActionForm,
  { value, busy }: { value: string; busy: boolean },
): ActionSubmitState {
  if (busy) {
    return { disabled: true, label: form.busyLabel, blockedReason: 'busy' };
  }

  const trimmed = (value ?? '').trim();

  if (form.requiresText === false) {
    return { disabled: false, label: form.submitLabel, blockedReason: null };
  }

  return {
    disabled: trimmed.length === 0,
    label: form.submitLabel,
    blockedReason: trimmed.length === 0 ? 'empty' : null,
  };
}
