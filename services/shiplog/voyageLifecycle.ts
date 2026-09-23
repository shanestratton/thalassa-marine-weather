import type { TrackingState } from './TrackingStateStore';

/** Preserve capture status; only a fresh departure is allowed to attempt its marker. */
export function departureCaptureState(
    previous: TrackingState,
    voyageId: string,
    freshDeparture: boolean,
): TrackingState['voyageStartCapture'] {
    if (previous.currentVoyageId === voyageId && previous.voyageStartCapture) {
        return previous.voyageStartCapture;
    }
    return freshDeparture ? 'pending' : undefined;
}

/**
 * Same departure across retries, WebViews and devices. The queue
 * and database already deduplicate these operation IDs within the owner scope.
 */
export function voyageLifecycleOperationId(voyageId: string, label: string): string | undefined {
    // Each explicit stop remains a separate End: a voyage may be continued
    // afterwards, and its final End must retain the eventual arrival position.
    if (label !== 'Voyage Start') return undefined;
    // App-generated voyage IDs fit directly, preserving their full identity.
    if (/^[A-Za-z0-9_-]{1,100}$/.test(voyageId)) return `lifecycle_start_id_${voyageId}`;
    // Legacy/import IDs can contain arbitrary text. Match the stable-import
    // ID strategy without requiring asynchronous WebCrypto on the GPS path.
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let offset = 0; offset < voyageId.length; offset++) {
        const code = voyageId.charCodeAt(offset);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ (code + offset), 0x85ebca6b) >>> 0;
    }
    return `lifecycle_start_hash_${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}
