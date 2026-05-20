/**
 * voyageStats — predicates for distinguishing actually-sailed voyages
 * from suggested/planned routes when aggregating Ship's Log stats.
 *
 * Planned/suggested routes are persisted as ship-log entries with
 * `source='planned_route'` (see services/shiplog/PassagePlanSave). They
 * must STILL appear as cards in the log list, but must NOT count toward
 * sailed-mileage totals (distance / time at sea / voyage count). Mixing
 * them in inflated every stat surface — fixed 2026-05-20.
 *
 * Kept as named, decoupled predicates (minimal entry shape, no
 * ShipLogEntry import) so the "planned routes don't count as sailed
 * miles" invariant is testable and can't silently drift across the
 * several surfaces that need it (top gauge tiles, Stats sheet, detail
 * view, voyage-card sort).
 */

/** Minimal shape needed to classify a voyage group. */
export interface SourcedGroup {
    entries: { source?: string | null }[];
}

/**
 * True when a voyage group is a SUGGESTED/PLANNED route rather than an
 * actually-sailed track — i.e. any of its entries carry
 * source='planned_route'.
 */
export function isPlannedRouteGroup(group: SourcedGroup): boolean {
    return group.entries.some((e) => e?.source === 'planned_route');
}

/**
 * Drop suggested/planned-route groups, keeping only sailed voyages.
 * Used wherever stats are aggregated.
 */
export function excludeSuggestedRoutes<T extends SourcedGroup>(groups: T[]): T[] {
    return groups.filter((g) => !isPlannedRouteGroup(g));
}
