// S4-EM-01 — Emergencies first in Live Operations' Attention Now (and the Dashboard, which reads the same queue).
//
// Before this, Attention Now was ordered newest-first only, so a Guard's Emergency raised ten minutes ago sat below a
// newer missed Welfare Check or uncovered shift. Now every ACTIVE Emergency (a panic alert not yet resolved) comes
// first — the ones nobody has acknowledged yet ahead of the acknowledged ones — and everything else keeps its existing
// newest-first order. Nothing is added to or removed from the queue; only the order changes.

export type AttentionOrderItem = { category: string; status?: string | null; occurredAt: string };

export function isActiveEmergency(item: Pick<AttentionOrderItem, 'category' | 'status'>): boolean {
  return item.category === 'panic' && (item.status ?? '').toLowerCase() !== 'closed';
}

const rank = (item: AttentionOrderItem): number => {
  if (!isActiveEmergency(item)) return 0;
  return (item.status ?? '').toLowerCase() === 'acknowledged' ? 1 : 2;
};

/** Sort comparator: unacknowledged Emergencies, then acknowledged Emergencies, then everything else; newest first within each. */
export function compareAttentionItems(left: AttentionOrderItem, right: AttentionOrderItem): number {
  const byRank = rank(right) - rank(left);
  if (byRank !== 0) return byRank;
  return right.occurredAt.localeCompare(left.occurredAt);
}
