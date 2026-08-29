/**
 * The saved-routes running order — passages first, their legs beneath them,
 * day sails after; groups newest first.
 *
 * Shane 2026-08-27: "passage first. then the first leg, then the second leg.
 * then the day sail." Pulled out of components/crew/SavedRoutePicker so the
 * PLAN tab's saved-routes modal and the cast-off "Following a route?" sheet
 * can show the same order without a second implementation — three lists that
 * sort routes three ways is how a skipper stops trusting any of them.
 *
 * Pure, so the ordering can be tested without mounting a sheet.
 */

export interface SavedRoutePickerRow {
    id: string;
    name: string;
    /** Trailing "(2nd Leg)" paint. Rendered OUTSIDE the truncating name span
     *  so a long route name can never eat the badge on a narrow screen. */
    legBadge?: string;
    /** Secondary line — distance / legs / shared-by. */
    detail: string | null;
    kind: 'passage' | 'leg' | 'standalone';
    /** 1-based within its trip; orders legs under their passage. */
    legOrdinal?: number;
    /** Group identity — a trip id for passage/leg rows, own id otherwise. */
    groupKey: string;
    /** Newest activity in the group decides group order (ms epoch). */
    stamp: number;
}

const kindRank = (kind: SavedRoutePickerRow['kind']): number => (kind === 'passage' ? 0 : kind === 'leg' ? 1 : 2);

/**
 * Groups ordered by their newest member, rows within a group ordered
 * passage → legs (by ordinal) → standalone.
 *
 * The groupKey tiebreak is deliberate: two groups sharing a stamp would
 * otherwise sort unstably and the list would reshuffle between renders under
 * the skipper's thumb.
 */
/** The minimum a row must carry to be ordered. Generic so each surface can
 *  sort ITS OWN item type — the PLAN library's picker items, the cast-off
 *  sheet's route summaries — without first converting to a common shape and
 *  back again. */
export interface SavedRouteOrderable {
    kind: SavedRoutePickerRow['kind'];
    groupKey: string;
    legOrdinal?: number;
    stamp: number;
}

export function orderSavedRouteRows<T extends SavedRouteOrderable>(rows: T[]): T[] {
    const groupStamp = new Map<string, number>();
    for (const row of rows) {
        groupStamp.set(row.groupKey, Math.max(groupStamp.get(row.groupKey) ?? 0, row.stamp));
    }
    return [...rows].sort((a, b) => {
        if (a.groupKey !== b.groupKey) {
            const byStamp = (groupStamp.get(b.groupKey) ?? 0) - (groupStamp.get(a.groupKey) ?? 0);
            if (byStamp !== 0) return byStamp;
            return a.groupKey.localeCompare(b.groupKey);
        }
        const byKind = kindRank(a.kind) - kindRank(b.kind);
        if (byKind !== 0) return byKind;
        return (a.legOrdinal ?? 0) - (b.legOrdinal ?? 0);
    });
}

/**
 * A leg with no passage heading above it is a dangling arrow — the reviewer's
 * finding on the first draft of the tracer adapter. Any row whose group has no
 * 'passage' row is demoted to 'standalone' so it renders with its own pin
 * rather than pointing at nothing.
 */
export function demoteOrphanLegs<T extends SavedRouteOrderable>(rows: T[]): T[] {
    const hasPassage = new Set<string>();
    for (const row of rows) if (row.kind === 'passage') hasPassage.add(row.groupKey);
    return rows.map((row) =>
        row.kind === 'leg' && !hasPassage.has(row.groupKey) ? { ...row, kind: 'standalone' as const } : row,
    );
}
