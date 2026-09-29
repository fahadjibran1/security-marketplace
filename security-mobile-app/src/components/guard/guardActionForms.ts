// Guard live-shift action forms — presentation contract. (Phase 2, P0.)
//
// The five operational actions a Guard can raise during a live shift each had their own hand-rolled
// overlay in GuardDashboardScreen, and each overlay reproduced the same layout defect that hid Submit
// behind the bottom navigation and the keyboard. They now all render through AppModal, and this module
// holds the per-action copy and the submit-button state so both are executed by tests rather than only
// read.
//
// SCOPE DISCIPLINE
// The titles and labels below are the CURRENT ones, character for character. Phase 5 will rationalise the
// vocabulary (Welfare Check / Log Book / Site Request / Incident / Emergency / Book Off); renaming here
// would have meant changing behaviour and layout in one step, which makes a regression impossible to
// attribute. Nothing in this file changes what is submitted or where.

export type GuardActionKey = 'log' | 'checkCall' | 'incident' | 'welfare' | 'panic';

export type GuardActionForm = {
  key: GuardActionKey;
  /** Modal title, unchanged from the pre-Phase-2 overlay. */
  title: string;
  /** Helper line above the input, where the current form has one. */
  helperText?: string;
  placeholder: string;
  /** Label on the primary button when idle. */
  submitLabel: string;
  /** Label while the existing submission handler is in flight. */
  busyLabel: string;
  /** A free-text operational note, so the input is multiline and grows. */
  multiline: boolean;
  /**
   * Set for an action that requires the guard to type a word to confirm. The submission handler checks
   * this itself; it is repeated here so the button can reflect it instead of looking enabled and then
   * failing with a toast.
   */
  confirmWord?: string;
  /** Destructive styling for the primary action. */
  destructive?: boolean;
  /** Accessibility label on the launcher control. */
  launchAccessibilityLabel: string;
};

export const GUARD_ACTION_FORMS: readonly GuardActionForm[] = [
  {
    key: 'log',
    title: 'Add Log',
    placeholder: 'Write a short operational update',
    submitLabel: 'Submit Log',
    busyLabel: 'Saving...',
    multiline: true,
    launchAccessibilityLabel: 'Add log',
  },
  {
    key: 'checkCall',
    title: 'Check Call',
    placeholder: 'Short check call update',
    submitLabel: 'Record Check Call',
    busyLabel: 'Saving...',
    multiline: true,
    launchAccessibilityLabel: 'Record check call',
  },
  {
    key: 'incident',
    title: 'Incident',
    placeholder: 'Short incident description',
    submitLabel: 'Submit Incident',
    busyLabel: 'Submitting...',
    multiline: true,
    launchAccessibilityLabel: 'Report incident',
  },
  {
    key: 'welfare',
    title: 'Welfare',
    placeholder: 'Quick welfare update',
    submitLabel: 'Send Welfare Update',
    busyLabel: 'Sending...',
    multiline: true,
    launchAccessibilityLabel: 'Welfare check',
  },
  {
    key: 'panic',
    title: 'Panic',
    helperText: 'Type PANIC to confirm you want to send an emergency alert.',
    placeholder: 'Type PANIC',
    submitLabel: 'Confirm Panic Alert',
    busyLabel: 'Sending...',
    multiline: false,
    confirmWord: 'PANIC',
    destructive: true,
    launchAccessibilityLabel: 'Panic alert',
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
  blockedReason: 'busy' | 'empty' | 'confirmation' | null;
};

/**
 * The primary button's state for one render.
 *
 * DELIBERATELY MIRRORS THE HANDLERS, IT DOES NOT REPLACE THEM. Each submission handler already refuses
 * an empty note, and the panic handler already refuses anything but the word PANIC — those checks stay
 * exactly where they are, because they are what actually protects the request. Reflecting them in the
 * button is a usability change only: on a small screen a toast can appear behind the keyboard, so a
 * button that is visibly not ready is better than one that looks ready and quietly refuses.
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

  if (form.confirmWord) {
    const matches = trimmed.toUpperCase() === form.confirmWord.toUpperCase();
    return {
      disabled: !matches,
      label: form.submitLabel,
      blockedReason: matches ? null : 'confirmation',
    };
  }

  return {
    disabled: trimmed.length === 0,
    label: form.submitLabel,
    blockedReason: trimmed.length === 0 ? 'empty' : null,
  };
}
