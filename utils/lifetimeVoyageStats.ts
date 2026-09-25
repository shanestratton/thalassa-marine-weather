import type { ShipLogEntry } from '../types';
import {
    careerTotalsFromSummaries,
    computePersonalRecords,
    isMaritimeVoyage,
    mergeSummariesWithLive,
    type VoyageSummary,
} from '../services/shiplog/VoyageSummary';
import { voyageElapsedMs } from './voyageTiming';

/** Archive is a filing choice, not a change to the skipper's sailed history. */
export function lifetimeVoyageStats(
    active: readonly VoyageSummary[],
    archived: readonly VoyageSummary[],
    residentEntries: ShipLogEntry[] = [],
) {
    const byId = new Map<string, VoyageSummary>();
    for (const summary of [...archived, ...active]) {
        const voyageId = summary.voyageId || 'default_voyage';
        const previous = byId.get(voyageId);
        // Active/archive snapshots can overlap during an accepted move. Use
        // one whole-voyage aggregate, never add the same trip twice. Prefer
        // the more complete snapshot; a same-size newer/active one wins ties.
        const prefer =
            !previous ||
            summary.entryCount > previous.entryCount ||
            (summary.entryCount === previous.entryCount && Date.parse(summary.endedAt) >= Date.parse(previous.endedAt));
        const chosen = prefer ? summary : (previous ?? summary);
        byId.set(voyageId, {
            ...chosen,
            voyageId,
            // A partial duplicate must not turn a plan/import into sea miles.
            isPlannedRoute: summary.isPlannedRoute || previous?.isPlannedRoute || false,
            isImported: summary.isImported || previous?.isImported || false,
        });
    }

    // Keep the existing conservative overlay: a live tail may extend time
    // and distance, but cannot reset a departure or replace cloud history.
    const summaries = mergeSummariesWithLive([...byId.values()], residentEntries)
        .filter((summary) => isMaritimeVoyage(summary) && summary.departedAt !== null)
        .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || a.voyageId.localeCompare(b.voyageId));
    const totals = summaries.reduce(
        (sum, summary) => ({
            totalNm: sum.totalNm + (summary.totalDistanceNM || 0),
            totalMs: sum.totalMs + voyageElapsedMs(summary),
            voyageCount: sum.voyageCount + 1,
        }),
        { totalNm: 0, totalMs: 0, voyageCount: 0 },
    );
    return {
        summaries,
        totals,
        records: computePersonalRecords(summaries),
        careerTotals: careerTotalsFromSummaries(summaries),
        entryCount: summaries.reduce((sum, summary) => sum + summary.entryCount, 0),
    };
}

export type LifetimeVoyageStats = ReturnType<typeof lifetimeVoyageStats>;
