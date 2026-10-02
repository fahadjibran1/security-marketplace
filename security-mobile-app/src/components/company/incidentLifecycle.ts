// An incident's lifecycle, and what Control may do at each point of it. (UAT FIX 03.)
//
// AN INCIDENT IS NOT A SAFETY ALERT. They are different tables, different endpoints and different
// lifecycles, and the control room had been offered an "Acknowledge" button on incidents that could
// only ever call the SafetyAlert path. The two vocabularies are kept apart here:
//
//   safety alert   open → acknowledged → closed
//   incident       open → in_review    → resolved → closed
//
// So an incident is never "acknowledged". The transition that actually exists is `open → in_review`,
// the API persists `reviewedAt`/`reviewedByUserId` for it, and the button therefore says what it
// does: "Mark In Review".

/** The lifecycle points the API can return. `unknown` keeps an unrecognised value harmless. */
export type IncidentLifecycle = 'open' | 'in_review' | 'resolved' | 'closed' | 'unknown';

export function incidentLifecycle(status: string | null | undefined): IncidentLifecycle {
  switch ((status || '').trim().toLowerCase()) {
    case 'open':
      return 'open';
    case 'in_review':
      return 'in_review';
    case 'resolved':
      return 'resolved';
    case 'closed':
      return 'closed';
    default:
      return 'unknown';
  }
}

/**
 * The lifecycle word shown on screen.
 *
 * Deliberately never "Acknowledged": that word belongs to safety alerts, and using it here would
 * describe a transition this record does not have.
 */
export function incidentLifecycleLabel(status: string | null | undefined): string {
  switch (incidentLifecycle(status)) {
    case 'open':
      return 'Open';
    case 'in_review':
      return 'In Review';
    case 'resolved':
      return 'Resolved';
    case 'closed':
      return 'Closed';
    default:
      return 'Unknown';
  }
}

/** Whether the incident is finished with — nothing left for the Attention queue to ask of it. */
export function incidentIsSettled(status: string | null | undefined): boolean {
  const lifecycle = incidentLifecycle(status);
  return lifecycle === 'resolved' || lifecycle === 'closed';
}

export type IncidentAttentionActions = {
  /** Whether [Mark In Review] is offered: only from `open`, the only state it can move out of. */
  canMarkInReview: boolean;
  /**
   * The label of the resolving action, or null when there is nothing to resolve.
   *
   * "View & Resolve" while open, because Control has not read the report yet and the dialog opens on
   * the facts; a plain "Resolve" once it is in review, because they already have.
   */
  resolveLabel: string | null;
  /** The lifecycle word to show beside the item, or null when "Open" needs no stating. */
  stateLabel: string | null;
};

/**
 * What the Attention Now queue offers for an incident at this point of its lifecycle.
 *
 *   open       [Mark In Review]  [View & Resolve]
 *   in_review  "In Review"       [Resolve]
 *   settled    — (the item is not in the queue at all)
 *
 * An unrecognised status is treated as open rather than hidden: a controller can still act on it,
 * which is safer than an incident that silently cannot be worked.
 */
export function incidentAttentionActions(status: string | null | undefined): IncidentAttentionActions {
  const lifecycle = incidentLifecycle(status);
  if (lifecycle === 'in_review') {
    return { canMarkInReview: false, resolveLabel: 'Resolve', stateLabel: 'In Review' };
  }
  if (lifecycle === 'resolved' || lifecycle === 'closed') {
    return { canMarkInReview: false, resolveLabel: null, stateLabel: incidentLifecycleLabel(status) };
  }
  return { canMarkInReview: true, resolveLabel: 'View & Resolve', stateLabel: null };
}

/** The severity word, title-cased for display. The stored value is untouched. */
export function incidentSeverityLabel(severity: string | null | undefined): string {
  const value = (severity || '').trim().toLowerCase();
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The category word for display: `health_safety` reads "Health safety", not as stored. */
export function incidentCategoryLabel(category: string | null | undefined): string {
  const value = (category || '').trim().toLowerCase().replace(/_/g, ' ');
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}
