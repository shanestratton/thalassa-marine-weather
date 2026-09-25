import type { ShipLogEntry } from '../../types';

// Queue operations retain their identity when uploaded, even though their
// database row id changes. Never deduplicate by position or timestamp: two
// different captures may carry different movement or user-authored evidence.
function captureKey(entry: ShipLogEntry): string {
    const operation = entry.clientOperationId ?? (entry.id.startsWith('offline_') ? entry.id.slice(8) : undefined);
    return operation ? `operation:${operation}` : `row:${entry.id}`;
}

function safetyEvidence(entry: ShipLogEntry): string {
    return JSON.stringify([
        entry.userId,
        entry.voyageId,
        Date.parse(entry.timestamp),
        entry.latitude,
        entry.longitude,
        entry.positionFormatted,
        entry.distanceNM,
        entry.cumulativeDistanceNM,
        entry.speedKts,
        entry.courseDeg,
        entry.entryType,
        entry.waypointName,
        entry.source ?? 'device',
        entry.notes,
        entry.eventCategory,
        entry.linkedPlanId,
        entry.savedRouteId,
        entry.isOnWater,
    ]);
}

/**
 * Union two complete local-queue snapshots bracketing a STRICT complete cloud
 * read. This preserves rows uploaded/removed from the queue during the read.
 * Conflicting copies mean the evidence changed: retain the voyage and retry.
 * This helper does not itself establish completeness or permission to delete.
 */
export function mergeCompleteRecordingEvidence(
    ...snapshots: readonly (readonly ShipLogEntry[])[]
): ShipLogEntry[] | null {
    const captures = new Map<string, ShipLogEntry>();
    for (const snapshot of snapshots) {
        const snapshotKeys = new Set<string>();
        for (const entry of snapshot) {
            if (!entry.id?.trim()) return null;
            const key = captureKey(entry);
            if (snapshotKeys.has(key)) return null;
            snapshotKeys.add(key);
            const previous = captures.get(key);
            if (previous && safetyEvidence(previous) !== safetyEvidence(entry)) return null;
            if (!previous) captures.set(key, entry);
            if (captures.size >= 10_000) return null;
        }
    }
    return [...captures.values()];
}
