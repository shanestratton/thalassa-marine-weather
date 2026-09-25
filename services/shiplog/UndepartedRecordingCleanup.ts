import type { ShipLogEntry } from '../../types';
import type { VoyageSummary } from './VoyageSummary';
import { isUndepartedRecording } from './undepartedRecording';

/** Summaries nominate work only. They can never authorize deletion. */
export function isUndepartedCandidate(summary: VoyageSummary): boolean {
    return (
        /^voyage_\d{13}(?:_[a-z0-9]+)?$/.test(summary.voyageId) &&
        !summary.hasManual &&
        !summary.isPlannedRoute &&
        !summary.isImported &&
        !summary.departedAt &&
        !summary.passageGroupId &&
        summary.entryCount >= 4 &&
        summary.entryCount < 10_000 &&
        Number.isFinite(summary.totalDistanceNM) &&
        summary.totalDistanceNM <= 0.01 &&
        Number.isFinite(summary.avgSpeedKts) &&
        summary.avgSpeedKts < 0.8 &&
        // Older cloud summaries include the generated (0,0) acquiring-GPS
        // Start marker in their footprint. It may nominate a full read, but
        // only the exact placeholder signature can pass the row-level proof.
        (summary.spanM == null || summary.spanM <= 30 || (summary.firstLat === 0 && summary.firstLon === 0))
    );
}

export interface UndepartedCleanupContext {
    ownerId: string;
    /** Must also reject a new start/resume during any pending read/delete. */
    isCurrent: () => boolean;
    /** Reject active/paused recordings, uncertain persistence and capture handoffs. */
    isIdle: (voyageId: string) => Promise<boolean>;
    /** null means failed/incomplete. Never use a cached or resident tail here. */
    readComplete: (voyageId: string) => Promise<ShipLogEntry[] | null>;
    remove: (voyageId: string, canDelete: () => boolean) => Promise<boolean>;
}

/** Bounded, fail-closed maintenance of ended casual recordings only. */
export async function cleanupUndepartedRecordings(
    summaries: readonly VoyageSummary[],
    context: UndepartedCleanupContext,
): Promise<string[]> {
    const removed: string[] = [];
    for (const summary of summaries.filter(isUndepartedCandidate).slice(0, 3)) {
        if (!context.isCurrent()) break;
        try {
            if (!(await context.isIdle(summary.voyageId)) || !context.isCurrent()) continue;
            const entries = await context.readComplete(summary.voyageId);
            // A current full read must cover the summary that nominated it.
            // A shrinking/failed/partially synced read is not proof of no trip.
            if (!context.isCurrent() || !entries || entries.length < summary.entryCount) continue;
            const startedAt = Date.parse(summary.startedAt);
            const endedAt = Date.parse(summary.endedAt);
            if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || startedAt > endedAt) continue;
            const times = entries.map((entry) => Date.parse(entry.timestamp));
            if (Math.min(...times) > startedAt || Math.max(...times) < endedAt) continue;
            if (!isUndepartedRecording(entries, summary.voyageId, context.ownerId)) continue;
            if (!(await context.isIdle(summary.voyageId)) || !context.isCurrent()) continue;
            if (await context.remove(summary.voyageId, context.isCurrent)) removed.push(summary.voyageId);
        } catch {
            // Bad connectivity/storage keeps the track; retry on a later visit.
        }
    }
    return removed;
}
